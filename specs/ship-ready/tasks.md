# Ship-Ready Remediation Tasks

- [x] T1 Docker Compose and Secret security checks (C-1, H-1) Tests: platform-api and realtime-gateway secure config checks, docker-compose file validation
- [x] T2 Database Schema & RLS for `eval_runs` (C-2) Tests: `node scripts/smoke-sql.mjs` and migration checks
- [x] T3 Platform API Eval Handler update (C-2) Tests: `cargo test --manifest-path services/platform-api/Cargo.toml -- --include-ignored`
- [x] T4 ML Inference shared key check & CORS & Audio storage cleanup (H-2, L-1) Tests: `/health` endpoint and CORS header checks
- [x] T5 Realtime Gateway Redis keys scan & passing API key (H-3, H-2) Tests: gateway unit tests
- [x] T6 Web client API headers and key passing (M-4, H-2) Tests: TS typecheck and Vitest tests
- [x] T7 Quran Data hardcoded check fix (L-3) Tests: `pnpm --filter @quran-ai/quran-data test`
- [x] T8 Python ASR Whisper force-align crash guard (I-1) Tests: fast verify typecheck and ASR server launch checks
