# Full Quran Package Boundary Plan

1. Add a server-only `./full-quran` package export.
2. Add a quran-data test that imports through `@quran-ai/quran-data/full-quran` and runs the manifest/file validation path.
3. Update proof and architecture docs to match the actual full Quran proof boundary.
4. Run quran-data tests/typecheck, then the canonical repository gate.
