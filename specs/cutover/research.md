# Research — Phase 9: cutover + security re-review

Measured against `6f22fa2` (Phase 8 merged).

---

## 1. There is nothing to cut over

`services/node-api/server.mjs:26` — the shell declares **2** portable routes
(`GET /v1/learner/progress`, `POST /v1/realtime-session-tickets`) out of **38** method+path pairs.

`server.mjs:386` — `NODE_API_PORTED ?? ""`. **The default is empty.** In every configuration that is
not a test, the Node shell serves **zero** routes and proxies 100% of traffic to Rust.

So "cutover" would mean cutting over to a service that implements **2 of 38 endpoints**, one of which
delegates any request carrying a pilot cookie back to Rust anyway (`lib/authz.mjs` — the 306-line
pilot session path is not ported).

## 2. The gate is a human signature, and I cannot produce one

`specs/readiness-recovery-10-10/tasks.md`:

```
- [ ] P1.7 — Security reviewer challenges the deployed candidate identity boundary and SIGNS the result.
- [ ] P4.1 — APPROVE full-system threat model and map each material threat to test/mitigation/accepted risk owner.
```

Both are open, and both are **approval** items by construction. Phase 9's stated gate — *"security
sign-off on the new boundary"* — is that signature. No script can produce it, and fabricating one is
the single thing this project has been most careful never to do.

Also open and directly relevant:

```
- [ ] P5.5 — Prove alerts, dashboards, owner routes, runbooks, feature/kill switch, deploy and rollback.
- [ ] P5.6 — Encrypted backup verification and timed point-in-time restore/DR drill.
```

## 3. Rollback still has no artifact

`docs/DECISIONS.md` ADR-0022 — **Status: Proposed (blocks P5.5)**, unchanged since Phase 4.

Every application service in `docker-compose.yml` uses `build:`, no workflow builds or pushes an
image, and `release-manifest.mjs` already demands `imageDigests` that nothing produces. So rollback
today means `git checkout <sha> && docker compose build` — a rebuild, not a rollback, taking minutes
and able to fail for reasons unrelated to the code being restored.

**A cutover whose rollback has never been rehearsed is the specific thing Phase 4 flagged and left
open.** Phase 7 chose the strangler topology precisely so no cutover would need one.

## 4. Four cutover-adjacent specs already exist, none implemented

`specs/go-no-go/`, `specs/canary-monitored-launch/`, `specs/incident-rollback/`,
`specs/production-posture/` — each has `plan.md` + `research.md` + `impact-map.md` and **no
`tasks.md`**, so none reached a ledger. `specs/go-no-go/plan.md` is 14 non-blank lines and says *"No
changes needed."*

`scripts/release-manifest.mjs --verify` exists and works, but it is a **release** verifier, not a
cutover check: it refuses a manifest inside the candidate checkout ("must be outside the candidate
checkout"), because its job is to validate external evidence about a built artifact. There is no
artifact.

## 5. What is actually verifiable about the boundary today

| property | state | checkable by a machine? |
|---|---|---|
| routes served by Node in a default config | **0 of 38** | yes — parse `server.mjs` |
| routes Node *can* serve | 2 of 38 | yes |
| pairs with an executable check | 25 of 38 (fixtures ∪ parity), 38 contracted | yes |
| operations with a validated response schema | 23 of 38 (15 `x-unvalidated`) | yes |
| rollback artifact exists | **no** | yes — grep the workflows |
| ADR-0022 accepted | **no**, Proposed | yes |
| P1.7 signed | **no** | **no — that is the point of a signature** |
| P4.1 approved | **no** | no |

Six of the eight are mechanically decidable. Two are not, by design.

## 6. Zero users, and login is off

There are no learners. The login surface is disabled by owner instruction and stays disabled until
they say otherwise. So a cutover would move zero traffic and expose zero users — which removes the
urgency, and also removes most of the evidence a security reviewer would want (there is no production
behaviour to observe).
