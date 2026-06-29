#!/usr/bin/env bash
set -euo pipefail

export DATABASE_URL="${DATABASE_URL:-postgresql://hawzhin@localhost:5432/quran_ai}"
export PATH="/opt/homebrew/opt/postgresql@16/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

pnpm --filter @quran-ai/contracts test
pnpm --filter @quran-ai/contracts typecheck
pnpm --filter @quran-ai/quran-data test
pnpm --filter @quran-ai/quran-data typecheck
pnpm --filter @quran-ai/web test
pnpm --filter @quran-ai/web build
cargo fmt --manifest-path services/realtime-gateway/Cargo.toml --check
cargo test --manifest-path services/realtime-gateway/Cargo.toml
cargo clippy --manifest-path services/realtime-gateway/Cargo.toml -- -D warnings
cargo fmt --manifest-path services/platform-api/Cargo.toml --check
cargo test --manifest-path services/platform-api/Cargo.toml -- --include-ignored
cargo clippy --manifest-path services/platform-api/Cargo.toml -- -D warnings
