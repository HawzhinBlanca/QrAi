# Full Quran Package Boundary Research

## Target Surface

- `packages/quran-data/src/full-quran.ts`
  - Server-only full Quran data module for all 114 surahs and 6236 ayahs.
  - Reads `src/data/full-quran/manifest.json` and per-surah JSON files through `node:fs`.
- `packages/quran-data/tests/full-quran.test.ts`
  - Proves manifest totals, all surah files loading, edge surah counts, ayah text lookup, range helpers, invalid input errors, and word-count consistency.
- `packages/quran-data/package.json`
  - Currently exports only `"."`; package consumers cannot import the full Quran server module through a stable package boundary.
- `docs/proof/10-10-proof-checklist.md`
  - Still describes Quran data proof as Al-Fatihah-only and leaves full canonical ingestion unchecked.
- `docs/architecture/10-10-platform.md`
  - Still describes `packages/quran-data` as an Al-Fatihah seed foundation, despite the full server-only data module.

## Findings

- The full Quran module is tested, but tests import `../src/full-quran`, which does not prove the public package boundary.
- `src/index.ts` intentionally exports only types from `full-quran.ts` because the implementation uses `node:fs` and must stay out of browser bundles.
- A subpath export can expose the server-only module as `@quran-ai/quran-data/full-quran` without changing the browser-facing root export.
- Current full Quran data source is `alquran.cloud` `quran-uthmani`, not a completed Tanzil/Quran Foundation reconciliation. Docs should reflect that boundary instead of overclaiming.

## Acceptance Criteria

- WHEN Node consumers import `@quran-ai/quran-data/full-quran`, THE package SHALL resolve the server-only full Quran module through package exports.
- WHEN the quran-data tests run, THE tests SHALL prove the package subpath exposes the 114-surah/6236-ayah manifest and can validate all surah files.
- WHEN proof docs describe Quran data coverage, THE docs SHALL distinguish the proven alquran.cloud full bundle from still-open Tanzil/Quran Foundation reconciliation.
