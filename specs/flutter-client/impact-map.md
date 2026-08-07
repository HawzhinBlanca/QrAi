# Impact map — Phase 8: the Flutter client (option A, contract layer)

Under **B** this list grows by a `apps/flutter/` tree and an installed SDK. Under **C** it grows by a
whole client. Both are blocked on toolchain this machine does not have (`research.md §6`).

---

## 1. New — no existing callers

| path | what | task |
|---|---|---|
| `packages/contracts/openapi.yaml` | the hand-authored 3.1 contract for all 34 pairs | F1 |
| `tests/contract/openapi-coverage.test.mjs` | asserts every route in `lib.rs` appears exactly once | F1 |
| `tests/contract/validate-responses.mjs` | replays fixtures + parity responses through `ajv` | F2 |
| `specs/flutter-client/evidence/` | F2's divergence record | F2 |
| `packages/contracts/fixtures/*.json` (extended) | Dart-readable golden vectors | F3 |

## 2. Modified — real callers

### `scripts/verify.sh` (F4)

**Callers: everything** — CI, both `.claude/settings.json` hooks, `AGENTS.md:24`, `README.md:70`.
One hermetic step on the explicit-path line for F1/F3; F2 is **DB-gated** (it needs a live service),
so it belongs in the `:146-177` block next to the parity suite — the same placement rule PAR5
established.

Behind the CODYSTEM PreToolUse guard; needs the `.codystem-allow-self-edit` sentinel, as PAR5 and N1
did. Audited and visible.

### `packages/contracts/tests/platform-contracts.test.ts` (F3)

**Callers: the `test: ts` gate step.** MIG3 already converted this suite to consume
`fixtures/canonical-gates.json` rather than hardcoded literals, so F3 extends an existing pattern
rather than introducing one. Adding a vector that a UTF-16 byte source gets wrong must not change any
existing assertion — if it does, that is a finding, not a merge conflict.

### `package.json` / `pnpm-lock.yaml`

`ajv` + `ajv-formats`, and `openapi-typescript` as a devDependency. Three packages into the
`pnpm audit` supply-chain gate that went repo-wide red on GHSA-r28c-9q8g-f849 (MIG5). `quicktype` is
**not** added — it is only needed once a Dart runner exists.

### `docs/DECISIONS.md`

An ADR for OpenAPI 3.1 as the contract source of truth, and for the precedence rule in §6 of the
plan: **fixtures are authoritative for values, the spec for shapes.** Without that written down, the
first disagreement gets resolved by whoever edits fastest.

## 3. Read, not modified — and this is the part that must not slip

`specs/api-golden-fixtures/fixtures/platform-api.json` and `tests/api-parity/**` are the oracles F2
validates the spec *against*. **The spec must never be edited to make a fixture pass, and a fixture
must never be edited to make the spec pass.** An oracle adjusted to agree with the thing it measures
has stopped measuring.

`services/platform-api/src/lib.rs` gains a second parser (F1's coverage test), alongside PAR6's
existing one on `integration.rs`. Same deliberate coupling, same consequence: adding a route fails
the gate until it is contracted. Documented at the top of the test with the one-line fix.

## 4. Not touched

- `apps/web`, `apps/mobile` — no client changes.
- `services/**` — no production code. F2 only *reads* live responses.
- `infra/migrations/**` — no schema change.

## 5. Blast radius

| failure | who notices | contained by |
|---|---|---|
| The spec disagrees with reality and is "fixed" by editing a fixture | **nobody — the oracle silently degrades** | §3's precedence rule, in an ADR, plus F2 committing its divergence record |
| A route is added without a contract entry | every PR | F1's coverage test |
| F2 needs a live service, so it skips where none runs | a green gate that validated nothing | DB-gated placement + the PAR5 rule: no Postgres → SKIP; missing spec or validator → **FAIL** |
| Three new dependencies | `pnpm audit`, on some future advisory | pin forward, as #261 did |

## 6. What has no mitigation

**Option A produces no evidence about Flutter.** It does not tell you whether the mushaf renders
better, whether the audio path works on iOS, or whether the 12–20 week estimate is real. Those
questions need a machine with Xcode, and this one does not have it. Recording that as BLOCKED is the
only honest handling — the ledger row for the Flutter client stays **open**.
