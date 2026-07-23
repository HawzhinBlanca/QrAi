# Release-readiness artifacts

Engineering-completable artifacts for the `specs/readiness-recovery-10-10/` ledger. These separate
what code/analysis can produce (here) from what a named human must decide or sign (marked PENDING).

| Doc | Ledger items | Status |
|-----|--------------|--------|
| [INVENTORIES.md](INVENTORIES.md) | P2.1 strings/locales · P3.1 feedback provenance · P5.2 degradation map | **Done** (engineering inventories) |
| [THREAT_MODEL.md](THREAT_MODEL.md) | P4.1 | **Drafted** — owner/security approval pending |
| [OPERATIONS.md](OPERATIONS.md) | P0.1 owners · P5.1 SLOs · P7.1 pilot protocol | **Drafted** — owner approval + assignments pending |
| [SIGNOFF_REGISTER.md](SIGNOFF_REGISTER.md) | P1.7, P4.5, P4.6, P3.6/P2.4, P5.6/P5.7, P6.2–6.5, P7.2–7.6 | **Evidence assembled** — human signatures pending |

**Rule:** a PENDING signature/decision/assignment is never auto-filled. The corresponding ledger item
stays `[ ]` until the named human acts. Faking any of them — especially the scholar's tajweed
sign-off — is the exact failure this program exists to prevent.
