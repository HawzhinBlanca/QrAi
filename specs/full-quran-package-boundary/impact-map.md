# Full Quran Package Boundary Impact Map

## Changed Files

- `packages/quran-data/package.json`
  - Adds a `./full-quran` subpath export for Node/server consumers.
  - Keeps the root export unchanged so browser imports still avoid `node:fs`.

- `packages/quran-data/tests/full-quran.test.ts`
  - Adds a self-reference import from `@quran-ai/quran-data/full-quran`.
  - Proves the public package boundary resolves and can run full-data validation.

- `docs/proof/10-10-proof-checklist.md`
  - Updates local proof language for full Quran data.
  - Reframes the open proof gate as independent Tanzil/Quran Foundation reconciliation rather than claiming no full bundle proof exists.

- `docs/architecture/10-10-platform.md`
  - Updates the implemented slice and still-open architecture items around full Quran data.

## References Checked

- `validateFullQuranData` references: `packages/quran-data/tests/full-quran.test.ts`.
- `getSurah` references: `packages/quran-data/src/full-quran.ts` helpers and `packages/quran-data/tests/full-quran.test.ts`.

## Test Coverage

- `pnpm --filter @quran-ai/quran-data test`
- `pnpm --filter @quran-ai/quran-data typecheck`
- `bash scripts/verify.sh`
