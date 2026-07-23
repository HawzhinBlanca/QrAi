# Sign-off register — the human-gated ledger items

Each row below is an item that **cannot** be completed by code or by an AI agent: it requires a named
human to inspect the evidence and sign. Engineering has assembled the evidence and left the signature
block. **A signature here is a person attesting; it must never be auto-filled.** Until signed, the
corresponding `specs/readiness-recovery-10-10/tasks.md` item stays `[ ]` — honestly.

| Item | Who signs | Evidence prepared | Signature |
|------|-----------|-------------------|-----------|
| **P1.7** identity-boundary review | Independent security reviewer | `THREAT_MODEL.md`; adversarial audit (2026-07-23, no IDOR); P1.6 browser proof; #238–#241 | _PENDING_ ______ date ____ |
| **P4.5** independent security assessment | External pen-tester | `THREAT_MODEL.md`; cargo/pnpm audit gates; fail-closed config | _PENDING_ ______ date ____ |
| **P4.6** privacy / legal review + user notice | Lawyer / DPO | `INVENTORIES.md` (data), privacy export/delete + audit trail, consent model | _PENDING_ ______ date ____ |
| **P3.6 / P2.4** tajweed scope + content | Qualified scholar | Withholding gate (contracts + tests); ADR-0013 (mushaddad-ghunnah withheld); provenance manifest | _PENDING_ ______ date ____ |
| **P5.7** load / chaos / restore / rollback | SRE | `scripts/load-test.js`, `scripts/chaos-realtime-reconnect.mjs`, kill-switch, RTO/RPO proposal | _PENDING_ ______ date ____ |
| **P5.6** backup + PITR/DR drill | SRE / infra | (requires prod infra — drill not yet run) | _PENDING_ ______ date ____ |
| **P6.2** assistive-tech audit (VoiceOver/AT) | Accessibility reviewer | a11y baseline (roles/labels/skip-link, `role=alert`, offline-state test); axe automation pending | _PENDING_ ______ date ____ |
| **P6.3 / P6.4** signed mobile + physical devices | Mobile owner | (requires signed iOS/Android builds + real devices) | _PENDING_ ______ date ____ |
| **P6.5** usability / comprehension study | UX researcher | (requires consented real users) | _PENDING_ ______ date ____ |
| **P7.2** internal dogfood | Team | full test suite green; evidence ledger | _PENDING_ ______ date ____ |
| **P7.3** bounded external pilot | Pilot lead | `OPERATIONS.md` protocol | _PENDING_ ______ date ____ |
| **P7.5** independent challenger + rollback rehearsal | Independent verifier | clean-checkout CI on every PR; rollback playbook | _PENDING_ ______ date ____ |
| **P7.6** go / no-go | Release authority | this register + `OPERATIONS.md` matrix | _PENDING_ ______ date ____ |

## Why these are not "done"

Marking any of these complete without the real human action would be fabricated evidence — the exact
failure the readiness-recovery program exists to prevent (see the ledger header + `SHIP_READINESS.md`
"historical/superseded" note). For a Qur'an learning platform the scholar sign-off in particular
outranks every green check. Engineering's job ends at "evidence assembled, signature block ready";
the attestation is the human's.

See also: `THREAT_MODEL.md` (P4.1 draft), `OPERATIONS.md` (P0.1/P5.1/P7.1 drafts), `INVENTORIES.md`
(P2.1/P3.1/P5.2). The signed release-evidence architecture is ADR-0018 (accepted for implementation);
P0.4/P0.6 evidence tooling is largely built (`scripts/release-*.mjs`, `verify.sh --release`).
