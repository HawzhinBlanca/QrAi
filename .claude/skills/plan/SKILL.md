---
name: plan
description: Phase 2 of the CODYSTEM loop. Turn research.md into an approvable plan.md plus impact-map.md (callers of every symbol to be touched). Stops for HUMAN approval before any code. No code is written.
---

# Plan (human gate)

**Goal:** a plan a human can verify in ~30 seconds, plus a regression impact map — written
before a single line of implementation.

## Procedure

Read `research.md` and `specs/constitution.md`. Write `specs/<feature>/plan.md` (approach +
rationale, exact files/symbols to change, new tests mapped to each EARS criterion, risks)
and `impact-map.md` (callers of every symbol you'll touch, via `find_referencing_symbols`,
plus tests to run). Do NOT write code. Stop and wait for my approval on the line in
plan.md.

## Done when
- `specs/<feature>/plan.md` exists with an `Approved-by:` line left blank for a human.
- `specs/<feature>/impact-map.md` lists every symbol to be touched and its callers.
- Each EARS criterion in spec.md maps to at least one named planned test.
- **STOP.** Do not start `implement` until the `Approved-by:` line is filled in by a human.

→ Next (after approval): `implement`.
