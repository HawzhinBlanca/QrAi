# AGENTS.md — Operating rules for AI coding agents

## Project
**quran-ai-platform** — a Quran Recitation Intelligence OS: learner recitation, realtime
Quran-constrained alignment, confidence-scored tajweed feedback, teacher review,
scholar/source approval, and model-evaluation proof gates. Polyglot pnpm monorepo:

- **TS** (pnpm@11, Node 22): `apps/web` (React 19 + Vite), `packages/contracts`,
  `packages/quran-data`. `apps/mobile` is Expo (not in the workspace, not gated).
- **Rust** (1.96, cargo): `services/realtime-gateway`, `services/platform-api`
  (Axum; integration tests need live Postgres).
- **Services**: `services/ml-inference` (Node), `services/asr-inference` (Python),
  `services/agents` (stub). Driven via `docker compose` + `scripts/smoke-*.mjs`.

## Commands (exact)
- Install:    `pnpm install --frozen-lockfile`
- Dev:        `pnpm dev`              # serves apps/web
- Typecheck:  `pnpm typecheck`        # tsc for contracts + quran-data + web
- Test:       `pnpm test`             # vitest + cargo test; runs platform-api with
              #                          --include-ignored, so it FAILS (not skips) without a live Postgres
- Build:      `pnpm build`            # contracts + quran-data + web
- Proof:      `pnpm proof`            # legacy strict gate (scripts/proof.sh); also requires live Postgres
- Smoke:      `pnpm smoke:all`        # full smoke incl. SQL/browser/API/ML/privacy
- **Verify ALL: `bash scripts/verify.sh`**   # the CODYSTEM gate — run before claiming done

`scripts/verify.sh` is the canonical gate (guard + Rust fmt/clippy + TS typecheck +
TS/Rust tests + build). Unlike `pnpm test`/`pnpm proof` (which run the platform-api
integration tests unconditionally and therefore require a live Postgres), `verify.sh`
SKIPS those DB tests when no DB is reachable — it never fakes them. CI runs the same script.

## Workflow (non-negotiable)
1. RESEARCH before coding. Use Serena (find_symbol, find_referencing_symbols) to map real
   code. Write `specs/<feature>/research.md`. Do NOT write code yet.
2. PLAN. Write `specs/<feature>/plan.md` + `impact-map.md`. STOP and wait for human approval.
3. IMPLEMENT one task at a time, smallest correct change. After each task run
   `bash scripts/verify.sh`. Only if it exits 0, mark the task done in tasks.md
   (via `scripts/update-ledger.sh`).
4. Never mark a task or feature "done" based on your own judgment.
   "Done" = verify.sh green AND required CI checks green.

## Grounding rules
- Find the symbol with Serena before editing it. Never invent a function signature.
- Before changing any symbol, run find_referencing_symbols and list affected callers in
  impact-map.md. Add/adjust tests for every caller you might break.

## Domain rules (Quran AI — these are correctness, not style)
- **Canonical Quran data is immutable.** `packages/quran-data` bundles are checksum-validated;
  never mutate a seed/import bundle in place — add a new versioned bundle + checksum.
- **No learner-facing AI feedback without a source + review gate.** Tajweed/alignment output
  shown to learners must carry its source and pass the contract's review/approval gates.
- **No fabricated model or eval output.** Inference/eval results come from a real service or a
  declared fixture — never hand-authored numbers presented as model output.
- **Tenant isolation is enforced (Postgres RLS).** Don't add a tenant-owned table or query
  path that bypasses the RLS policies in `infra/sql/0003_tenant_rls.sql`.
- **Audio/privacy.** Honor audio-retention + privacy export/delete logic in `contracts`;
  never log raw audio or secrets.

## Hard boundaries (also enforced by hooks — do not attempt to bypass)
- Never edit: `.env*`, `secrets/**`, `**/*.pem`, `node_modules/**`, `dist/**`, `build/**`,
  `target/**`, `out/**`, `/legacy/**`.
- Never run: `rm -rf`, `git push --force`, `git reset --hard` on shared branches, `curl|sh`.
- Never commit secrets. Never disable a failing test, weaken an assertion, or use
  `--no-verify` to get past the gate.

## Context hygiene
- Keep your context window under ~50%. Use subagents for searches/log-reading and keep only
  their summaries. Compact findings into research.md/plan.md, then continue in a fresh context.

## Acceptance criteria format
Use EARS in spec.md: "WHEN <trigger>, THE <system> SHALL <response>" etc.
Every criterion must map to at least one automated test.

## Living docs (keep small; update when behavior changes)
- `docs/architecture/10-10-platform.md` (system shape)
- `docs/DECISIONS.md` (ADRs: new runtime dependency or architectural change requires one)
- `docs/TESTING.md` (how to test; gate + DB-gated + smoke conventions)
