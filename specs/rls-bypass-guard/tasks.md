# RLS Bypass Guard Tasks

- [x] T1 Make `app.bypass_rls` superuser-only and prove restricted roles remain tenant-scoped even when they set it. Tests: `SQL_SMOKE_REQUIRE_LIVE=true POSTGRES_RLS_SMOKE_URL=postgresql://hawzhin@localhost:5432/quran_ai pnpm smoke:sql`, `bash scripts/verify.sh`
