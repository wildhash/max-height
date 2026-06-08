# max-height

Always-on, low-latency accountability daemon built in Rust and Node.js. Uses Gemini 1.5 Flash for ultra-fast, anti-sycophant interactive roasting (<400ms) and Gemini 1.5 Pro for async deep-thought validation of user output proofs.

## Project structure

```
.
├── .env.example
├── README.md
├── state.json
├── daemon-core/
│   ├── Cargo.toml
│   └── src/main.rs
└── api-orchestrator/
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── briefing.ts
        ├── index.ts
        ├── gemini.ts
        └── prompts.ts
```

## Run locally

1. Copy `.env.example` to `.env` and set `GEMINI_API_KEY`.
2. Install API dependencies:
   ```bash
   cd api-orchestrator
   npm install
   ```
3. Start both services:
   ```bash
   cd ..
   ./start-dev.sh
   ```

## Morning briefing flow

- The daemon now uses `state.json.morning_interrupt_hour_local` (default `8`) to trigger the morning interrupt.
- Before posting `MORNING_CHECKIN`, the daemon calls `POST /api/engine/fetch-briefing` (`BRIEFING_FETCH_URL`) so `state.json.daily_briefing_data` is populated.
- The API injects the cached agenda/news briefing into Gemini Flash and broadcasts the generated commitment-lock morning message with the daemon trigger payload.
