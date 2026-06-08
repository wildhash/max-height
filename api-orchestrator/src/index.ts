import express, { type Request, type Response } from "express";
import { createServer } from "node:http";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import { buildDailyBriefingPayload, type DailyBriefingData } from "./briefing";
import {
  callDeepValidator,
  callFastInterceptor,
  callMorningBriefingInterceptor,
  type DeepValidatorResult,
} from "./gemini";

type EngineState = "IDLE" | "STAKED" | "AWAITING_PROOF" | "EVALUATED" | "FAIL_LOCKED";

interface StateFile {
  user_id: string;
  current_state: EngineState;
  daily_stake: string;
  stake_timestamp: string | null;
  deadline_timestamp: string | null;
  compressed_history_summary: string;
  morning_interrupt_hour_local: number;
  daily_briefing_data: DailyBriefingData;
}

interface DaemonWebhookRequest {
  event: string;
  message: string;
  state: EngineState;
  timestamp: string;
}

interface UserRespondRequest {
  userInput: string;
  proofAsset?: string;
}

interface FetchBriefingResponse {
  fetchedAt: string;
  agendaSummary: string;
  breakingNewsHeadlines: string[];
  briefingText: string;
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = Number(process.env.API_PORT ?? 3000);
const STATE_FILE = resolve(process.env.STATE_FILE ?? "./state.json");
const STATE_LOCK_FILE = `${STATE_FILE}.lock`;
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_RETRIES = 40;

app.use(express.json());

function isEngineState(value: unknown): value is EngineState {
  return (
    value === "IDLE" ||
    value === "STAKED" ||
    value === "AWAITING_PROOF" ||
    value === "EVALUATED" ||
    value === "FAIL_LOCKED"
  );
}

function isStateFile(value: unknown): value is StateFile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const typed = value as Partial<StateFile>;
  return (
    typeof typed.user_id === "string" &&
    isEngineState(typed.current_state) &&
    typeof typed.daily_stake === "string" &&
    (typed.stake_timestamp === null || typeof typed.stake_timestamp === "string") &&
    (typed.deadline_timestamp === null || typeof typed.deadline_timestamp === "string") &&
    typeof typed.compressed_history_summary === "string" &&
    typeof typed.morning_interrupt_hour_local === "number" &&
    isDailyBriefingData(typed.daily_briefing_data)
  );
}

function isDailyBriefingData(value: unknown): value is DailyBriefingData {
  if (!value || typeof value !== "object") {
    return false;
  }

  const typed = value as Partial<DailyBriefingData>;
  return (
    (typed.fetched_at === null || typeof typed.fetched_at === "string") &&
    typeof typed.raw_agenda_summary === "string" &&
    Array.isArray(typed.breaking_news_headlines) &&
    typed.breaking_news_headlines.every((headline) => typeof headline === "string")
  );
}

function normalizeStateFile(value: unknown): StateFile {
  if (!value || typeof value !== "object") {
    throw new Error("state.json has invalid schema");
  }

  const typed = value as Partial<StateFile>;
  if (
    typeof typed.user_id !== "string" ||
    !isEngineState(typed.current_state) ||
    typeof typed.daily_stake !== "string" ||
    (typed.stake_timestamp !== null && typeof typed.stake_timestamp !== "string") ||
    (typed.deadline_timestamp !== null && typeof typed.deadline_timestamp !== "string") ||
    typeof typed.compressed_history_summary !== "string"
  ) {
    throw new Error("state.json has invalid schema");
  }

  const morningInterruptHour =
    typeof typed.morning_interrupt_hour_local === "number" &&
    Number.isInteger(typed.morning_interrupt_hour_local) &&
    typed.morning_interrupt_hour_local >= 0 &&
    typed.morning_interrupt_hour_local <= 23
      ? typed.morning_interrupt_hour_local
      : 8;

  const dailyBriefingData = isDailyBriefingData(typed.daily_briefing_data)
    ? typed.daily_briefing_data
    : {
        fetched_at: null,
        raw_agenda_summary: "",
        breaking_news_headlines: [],
      };

  return {
    user_id: typed.user_id,
    current_state: typed.current_state,
    daily_stake: typed.daily_stake,
    stake_timestamp: typed.stake_timestamp ?? null,
    deadline_timestamp: typed.deadline_timestamp ?? null,
    compressed_history_summary: typed.compressed_history_summary,
    morning_interrupt_hour_local: morningInterruptHour,
    daily_briefing_data: dailyBriefingData,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

async function withStateLock<T>(callback: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < STATE_LOCK_RETRIES; attempt += 1) {
    let lockHandle = null;
    try {
      lockHandle = await open(STATE_LOCK_FILE, "wx");
      await lockHandle.writeFile(`${process.pid}\n`, "utf8");
      return await callback();
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST" &&
        attempt < STATE_LOCK_RETRIES - 1
      ) {
        await sleep(STATE_LOCK_RETRY_MS);
        continue;
      }

      throw error;
    } finally {
      if (lockHandle) {
        await lockHandle.close().catch(() => undefined);
        await unlink(STATE_LOCK_FILE).catch(() => undefined);
      }
    }
  }

  throw new Error(
    `Timed out acquiring state lock at ${STATE_LOCK_FILE} after ${STATE_LOCK_RETRIES} retries with ${STATE_LOCK_RETRY_MS}ms backoff.`,
  );
}

async function readStateUnlocked(): Promise<StateFile> {
  const raw = await readFile(STATE_FILE, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return normalizeStateFile(parsed);
}

async function readState(): Promise<StateFile> {
  return withStateLock(readStateUnlocked);
}

async function writeStateUnlocked(state: StateFile): Promise<void> {
  const temporaryPath = `${STATE_FILE}.${process.pid}.${process.hrtime.bigint()}.tmp`;

  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, STATE_FILE);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function updateState(mutator: (state: StateFile) => void | Promise<void>): Promise<void> {
  await withStateLock(async () => {
    const state = await readStateUnlocked();
    await mutator(state);
    await writeStateUnlocked(state);
  });
}

function broadcast(eventName: string, payload: unknown): void {
  const message = JSON.stringify({ event: eventName, payload });

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

function hasBriefingForToday(fetchedAt: string | null): boolean {
  if (!fetchedAt) {
    return false;
  }

  const fetchedDate = new Date(fetchedAt);
  if (Number.isNaN(fetchedDate.getTime())) {
    return false;
  }

  const now = new Date();
  return (
    fetchedDate.getFullYear() === now.getFullYear() &&
    fetchedDate.getMonth() === now.getMonth() &&
    fetchedDate.getDate() === now.getDate()
  );
}

async function fetchAndPersistBriefing(): Promise<FetchBriefingResponse> {
  const briefing = await buildDailyBriefingPayload();
  await updateState((state) => {
    state.daily_briefing_data = {
      fetched_at: briefing.fetchedAt,
      raw_agenda_summary: briefing.agendaSummary,
      breaking_news_headlines: briefing.breakingNewsHeadlines,
    };
  });

  return briefing;
}

app.post("/api/engine/fetch-briefing", async (_req: Request, res: Response) => {
  try {
    const briefing = await fetchAndPersistBriefing();
    res.status(200).json(briefing);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    res.status(500).json({ error: message });
  }
    });

app.post(
  "/api/webhook/daemon",
  async (
    req: Request<Record<string, never>, Record<string, never>, DaemonWebhookRequest>,
    res: Response,
  ) => {
    const body = req.body;
    if (
      !body ||
      typeof body.event !== "string" ||
      typeof body.message !== "string" ||
      !isEngineState(body.state) ||
      typeof body.timestamp !== "string"
    ) {
      res.status(400).json({ error: "Invalid daemon payload." });
      return;
    }

    try {
      let morningBriefingMessage: string | null = null;
      if (body.event === "MORNING_CHECKIN") {
        const state = await readState();
        const briefingData = hasBriefingForToday(state.daily_briefing_data.fetched_at)
          ? state.daily_briefing_data
          : (() => {
              throw new Error("Daily briefing missing for current date. Call /api/engine/fetch-briefing first.");
            })();

        morningBriefingMessage = await callMorningBriefingInterceptor(
          [
            `Agenda: ${briefingData.raw_agenda_summary}`,
            `Breaking news: ${briefingData.breaking_news_headlines.join(" || ") || "No headlines available."}`,
          ].join("\n"),
          state.compressed_history_summary,
          state.daily_stake,
        );
      }

      const payload = {
        ...body,
        morningBriefingMessage,
      };

      broadcast("daemon.trigger", payload);
      res.status(202).json({ accepted: true, morningBriefingMessage });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error";
      res.status(500).json({ error: message });
    }
  },
);

app.post(
  "/api/user/respond",
  async (
    req: Request<Record<string, never>, Record<string, never>, UserRespondRequest>,
    res: Response,
  ) => {
    const { userInput, proofAsset } = req.body ?? {};
    if (typeof userInput !== "string" || !userInput.trim()) {
      res.status(400).json({ error: "userInput is required." });
      return;
    }

    try {
      const state = await readState();
      const fastReply = await callFastInterceptor(userInput, state.compressed_history_summary);

      let deepResult: DeepValidatorResult | null = null;
      if (typeof proofAsset === "string" && proofAsset.trim().length > 0) {
        const validatorResult = await callDeepValidator(proofAsset, state.daily_stake);
        deepResult = validatorResult;
        await updateState((latestState) => {
          latestState.compressed_history_summary = validatorResult.new_compressed_summary;
          latestState.current_state = validatorResult.success ? "EVALUATED" : "FAIL_LOCKED";
        });
      }

      const payload = { fastReply, deepResult };
      broadcast("user.response", payload);
      res.status(200).json(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error";
      res.status(500).json({ error: message });
    }
  },
);

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ event: "system.connected", payload: { ok: true } }));
});

server.listen(PORT, () => {
  console.log(`api-orchestrator listening on http://127.0.0.1:${PORT}`);
});
