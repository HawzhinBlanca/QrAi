# Canary and Monitored Launch Plan

Run full smoke test suite against staging canary.

## Proposed Changes
No changes needed. Smoke testing suites are fully active and passing.

## Verification Plan

### Automated Tests
- Run pnpm smoke:all:
  ```bash
  DATABASE_URL="postgresql://quran_ai_app:$(grep POSTGRES_PASSWORD .env.staging | cut -d= -f2)@localhost:5433/quran_ai" POSTGRES_RLS_SMOKE_URL="postgresql://hawzhin:$(grep POSTGRES_PASSWORD .env.staging | cut -d= -f2)@localhost:5433/quran_ai" PSQL="docker exec -i -e PGPASSWORD=$(grep POSTGRES_PASSWORD .env.staging | cut -d= -f2) quran-ai-staging-postgres-1 psql" pnpm smoke:all
  ```
- Run verify.sh:
  ```bash
  bash scripts/verify.sh
  ```
