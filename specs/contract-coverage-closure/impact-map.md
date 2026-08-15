# Impact map — closing the two mechanical cutover gaps

Scope as approved (option A). Under **B**, §2's schema rows drop out. Under **C**, only §2.

---

## 1. New — no existing callers

| path | what | task |
|---|---|---|
| `tests/api-parity/db-endpoints.test.mjs` | the 5 database-backed pairs | C1 |
| `tests/api-parity/proxy-endpoints.test.mjs` | the 3 proxy pairs | C2 |

**Test-only. No production code changes at all** — that is the defining property of this change and
the reason its risk profile is unusual: the worst realistic outcome is a flaky test, not a broken
endpoint.

If a test finds a **defect**, that is a separate change with its own decision. It does not get fixed
quietly inside a coverage commit.

## 2. Modified

### `packages/contracts/openapi.yaml` (C3)

**Callers: `tests/contract/lib/openapi.mjs` → `compileResponseValidators()`, and the
`contract: openapi vs real responses` gate step.** Replacing `x-unvalidated: true` with a real schema
means that gate starts **enforcing** the shape — so a schema written slightly wrong turns the gate
red against a correct server.

That is the intended direction (a permissive schema asserts nothing), and it is why §3 of the plan
forbids writing one from anything but an observed response.

### `tests/contract/coverage.test.mjs` (C3)

Pins the `x-unvalidated` count so it can only shrink deliberately. The pin **moves down** and its
comment records what remains and why. Leaving the old number would fail; loosening the pin to a
`<=` would defeat it.

### `scripts/cutover-readiness.mjs` (C4)

**Comment only** on `coveredPairs()`, recording the method-blind match. No behaviour change —
`tests/contract/cutover-readiness.test.mjs` pins this function's logic, including
`summarise()` having no `ready` field, and none of that moves.

### `scripts/verify.sh` (C1, C2)

Two files added to the **DB-gated** parity line, not the fast lane. Protected file; needs the
`.codystem-allow-self-edit` sentinel, as PAR5, N1, F4, CU4 and S5 did.

## 3. Read, not modified

- **`tests/api-parity/lib/harness.mjs`** — `startApi`, `request`, `withDb`, `startMockUpstream`,
  `reservePort` are used as-is. If a new test needs a seam the harness lacks, that is a signal to
  stop and reconsider, not to widen the harness inside this change.
- **`specs/api-golden-fixtures/fixtures/platform-api.json`** — 26 steps, read as schema evidence.
  **Not regenerated.** Regenerating it is a different task with a different oracle.
- **`services/platform-api/src/**`** — read to find real shapes and role requirements. Not edited.

## 4. Not touched

- **`services/node-api/`** — `NODE_API_PORTED` stays empty; `traffic-share` stays UNMET.
- **The login UI and `POST /v1/pilot/session/bootstrap`.** Logout is covered on its **no-cookie**
  path only (`research.md §5`). Nothing mints a pilot session.
- **`P1.7` / `P4.1` / `ADR-0022` / `P5.5` / `P5.6`.**

## 5. Blast radius

| failure | who notices | contained by |
|---|---|---|
| **A schema is written from a guess and the contract gate enforces a fiction** | nobody — it goes green and *looks* like validation | plan §3: schemas only from observed responses; anything without evidence keeps `x-unvalidated` |
| A schema is subtly wrong | immediately — the contract gate goes red against a correct server | the gate itself, on the very next run |
| A new parity test asserts reachability but not authorization | nobody, and the gap stays open under a green tick | C1/C2 acceptance requires a 403-for-the-wrong-role assertion |
| A test is flaky against seeded data other suites mutate | intermittently, and flaky tests get ignored | assert shape and boundary, never seeded row counts |
| A real defect is found and quietly patched in-branch | a reviewer, later, in a commit that claims to be test-only | §1: a defect becomes its own change |

## 6. What has no mitigation

**`x-unvalidated` may not reach 0**, and this plan refuses to close the gap by inventing shapes. Any
remainder is named in `tasks.md` with the reason.

**Four checks plus a signature stay open** — `traffic-share`, `rollback-artifact`,
`adr-0022-accepted`, `operational-proof`, and `security-sign-off`. `cutover-readiness.mjs` will still
report **NOT READY** after this, and that remains the correct answer.
