use chrono::{Datelike, Duration, Local, TimeZone, Timelike};
use fs2::FileExt;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fs::{File, OpenOptions, remove_file};
use std::io::{Read, Seek, SeekFrom, Write};
use std::thread;
use std::time::Duration as StdDuration;

const STATE_LOCK_RETRIES: usize = 40;
const STATE_LOCK_RETRY_DELAY_MS: u64 = 25;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum EngineState {
    Idle,
    Staked,
    AwaitingProof,
    Evaluated,
    FailLocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SystemState {
    user_id: String,
    current_state: EngineState,
    daily_stake: String,
    stake_timestamp: Option<String>,
    deadline_timestamp: Option<String>,
    compressed_history_summary: String,
    #[serde(default = "default_morning_interrupt_hour")]
    morning_interrupt_hour_local: u8,
    #[serde(default)]
    daily_briefing_data: DailyBriefingData,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DailyBriefingData {
    fetched_at: Option<String>,
    raw_agenda_summary: String,
    breaking_news_headlines: Vec<String>,
}

fn default_morning_interrupt_hour() -> u8 {
    8
}

#[derive(Debug, Serialize)]
struct DaemonEvent<'a> {
    event: &'a str,
    message: &'a str,
    state: EngineState,
    timestamp: String,
}

struct StateLockGuard {
    path: String,
    _file: File,
}

impl Drop for StateLockGuard {
    fn drop(&mut self) {
        let _ = remove_file(&self.path);
    }
}

fn default_state() -> SystemState {
    SystemState {
        user_id: "will_oak_wild".to_owned(),
        current_state: EngineState::Idle,
        daily_stake: String::new(),
        stake_timestamp: None,
        deadline_timestamp: None,
        compressed_history_summary:
            "User prefers high-intensity, practical feedback. No participation trophies.".to_owned(),
        morning_interrupt_hour_local: 8,
        daily_briefing_data: DailyBriefingData {
            fetched_at: None,
            raw_agenda_summary: String::new(),
            breaking_news_headlines: Vec::new(),
        },
    }
}

fn parse_local_timestamp(value: &str) -> Option<chrono::DateTime<Local>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Local))
}

fn acquire_state_lock(state_path: &str) -> Result<StateLockGuard, Box<dyn Error>> {
    let lock_path = format!("{state_path}.lock");

    for attempt in 0..STATE_LOCK_RETRIES {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                writeln!(file, "{}", std::process::id())?;
                file.flush()?;
                return Ok(StateLockGuard {
                    path: lock_path,
                    _file: file,
                });
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    && attempt + 1 < STATE_LOCK_RETRIES =>
            {
                thread::sleep(StdDuration::from_millis(STATE_LOCK_RETRY_DELAY_MS));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(format!("timed out acquiring state lock at {lock_path}").into());
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(format!("timed out acquiring state lock at {lock_path}").into())
}

fn load_state(state_path: &str) -> Result<SystemState, Box<dyn Error>> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(state_path)?;
    file.lock_exclusive()?;

    let mut raw = String::new();
    file.read_to_string(&mut raw)?;

    let state = if raw.trim().is_empty() {
        let initial = default_state();
        let serialized = serde_json::to_string_pretty(&initial)?;
        file.seek(SeekFrom::Start(0))?;
        file.set_len(0)?;
        file.write_all(serialized.as_bytes())?;
        file.flush()?;
        initial
    } else {
        serde_json::from_str::<SystemState>(&raw)?
    };

    file.unlock()?;
    Ok(state)
}

fn save_state(state_path: &str, state: &SystemState) -> Result<(), Box<dyn Error>> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(state_path)?;
    file.lock_exclusive()?;

    let serialized = serde_json::to_string_pretty(state)?;
    file.seek(SeekFrom::Start(0))?;
    file.set_len(0)?;
    file.write_all(serialized.as_bytes())?;
    file.flush()?;

    file.unlock()?;
    Ok(())
}

fn post_daemon_event(
    client: &Client,
    webhook_url: &str,
    event: &str,
    message: &str,
    state: EngineState,
) -> Result<(), Box<dyn Error>> {
    let payload = DaemonEvent {
        event,
        message,
        state,
        timestamp: Local::now().to_rfc3339(),
    };

    client.post(webhook_url).json(&payload).send()?.error_for_status()?;
    Ok(())
}

fn apply_offline_briefing_fallback(state_path: &str) -> Result<(), Box<dyn Error>> {
    let state_lock = acquire_state_lock(state_path)?;
    let mut state = load_state(state_path)?;

    if state.daily_briefing_data.fetched_at.is_none() {
        state.daily_briefing_data.fetched_at = Some(Local::now().to_rfc3339());
    }

    if state.daily_briefing_data.raw_agenda_summary.trim().is_empty() {
        state.daily_briefing_data.raw_agenda_summary =
            "Offline fallback: reuse stale agenda context and proceed with state execution."
                .to_owned();
    }

    if state.daily_briefing_data.breaking_news_headlines.is_empty() {
        state.daily_briefing_data.breaking_news_headlines = vec![
            "Offline fallback: stale briefing mode enabled while network recovers.".to_owned(),
        ];
    }

    save_state(state_path, &state)?;
    drop(state_lock);
    Ok(())
}

fn fetch_daily_briefing(
    client: &Client,
    briefing_url: &str,
    state_path: &str,
) -> Result<(), Box<dyn Error>> {
    match client
        .post(briefing_url)
        .timeout(StdDuration::from_secs(5))
        .send()
    {
        Ok(response) => match response.error_for_status() {
            Ok(_) => Ok(()),
            Err(error) => {
                eprintln!("briefing network call failed; using stale fallback: {error}");
                apply_offline_briefing_fallback(state_path)
            }
        },
        Err(error) => {
            eprintln!("briefing network call failed; using stale fallback: {error}");
            apply_offline_briefing_fallback(state_path)
        }
    }
}

fn default_evening_deadline(now: chrono::DateTime<Local>) -> Option<String> {
    Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 18, 0, 0)
        .single()
        .map(|dt| dt.to_rfc3339())
}

fn has_today_timestamp(timestamp: &Option<String>, now: chrono::DateTime<Local>) -> bool {
    timestamp
        .as_deref()
        .and_then(parse_local_timestamp)
        .map(|dt| dt.date_naive() == now.date_naive())
        .unwrap_or(false)
}

fn main() {
    let state_path = std::env::var("STATE_FILE").unwrap_or_else(|_| "./state.json".to_owned());
    let webhook_url = std::env::var("DAEMON_WEBHOOK_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3000/api/webhook/daemon".to_owned());
    let briefing_url = std::env::var("BRIEFING_FETCH_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3000/api/engine/fetch-briefing".to_owned());

    let client = Client::new();
    let poll_interval = StdDuration::from_secs(10);

    loop {
        let now = Local::now();
        let state_lock = match acquire_state_lock(&state_path) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("state lock failed: {error}");
                thread::sleep(poll_interval);
                continue;
            }
        };

        let mut state = match load_state(&state_path) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("state load failed: {error}");
                thread::sleep(poll_interval);
                continue;
            }
        };

        let mut events: Vec<(String, String)> = Vec::new();
        let mut should_fetch_morning_briefing = false;

        let morning_hour = u32::from(state.morning_interrupt_hour_local);
        if now.hour() >= morning_hour
            && state.current_state == EngineState::Idle
            && !has_today_timestamp(&state.stake_timestamp, now)
        {
            state.current_state = EngineState::Staked;
            state.stake_timestamp = Some(now.to_rfc3339());
            state.deadline_timestamp = default_evening_deadline(now);
            should_fetch_morning_briefing = true;
            let meridiem = if morning_hour >= 12 { "PM" } else { "AM" };
            let display_hour = match morning_hour % 12 {
                0 => 12,
                hour => hour,
            };
            let morning_message =
                format!("{display_hour}:00 {meridiem} check-in required. Set today stake now.");
            events.push(("MORNING_CHECKIN".to_owned(), morning_message));
        }

        if now.hour() >= 18 && state.current_state == EngineState::Staked {
            state.current_state = EngineState::AwaitingProof;
            if state.deadline_timestamp.is_none() {
                state.deadline_timestamp = Some((now + Duration::hours(2)).to_rfc3339());
            }
            events.push((
                "PROOF_REQUEST".to_owned(),
                "18:00 proof window open. Submit proof now.".to_owned(),
            ));
        }

        if state.current_state == EngineState::AwaitingProof {
            if let Some(deadline_timestamp) = &state.deadline_timestamp {
                if let Some(deadline) = parse_local_timestamp(deadline_timestamp) {
                    if now > deadline {
                        state.current_state = EngineState::FailLocked;
                        events.push((
                            "FAIL_LOCKED".to_owned(),
                            "Deadline missed. State locked to FAIL_LOCKED.".to_owned(),
                        ));
                    }
                }
            }
        }

        if !events.is_empty() {
            if let Err(error) = save_state(&state_path, &state) {
                eprintln!("state save failed: {error}");
                thread::sleep(poll_interval);
                continue;
            }
        }

        drop(state_lock);

        if !events.is_empty() {
            if should_fetch_morning_briefing {
                if let Err(error) = fetch_daily_briefing(&client, &briefing_url, &state_path) {
                    eprintln!("briefing fetch failed: {error}");
                }
            }

            for (event, message) in events {
                if let Err(error) = post_daemon_event(
                    &client,
                    &webhook_url,
                    event.as_str(),
                    message.as_str(),
                    state.current_state,
                ) {
                    eprintln!("daemon webhook failed for {event}: {error}");
                }
            }
        }

        thread::sleep(poll_interval);
    }
}
