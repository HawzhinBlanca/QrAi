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
# apps/mobile is not a pnpm workspace member (Expo's own dependency tree), so it has no
# `pnpm --filter` target — run its hermetic node:test suite directly, matching how
# apps/mobile/package.json's own "test" script invokes it. Previously never run by proof.sh,
# verify.sh, or CI, so a real regression here (e.g. hardcoded guardianApproved:true, the exact
# class of bug lib/session.ts's own tests guard against) would have gone undetected.
node --experimental-strip-types --test apps/mobile/lib/*.test.ts
# ml-inference/agents have no pnpm workspace membership either — same gap as apps/mobile above,
# same fix. Explicit paths (not a dir glob) since server.mjs gates its side effects (listen/timers)
# on `isMain`, matching verify.sh's identical "test: node services" step.
node --test services/ml-inference/alignment.test.mjs services/ml-inference/tajweed.test.mjs services/ml-inference/server.test.mjs services/agents/agents.test.mjs
cargo fmt --manifest-path services/realtime-gateway/Cargo.toml --check
cargo test --manifest-path services/realtime-gateway/Cargo.toml
cargo clippy --manifest-path services/realtime-gateway/Cargo.toml -- -D warnings
cargo fmt --manifest-path services/platform-api/Cargo.toml --check
cargo test --manifest-path services/platform-api/Cargo.toml -- --include-ignored
cargo clippy --manifest-path services/platform-api/Cargo.toml -- -D warnings
