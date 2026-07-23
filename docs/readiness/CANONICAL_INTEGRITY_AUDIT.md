# Canonical Qur'an integrity audit (P3.3)

Audit of the canonical text's checksum / version / import / rollback process, and where each step is
verified by an automated test. No mutable path was found; the one historical gap (the seed script
computing a different checksum than the importer) was already closed (ADR-0005).

## Checksum
- `createCanonicalChecksum` / `createCanonicalAyahChecksum` — SHA-256 over the canonical text
  (ADR-0004 upgraded this from FNV-1a 32-bit; the legacy FNV path is retained only for verifying
  already-seeded rows). Source: `packages/quran-data/src/index.ts`.
- Every ayah/word row carries `source_checksum`; import **verifies** it and refuses a row whose
  checksum does not recompute (`verifyCanonicalWord` / import validation), rather than silently
  accepting it.
- **Verified by:** `packages/quran-data/tests/full-quran-checksum-integrity.test.ts`,
  `translations-integrity.test.ts`, `word-timings-integrity.test.ts`, `quran-import.test.ts`
  (checksum determinism + tamper detection: a mutated text fails verification).

## Version / provenance
- Full corpus: alquran.cloud 114-surah / 6236-ayah bundle; surah names in `canonical_surahs`.
- Translations: provenance-manifest gated — the current Sorani asset is pinned in
  `2026-07-19-provenance-v2` (39 files / 856 ayahs / 1 explicit omission + content hash); importer
  writes require an unused version directory (no in-place overwrite).
- **Verified by:** `translations-provenance.test.ts` (manifest presence + content hash).

## Import
- Production seed: `packages/quran-data/scripts/seed-full-quran-to-db.sh`, run in CI against a fresh
  DB (`Seed full Quran` step). It shares the SAME checksum builder as the importer (ADR-0005 closed
  the earlier gap where the script computed a different `source_checksum` than the app expected).
- Import is idempotent and **corrects** a wrong `source_checksum` rather than skipping it.

## Rollback
- Canonical rows are immutable content addressed by checksum; a bad import is rolled back by
  re-seeding from the pinned bundle (the checksum makes drift detectable).
- Migrations are additive/idempotent, so a schema rollback is redeploy-previous-image (see
  `OPERATIONS.md` / `STAGING_RUNBOOK.md`).

## Mutable-path finding
None open. The one historical mutable path (seed vs. importer checksum divergence, ADR-0005) is
closed and covered by the integrity tests above. Re-run those tests after any change to the checksum
builder or the canonical bundle (they fail closed on drift).
