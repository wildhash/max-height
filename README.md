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
        ├── index.ts
        ├── gemini.ts
        └── prompts.ts
```

## Run locally

1. Copy `.env.example` to `.env` and set `GEMINI_API_KEY`.
2. Install API dependencies:
   ```bash
   cd /tmp/workspace/wildhash/max-height/api-orchestrator
   npm install
   ```
3. Start both services:
   ```bash
   cd /tmp/workspace/wildhash/max-height
   ./start-dev.sh
   ```
