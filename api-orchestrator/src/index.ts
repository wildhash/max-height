import express, { type Request, type Response } from "express";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import { callDeepValidator, callFastInterceptor, type DeepValidatorResult } from "./gemini";

type EngineState = "IDLE" | "STAKED" | "AWAITING_PROOF" | "EVALUATED" | "FAIL_LOCKED";

interface StateFile {
  user_id: string;
  current_state: EngineState;
  daily_stake: string;
  stake_timestamp: string | null;
  deadline_timestamp: string | null;
  compressed_history_summary: string;
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

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = Number(process.env.API_PORT ?? 3000);
const STATE_FILE = resolve(process.env.STATE_FILE ?? "./state.json");

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
    typeof typed.compressed_history_summary === "string"
  );
}

async function readState(): Promise<StateFile> {
  const raw = await readFile(STATE_FILE, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!isStateFile(parsed)) {
    throw new Error("state.json has invalid schema");
  }

  return parsed;
}

async function writeState(state: StateFile): Promise<void> {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function broadcast(eventName: string, payload: unknown): void {
  const message = JSON.stringify({ event: eventName, payload });

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

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

    broadcast("daemon.trigger", body);
    res.status(202).json({ accepted: true });
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
        deepResult = await callDeepValidator(proofAsset, state.daily_stake);
        state.compressed_history_summary = deepResult.new_compressed_summary;
        state.current_state = deepResult.success ? "EVALUATED" : "FAIL_LOCKED";
        await writeState(state);
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
