# Canonical Gate Stabilization — Task Ledger

- [x] T1 — Replace the five fixed lazy-load polling loops in
  `apps/web/src/App.smoke.test.tsx` with one bounded, assertion-based Internal
  Command readiness helper.  Acceptance: R1–R4 in `spec.md`; proof:
  `pnpm --filter @quran-ai/web test` and `bash scripts/verify.sh`.
