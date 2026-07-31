# Impact map — Phase 9: cutover (option A, machine-checked readiness)

Under **B** this would list routing, DNS, deployment and rollback changes. B is blocked, so it does
not.

---

## 1. New — no existing callers

| path | what | task |
|---|---|---|
| `scripts/cutover-readiness.mjs` | evaluates every mechanical precondition against the repo | CU1 |
| `tests/contract/cutover-readiness.test.mjs` | asserts the checker DETECTS change, and that `NEEDS-HUMAN` never counts as MET | CU2 |
| `specs/cutover/boundary.md` | the security-review package for P1.7 | CU3 |

## 2. Modified

### `scripts/verify.sh` (CU4)

**Callers: everything** — CI, both `.claude/settings.json` hooks, `AGENTS.md:24`, `README.md:70`.
Behind the CODYSTEM guard; needs the `.codystem-allow-self-edit` sentinel, as PAR5, N1 and F4 did.

Two additions, and the distinction is the point:

- **CU2 is a real test** on the hermetic explicit-path line — the checker's own logic must be correct.
- **CU1 is informational and must NEVER fail the gate.** "Not ready to cut over" is the correct and
  expected state, not a build break. A gate that went red because a cutover has not happened would be
  noise, and noise gets silenced — which is how the one signal that mattered would be lost.

## 3. Read, not modified — five new couplings, each deliberate

`cutover-readiness.mjs` derives its answers from files it does not own:

| read | what breaks it | why that is correct |
|---|---|---|
| `services/node-api/server.mjs` | renaming `PORTABLE` | the served-route count must come from the code, not a note |
| `specs/flutter-client/openapi.yaml` | schema edits | coverage must be counted, not remembered |
| `docs/DECISIONS.md` | ADR-0022's status line moving | the accepted/proposed distinction is the whole check |
| `specs/readiness-recovery-10-10/tasks.md` | P1.7/P4.1 row text changing | those rows ARE the gate |
| `.github/workflows/` | an image build appearing | that is the rollback artifact, and its appearance should flip the verdict |

Each is a parse of someone else's file, so each can silently under-report — the exact failure Phase 8
found in Phase 7's route parser (`axum::routing::<verb>(` missed five chained registrations). **CU2
therefore asserts change-detection, not just current values**: a checker that reads the right file
and extracts the wrong thing looks identical to a correct one until something moves.

## 4. Not touched

- `services/node-api/server.mjs` — `NODE_API_PORTED` stays empty. No routing change.
- `services/platform-api/**`, `services/realtime-gateway/**` — no production code.
- `docker-compose.yml`, `.github/workflows/**` deployment steps — no new infrastructure.
- `specs/readiness-recovery-10-10/tasks.md` — **P1.7 and P4.1 stay open.** Flipping either is
  precisely the fabricated sign-off this phase exists to refuse.

## 5. Blast radius

| failure | who notices | contained by |
|---|---|---|
| **The checker is read as a verdict rather than a state** | nobody, until someone cuts over on its say-so | CU1 cannot print GO by construction; CU2 pins that `NEEDS-HUMAN` ≠ MET |
| A parse under-reports and readiness looks better than it is | nobody | CU2's change-detection tests |
| `boundary.md` cites deleted files | a reviewer, mid-review, with no way to tell what else is stale | CU3's test asserts every reference resolves |
| CU1 fails the gate on a normal day | every PR, and then it gets silenced | CU1 is informational by design (§2) |

## 6. What has no mitigation

**Option A does not move the phase forward.** It makes the distance measurable and hands a reviewer
the material to judge it — but P1.7 and P4.1 need a security reviewer, ADR-0022 needs an owner
decision, and the Node service needs 36 more routes before "cutover" is even a coherent word here.

None of that is fixable by writing more code, and this plan should not be read as if it were.
