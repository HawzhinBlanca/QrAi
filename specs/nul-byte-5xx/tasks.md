# A NUL byte is a 400, not a 500 — Tasks

Scope approved 2026-08-01: **option A** — map the NUL-byte SQLSTATEs only. See [`plan.md`](plan.md) §4.

Follows `specs/fk-surface-sweep/`, which stated its own limit: *"this sweep covers the FK surface,
not every possible 500."*

**Task-ID prefix `N`** — reusing `node-backend-port`'s `N1/N2` would collide, so these are `NB1–NB3`.
Checked against `C*`, `CU*`, `F*`, `FK*`, `K*`, `MIG*`, `N*`, `OC*`, `P0.1…P7.6`, `PAR*`, `PJ*`,
`S*`, `T*`.

---

## The sweep

**681 hostile-input probes** across 17 write endpoints and 10 parameterised reads: malformed body
shapes, per-field substitutions (14 values × every field), path traversal, and numeric overflow.

**16 produced a 5xx. All 16 were one cause.**

## 🟢 The more useful half of the result

Everything else held, on every endpoint:

| tried | outcome |
|---|---|
| 100 000-character strings | accepted — columns are unbounded `text` |
| `i32::MAX + 1`, 21-digit integers, negatives | clean 4xx, no overflow |
| `1e308`, `-2147483649` | clean 4xx |
| lone surrogates, RTL overrides, NFC-unstable Arabic | handled cleanly |
| `'; DROP TABLE users; --` | inert, as parameterised queries make it |
| 200-deep nesting, arrays/scalars/`null` where an object belongs | clean 422/400 |
| `../../etc/passwd`, percent-encoded traversal | clean 4xx |

A reviewer should read this as the substantive finding: **the input surface is otherwise sound**, and
the one gap was a single character class. That evidence did not exist before and is now committed.

---

## NB1 — Map the NUL SQLSTATEs to a 400

`services/platform-api/src/types.rs`, `From<sqlx::Error>` — beside the `PoolTimedOut` → 503 arm that
already exists for exactly this reasoning ("load, not a fault" → "input, not a fault").

**Corrected while implementing: there are TWO codes, not one.** The plan said `22021` only, written
before measuring that the same byte produces a different code depending on column type:

| code | name | column |
|---|---|---|
| `22021` | `character_not_in_repertoire` | `text` — *invalid byte sequence for encoding "UTF8": 0x00* |
| `22P05` | `untranslatable_character` | `jsonb` — *unsupported Unicode escape sequence* |

After the first fix, 15 of 16 surfaces returned 400 and **one still 500'd** —
`POST /v1/agent-runs` with the NUL inside `sources`, which is `jsonb`. Same defect, same
caller-supplied byte, different storage type. Adding `22P05` completes the approved fix rather than
widening it; both satisfy the plan's own test — *the one code the server can never itself produce*.

- [x] NB1 — Map — one arm, two SQLSTATEs, ahead of the unchanged catch-all.

---

## NB2 — Prove all 16, and pin what already holds

`tests/api-parity/hostile-input.test.mjs` (4 tests, 30+ probes). Run **red against the unfixed
binary** — all 16 listed by name in the failure output.

**The regression net is the half that will age well.** The NUL cases prove today's fix; the
"still holds" cases are what make a future 500 anywhere in this surface a *test failure* rather than
a *discovery*. Nothing else in the repo asserts that a 100 000-character name or a 21-digit surah
number is handled.

**And the final test generalises**: it asserts *no probe on any endpoint returns 5xx*, so a new
endpoint with the same gap fails without anyone remembering to add a case.

`types.rs` also gains a unit test on the mapping itself. Its important half is the **negative** case:
`22003`, `22001`, `23505`, `23503`, `42P01` and `40001` must all still be 500s. Testing only through
one handler would have left the other fifteen resting on inference.

- [x] NB2 — Coverage — Red first; the mapping unit-tested in both directions.

---

## NB3 — Contract

`400` added to **8** operations — only those with evidence in `hostile-input.test.mjs`. Operations I
did not probe (`GET /v1/scholar-approvals`, `GET /…/alignments`, `GET /v1/learner/progress`) were
deliberately left alone: adding an unverified status is the same fabrication `x-unvalidated` exists
to make countable.

- [x] NB3 — Contract — 8 operations, each with a probe behind it.

---

## Findings

### 1. One bug wearing sixteen faces

The temptation with 16 failing endpoints is 16 fixes, or a validation helper called from 16 places —
and the next endpoint would ship the gap again. One arm in the error conversion covers all of them
**and every future one**, because the conversion sits on essentially every `await?` in the service.

### 2. The plan was wrong about the SQLSTATE count, and the test said so

`22P05` was invisible until 15 of 16 turned green and one did not. Had the coverage been written
after the fix — or scoped to a handful of representative endpoints — the `jsonb` path would have
shipped still 500ing, and the spec would have claimed it was fixed.

### 3. Mapping the whole of class 22 was the attractive wrong answer

Class `22` is "Data Exception", so mapping all of it to 400 reads as principled. But `22003`
numeric_value_out_of_range is exactly how the SM-2 `interval_days` overflow surfaced (`1675d62`) —
a **server** bug. As a 400 it would have read as the caller's fault and been ignored. The negative
half of the unit test exists to keep that decision from eroding.

---

## Not done

- **681 probes is not a proof of exhaustiveness.** It is one battery of mutations over the shapes I
  thought of. The table above says what was tried and held; it cannot say what was not tried.
- **HTTP only.** Nothing here covers the realtime gateway's WebSocket frames, the ML/ASR services'
  own input handling, or anything reachable only after a successful upgrade.
- **No other SQLSTATE was remapped**, deliberately — Finding 3.
