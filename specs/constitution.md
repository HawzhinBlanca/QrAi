# Project Constitution — quran-ai-platform

## Engineering
- Test-first: no implementation code before a failing test exists for the criterion.
- Smallest correct change. No drive-by refactors outside the task's impact map.
- A new runtime dependency or architectural change REQUIRES an ADR in docs/DECISIONS.md.
- Observability: features exposed/inspectable; structured logs for non-trivial paths.
- Security: never log secrets or raw audio; validate all external input.

## Domain (Quran AI — binding invariants)
- **Canonical data is immutable.** Quran seed/import bundles are checksum-validated;
  changes ship as new versioned bundles, never in-place edits.
- **Sourced, reviewed AI only.** No learner-facing tajweed/alignment output without its
  source attached and the contract's source/review/approval gate satisfied.
- **No fabricated model/eval output.** Numbers shown as model/eval results come from a real
  service or a declared fixture — never hand-authored.
- **Tenant isolation.** Tenant-owned tables stay behind Postgres RLS
  (`infra/sql/0003_tenant_rls.sql`); no query path bypasses it.
- **Privacy by contract.** Audio retention + export/delete follow `packages/contracts`;
  consent-gated for any external ASR.

Every criterion in a feature's spec.md must map to at least one automated test, and that
test runs inside `scripts/verify.sh`.
