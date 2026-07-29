# Tasks — stop scoring non-recited mushaf marks

Plan: `plan.md` (APPROVED 2026-07-29). Ledger rows flipped ONLY by `scripts/update-ledger.sh`
after `bash scripts/verify.sh` exits 0.

- [x] T1 isNonRecitedMark in contracts + fixture parity + checksum-invariance + corpus sweep
- [x] T2 alignWords never scores a mark (+ cross-runtime parity pin)
- [x] T3 forced-align transcript excludes marks (positional timing map stays in step)
- [x] T4 marks render as non-interactive pause guidance, not scored buttons
