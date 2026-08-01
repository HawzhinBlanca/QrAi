# Impact map — NUL byte 400

Scope as approved (option A).

---

## 1. Modified — one match arm

### `services/platform-api/src/types.rs` — `impl From<sqlx::Error> for ApiError`

**Callers: every `?` on a sqlx result in the service.** `grep -c "await?"` across
`src/handlers/` — this conversion is on essentially every database call, which is exactly why one arm
covers sixteen surfaces.

**That breadth is the risk and the reason.** A wrong condition here changes how *every* database
error is reported, so the arm must match one SQLSTATE exactly and fall through otherwise. The
existing `PoolTimedOut` arm sets the precedent and the shape.

Structurally safe: the arm is added **before** the catch-all `other => Self::Database(...)`, and
matches on `e.as_database_error().and_then(|d| d.code())`. Anything that is not `22021` reaches the
same catch-all it reaches today.

## 2. New

| path | what |
|---|---|
| `specs/nul-byte-5xx/` | this spec |
| `tests/api-parity/hostile-input.test.mjs` | the committed, trimmed sweep |
| a unit test in `types.rs` | the mapping itself, not only its effect through a handler |

**Both tests exist on purpose.** The unit test pins the mapping; the parity suite proves it reaches
the wire on real endpoints. Testing only through one handler would leave the other fifteen resting on
inference — which is how this class stayed open for three rounds already.

## 3. Read, not modified

- **`ApiError::Database`'s redaction** (`types.rs:388-…`) — the new arm does not touch it and does
  not forward Postgres text. Read to confirm the new message must be self-supplied.
- **`services/platform-api/src/handlers/**`** — no handler changes. Nothing validates NUL per-field,
  and nothing needs to.

## 4. Not touched

- **Any other SQLSTATE**, in particular `22003` — `research.md §5` explains why mapping it would have
  hidden the SM-2 overflow bug rather than surfacing it.
- **What any endpoint stores.** A NUL was never storable.
- **The HTTP boundary.** No middleware, no body re-walk.

## 5. Blast radius

| failure | who notices | contained by |
|---|---|---|
| **The match is too broad and a real server fault reports as 400** | **nobody — a 400 reads as the caller's problem, so a server bug becomes invisible** | one exact SQLSTATE, matched before the unchanged catch-all; the unit test asserts a non-22021 database error still maps to `Database` |
| The new message leaks table/constraint names | a reviewer, later | the arm supplies a fixed string and never forwards Postgres's; asserted |
| A legitimate request starts failing | nobody | impossible — the request already failed with a 500; this only relabels a failure |
| The regression net becomes a stale list of 16 cases | nobody, and the next endpoint ships the same gap | N2 asserts **no probe on any endpoint returns 5xx**, so it generalises instead of enumerating |

## 6. What has no mitigation

**681 probes is not a proof of exhaustiveness.** It is one battery of mutations over the shapes I
thought of. `research.md §3` says what was tried and held; it cannot say what was not tried.

**And the sweep is HTTP-level only.** It says nothing about the realtime gateway's WebSocket frames,
the ML/ASR services' own input handling, or anything reachable only after a successful upgrade.
