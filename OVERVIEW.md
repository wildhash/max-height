# max-height — Deep-Dive Overview

## What Is max-height?

**max-height** is a personal accountability system built for one user (`will_oak_wild`). The core idea is simple but ruthless: every day you declare a stake (a commitment to complete a specific output), and the system holds you to it using a timed state machine. Miss your deadline, get locked out. Prove your work, get evaluated by AI. Dodge with excuses, get called out instantly.

It is **not** a productivity app with dashboards and streaks. It is closer to a daemon that watches you — always running, always polling, zero tolerance for sycophancy.

---

## High-Level Goal

The project solves a precise problem: self-imposed accountability fails because the person who sets the rule is also the person who bends it. max-height removes that escape hatch by:

1. **Automating the check-in trigger** — a background daemon fires the morning prompt at a configurable hour, not when you remember to open an app.
2. **Injecting real-world context** — before the morning message is generated, live tech/macro news headlines and a calendar/email agenda summary are woven into the AI prompt, making vague excuses harder.
3. **Grading your proof objectively** — when you submit evidence (code, screenshots, links), a separate high-reasoning AI model (Gemini 1.5 Pro) evaluates it against your stated stake and returns a pass/fail verdict. No self-grading.
4. **Locking the state on failure** — if you miss your deadline without submitting proof, the engine transitions to `FAIL_LOCKED`. There is no automatic reset.
5. **Broadcasting everything to a live WebSocket** — so a front-end UI (not yet built in this repo) can react in real time.

---

## Architecture: Two-Process Design

The system is deliberately split into two independent processes that communicate over HTTP:

```
┌─────────────────────────────────┐        HTTP POST        ┌──────────────────────────────────────┐
│         daemon-core             │ ─────────────────────►  │        api-orchestrator              │
│  (Rust, always-on background)   │  /api/webhook/daemon     │  (Node.js / TypeScript, Express)     │
│                                 │                          │                                      │
│  • Polls state.json every 10s   │                          │  • Validates & stores state          │
│  • Fires timed state events     │                          │  • Calls Gemini AI (Flash + Pro)     │
│  • Manages advisory file lock   │  POST /api/engine/       │  • Fetches RSS news briefings        │
│  • Triggers morning briefing    │  fetch-briefing          │  • Broadcasts over WebSocket         │
└─────────────────────────────────┘ ◄──────────────────────  └──────────────────────────────────────┘
                                         (daemon calls this
                                          before MORNING_CHECKIN)
```

Shared state lives in a single file: **`state.json`**. Both processes use a lock file (`state.json.lock`) to prevent concurrent writes — the daemon uses `fs2` file locking in Rust, and the API uses an `O_EXCL` create-lock loop in Node.

---

## Component 1: daemon-core (Rust)

**Location:** `daemon-core/src/main.rs`  
**Crate deps:** `chrono`, `fs2`, `reqwest` (blocking), `serde`, `serde_json`

### State Machine

The daemon enforces a finite state machine with five states:

| State | Meaning |
|---|---|
| `IDLE` | No stake set for today |
| `STAKED` | Morning check-in occurred; stake has been declared |
| `AWAITING_PROOF` | Evening deadline hit (18:00); proof window is open |
| `EVALUATED` | Proof was submitted and judged by the deep validator |
| `FAIL_LOCKED` | Deadline expired without valid proof |

### Main Loop (10-second poll)

Every 10 seconds the daemon:

1. Acquires `state.json.lock` (retries up to 40 × 25 ms = 1 second before giving up).
2. Reads `state.json` into a `SystemState` struct (creates defaults if file is empty).
3. Evaluates three time-based transitions:
   - **Morning interrupt** (`now.hour() >= morning_interrupt_hour_local` AND state is `IDLE` AND no stake set today): transitions to `STAKED`, sets `stake_timestamp`, sets `deadline_timestamp` to 18:00 same day, queues a `MORNING_CHECKIN` event.
   - **Evening deadline** (`now.hour() >= 18` AND state is `STAKED`): transitions to `AWAITING_PROOF`, queues a `PROOF_REQUEST` event.
   - **Deadline expiry** (state is `AWAITING_PROOF` AND `deadline_timestamp` has passed): transitions to `FAIL_LOCKED`, queues a `FAIL_LOCKED` event.
4. If any state changed, saves `state.json` while the lock is held, then releases the lock.
5. If `MORNING_CHECKIN` was queued, calls `POST /api/engine/fetch-briefing` first to pre-populate the day's briefing cache.
6. POSTs each queued event to `POST /api/webhook/daemon` with a `DaemonEvent` payload (event name, message, current state, timestamp).

### Key Details
- The daemon reads `DAEMON_WEBHOOK_URL` and `BRIEFING_FETCH_URL` from environment variables, falling back to `localhost:3000` defaults.
- `STATE_FILE` is also env-configurable (defaults to `./state.json`).
- `morning_interrupt_hour_local` defaults to `8` and is serialized/deserialized using `serde`'s `default` attribute — old state files without this field are handled gracefully.
- The `StateLockGuard` struct uses Rust's `Drop` trait to ensure the `.lock` file is always cleaned up even on panic.

---

## Component 2: api-orchestrator (Node.js / TypeScript)

**Location:** `api-orchestrator/src/`  
**Runtime deps:** `express` (v5), `ws`, `@google/genai`  
**Dev deps:** `typescript`, `tsx`, `@types/*`

### HTTP Endpoints

#### `POST /api/engine/fetch-briefing`
Triggered by the daemon (or manually) before the morning check-in is broadcast. Calls `buildDailyBriefingPayload()` and persists the result into `state.json.daily_briefing_data`.

Returns:
```json
{
  "fetchedAt": "ISO-8601 timestamp",
  "agendaSummary": "Priority agenda pressure: ...",
  "breakingNewsHeadlines": ["headline1", "headline2", ...],
  "briefingText": "Combined Agenda + Breaking news string"
}
```

#### `POST /api/webhook/daemon`
Receives daemon events (`MORNING_CHECKIN`, `PROOF_REQUEST`, `FAIL_LOCKED`, etc.).

For `MORNING_CHECKIN` specifically:
1. Reads `state.json` to retrieve today's cached briefing (errors if briefing hasn't been fetched yet).
2. Calls `callMorningBriefingInterceptor()` (Gemini 1.5 Flash) to generate a commitment-lock morning message that weaves together agenda pressure, breaking news, and the user's prior behavior history.
3. Broadcasts the daemon payload + generated `morningBriefingMessage` to all WebSocket clients.

For all other events: broadcasts immediately without AI generation.

#### `POST /api/user/respond`
The main interactive endpoint. Accepts:
```json
{
  "userInput": "string (required)",
  "proofAsset": "string (optional — code, image URL, description)"
}
```

Flow:
1. Always calls `callFastInterceptor()` (Gemini 1.5 Flash, ≤80 tokens) for an immediate anti-sycophantic reply to whatever the user typed.
2. If `proofAsset` is present:
   - Calls `callDeepValidator()` (Gemini 1.5 Pro, ≤160 tokens, JSON mode) to objectively judge the proof against the daily stake.
   - Updates `state.json`: sets `current_state` to `EVALUATED` (pass) or `FAIL_LOCKED` (fail) and writes the new `compressed_history_summary`.
3. Broadcasts `user.response` event over WebSocket.
4. Returns both `fastReply` and `deepResult` (or `null` if no proof submitted).

### WebSocket Server
A `ws` WebSocket server runs on the same HTTP port. Clients receive:
- `system.connected` — on connection
- `daemon.trigger` — forwarded daemon events (with optional `morningBriefingMessage`)
- `user.response` — fast AI reply + optional deep validation result

### State File Management
The API uses an `O_EXCL` file-creation lock (`state.json.lock`) with the same 40-retry × 25 ms backoff as the daemon. Writes are atomic: data is written to a uniquely named temp file first, then renamed over `state.json`. Reads go through `normalizeStateFile()` which applies safe defaults for any missing fields.

---

## Component 3: Gemini AI Integration (`gemini.ts`)

Three distinct AI call patterns are implemented:

### Fast Interceptor — Gemini 1.5 Flash
- **Purpose:** Instant interactive feedback on any user input
- **Token budget:** 80 output tokens
- **Temperature:** 0.7
- **System persona:** Unyielding, anti-sycophant; rejects excuses in under 50 words; no pleasantries

### Morning Briefing Interceptor — Gemini 1.5 Flash
- **Purpose:** Generate a commitment-lock morning message
- **Token budget:** 160 output tokens
- **Temperature:** 0.6
- **Input:** Compressed history summary + daily stake + agenda + breaking news
- **System persona:** Same unyielding persona; synthesizes agenda/news pressure to demand an explicit commitment lock

### Deep Validator — Gemini 1.5 Pro
- **Purpose:** Objective pass/fail evaluation of submitted proof
- **Token budget:** 160 output tokens
- **Temperature:** 0.2 (low = deterministic and objective)
- **Response format:** Forced JSON (`application/json` MIME type) with exact schema:
  ```json
  {
    "success": true | false,
    "critique": "string",
    "new_compressed_summary": "string (≤100 words)"
  }
  ```
- Critically, the `new_compressed_summary` is compressed by `compressSummary()` (first 100 words) before being written to state, keeping the rolling history token-efficient.

---

## Component 4: Daily Briefing (`briefing.ts`)

Two data sources are combined:

### Agenda Signals (currently mocked)
The `AgendaSignal` interface and `createMockAgendaSignals()` function describe the intended integration point for calendar and email data. Currently hardcoded with two placeholder signals:
- A critical calendar collision at 09:30
- A high-urgency investor email thread

This is the most obvious gap between the current implementation and the final vision — a real calendar/email integration (Google Calendar API, Gmail API, or similar) needs to replace the mock.

### Breaking News (live RSS)
`fetchBreakingNewsHeadlines()` fetches from two real RSS feeds:
- BBC Technology: `https://feeds.bbci.co.uk/news/technology/rss.xml`
- Reuters Technology: `https://www.reutersagency.com/feed/?best-sectors=technology`

Headlines are parsed with a regex XML scraper (CDATA-aware, tag-stripped), deduped, and filtered to only retain items matching the pattern `ai|tech|technology|macro|economy|economic|chip|semiconductor|market|inflation`. Up to 6 headlines are returned. If both feeds fail, three hardcoded fallback headlines are used.

---

## Shared State: `state.json`

The single source of truth for the engine. Both processes read and write it.

```json
{
  "user_id": "will_oak_wild",
  "current_state": "IDLE | STAKED | AWAITING_PROOF | EVALUATED | FAIL_LOCKED",
  "daily_stake": "Today's declared commitment (set by user)",
  "stake_timestamp": "ISO-8601 | null",
  "deadline_timestamp": "ISO-8601 | null (default: 18:00 same day)",
  "compressed_history_summary": "Rolling ≤100 word behavioral summary for AI context",
  "morning_interrupt_hour_local": 8,
  "daily_briefing_data": {
    "fetched_at": "ISO-8601 | null",
    "raw_agenda_summary": "string",
    "breaking_news_headlines": ["string"]
  }
}
```

The `compressed_history_summary` is the memory layer of the system — it carries behavioral context (e.g., "User prefers high-intensity, practical feedback. No participation trophies.") into every AI prompt so that the AI response is shaped by the user's prior patterns, not treated as a fresh conversation.

---

## Dev Environment

### Prerequisites
- Rust toolchain (for `daemon-core`)
- Node.js 18+ (for `api-orchestrator`)
- A Gemini API key

### Setup
```bash
cp .env.example .env
# Set GEMINI_API_KEY in .env

cd api-orchestrator && npm install
cd ..
./start-dev.sh   # Starts both processes concurrently
```

### Environment Variables
| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | (required) | Google Gemini API authentication |
| `API_PORT` | `3000` | Express + WebSocket server port |
| `DAEMON_WEBHOOK_URL` | `http://127.0.0.1:3000/api/webhook/daemon` | Where daemon POSTs events |
| `BRIEFING_FETCH_URL` | `http://127.0.0.1:3000/api/engine/fetch-briefing` | Where daemon triggers briefing fetch |
| `STATE_FILE` | `./state.json` | Path to shared state file |

### Build Commands
- **API:** `cd api-orchestrator && npm run build` (compiles TypeScript to `dist/`)
- **Daemon:** `cargo check --manifest-path daemon-core/Cargo.toml` (validates Rust)
- **Run dev:** `./start-dev.sh` (starts both with `npm run dev` + `cargo run`)

---

## What Has Been Built

| Component | Status | Notes |
|---|---|---|
| Rust daemon state machine | ✅ Complete | IDLE → STAKED → AWAITING_PROOF → FAIL_LOCKED transitions |
| Morning interrupt trigger | ✅ Complete | Fires at configurable local hour |
| File-lock concurrency | ✅ Complete | Both processes use matching lock protocols |
| API Express server | ✅ Complete | All three endpoints operational |
| WebSocket broadcast layer | ✅ Complete | All events pushed to connected clients |
| Gemini Flash fast interceptor | ✅ Complete | <400ms target, 80-token cap |
| Gemini Flash morning briefing | ✅ Complete | 160-token, agenda+news injection |
| Gemini Pro deep validator | ✅ Complete | JSON-mode, 0.2 temp, proof evaluation |
| RSS news headline ingestion | ✅ Complete | BBC + Reuters feeds with fallback |
| Rolling compressed history | ✅ Complete | Written back to state on each evaluation |
| State normalization / defaults | ✅ Complete | Both processes handle missing/old fields |
| Atomic state file writes | ✅ Complete | Temp-file + rename pattern in API |
| Agenda signal integration | 🟡 Mocked | Placeholder data; needs real calendar/email API |
| Front-end UI | ❌ Not started | WebSocket events are ready; consumer not built |
| State reset mechanism | ❌ Not started | No endpoint or daemon logic to reset FAIL_LOCKED |
| Tests | ❌ Not started | `npm test` is a no-op stub |

---

## Design Philosophy

A few intentional choices worth noting:

- **No database** — `state.json` is the entire persistence layer. This keeps deployment to a single machine trivial and removes infrastructure overhead.
- **Two-process split** — the daemon is always-on and time-driven (Rust, blocking); the API is event-driven and AI-coupled (Node.js, async). Separating them means the daemon never blocks on AI latency, and the API never needs to know about system time.
- **Anti-sycophancy by design** — the AI system instructions explicitly prohibit flattery, pleasantries, and excuse acceptance. The compressed history summary gives the AI behavioral memory without requiring a full conversation history, keeping token costs low.
- **Hard deadline enforcement** — there is no snooze, no grace period UI, no "I was sick" exception path. `FAIL_LOCKED` is a terminal state until a human manually resets `state.json`.
