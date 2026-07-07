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
# apps/mobile/package.json's own "test" script invokes it. Note: apps/mobile DOES already have
# real CI coverage via .github/workflows/mobile.yml (path-filtered on apps/mobile/** changes) —
# an earlier version of this comment incorrectly claimed no CI coverage existed at all. What this
# line actually fixes: `pnpm proof` / `scripts/smoke-all.mjs`'s "proof" step, a LOCAL pre-flight
# check, previously never exercised apps/mobile, so a developer running it before pushing
# wouldn't catch a mobile regression until mobile.yml ran separately in CI.
node --experimental-strip-types --test apps/mobile/lib/*.test.ts
# Typecheck needs the real Expo/React/React Native type definitions (unlike the test above, which
# only imports the dependency-free lib/session.ts and needs zero installed packages) — install
# once if missing, then run. apps/mobile/tsconfig.json didn't exist until this line was added, so
# App.tsx and lib/*.ts had literally never been typechecked by anything, ever.
if [ ! -d apps/mobile/node_modules ]; then
  npm --prefix apps/mobile install
fi
npm --prefix apps/mobile run typecheck
# ml-inference/agents have no pnpm workspace membership either — same gap as apps/mobile above,
# same fix. Explicit paths (not a dir glob) since server.mjs gates its side effects (listen/timers)
# on `isMain`, matching verify.sh's identical "test: node services" step.
node --test services/ml-inference/alignment.test.mjs services/ml-inference/tajweed.test.mjs services/ml-inference/server.test.mjs services/ml-inference/golden-regression.test.mjs services/agents/agents.test.mjs
cargo fmt --manifest-path services/realtime-gateway/Cargo.toml --check
cargo test --manifest-path services/realtime-gateway/Cargo.toml
cargo clippy --manifest-path services/realtime-gateway/Cargo.toml -- -D warnings
cargo fmt --manifest-path services/platform-api/Cargo.toml --check
cargo test --manifest-path services/platform-api/Cargo.toml -- --include-ignored
cargo clippy --manifest-path services/platform-api/Cargo.toml -- -D warnings
