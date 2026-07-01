---
name: research
description: Phase 1 of the CODYSTEM loop. Map every relevant file, symbol, and data flow for a feature using Serena (read-only). Writes a compacted specs/<feature>/research.md. Use BEFORE any planning or coding. No code is written.
---

# Research (no code)

**Goal:** produce a small, high-signal map of the real code touched by `<feature>` so the
plan is grounded in reality, not guesses.

## Procedure

Research only. Do not write or edit code. Using Serena (`find_symbol`,
`find_referencing_symbols`, `get_symbols_overview`), map every file, symbol, and data
flow relevant to `<feature>`. Use a subagent for broad searches and return only its
summary. Write a compacted `specs/<feature>/research.md` (≤ ~60 lines) covering:

- relevant files / symbols
- current behavior
- integration points
- risks

Stop when done.

## Done when
- `specs/<feature>/research.md` exists, ≤ ~60 lines, and lists files/symbols/data-flows
  + risks grounded in real symbols (not invented).
- No code or tests were created or edited.

→ Next: `plan`.
