#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

(
  cd "$ROOT_DIR/api-orchestrator"
  npm run dev
) &

(
  cd "$ROOT_DIR"
  cargo run --manifest-path "$ROOT_DIR/daemon-core/Cargo.toml"
) &

wait -n
