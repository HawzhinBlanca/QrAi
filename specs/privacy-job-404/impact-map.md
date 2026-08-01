# Impact map — privacy jobs 404

Scope as approved (option A). Under **B** the change is identical minus `create_privacy_export`
inheriting it, which is not actually separable — see §1.

---

## 1. Modified — one function, two endpoints

### `services/platform-api/src/handlers/privacy.rs` — `create_privacy_job`

**Callers, and this is the whole point:**

| caller | route | line |
|---|---|---|
| `create_privacy_export` | `POST /v1/privacy/export` | `privacy.rs:68` |
| `create_privacy_delete` | `POST /v1/privacy/delete` | `privacy.rs:76` |

Both delegate to the same private function with only a `PrivacyJobKind` differing.
`grep -n "create_privacy_job" services/platform-api` returns three hits: the definition and those
two. There is no third caller and no external one — it is not `pub`.

**So option B is not really a smaller change.** Fixing "delete only" would mean branching on `kind`
inside a function whose entire design is that the two kinds share everything except a flag.

### `specs/flutter-client/openapi.yaml`

**Callers: the `contract: openapi vs real responses` gate and
`tests/api-parity/lib/contract.mjs`.** Adding a `404` response to both operations is additive; the
existing `200` schema is untouched, so nothing that passes today can start failing.

## 2. New

| path | what |
|---|---|
| `specs/privacy-job-404/` | this spec |
| a test in `services/platform-api/tests/integration.rs` | in-process 404 assertion |
| assertions in `tests/api-parity/db-endpoints.test.mjs` | black-box 404 / 403 / 200 |

Two oracles on purpose: the integration test pins the handler, the parity test pins the wire.

## 3. Read, not modified

- **`erase_ml_audio`** — unchanged, and still called first. The existence check is a read inside the
  later transaction, so the documented "ML outage fails fast with the database untouched" property
  holds (`research.md §5`).
- **`require_self_or_any`** — unchanged and still first. This is what keeps 403 beating 404.
- **`services/platform-api/src/handlers/review.rs`** — read as the precedent for how this repo writes
  a tenant-scoped existence pre-check. The new code matches its shape deliberately.

## 4. Not touched

- The erasure cascade, its FK ordering, and the audit rows it writes.
- The `PrivacyJob` response shape.
- `apps/web`'s privacy self-service UI — it passes the signed-in learner's own id, so it cannot
  reach the changed branch.

## 5. Blast radius

| failure | who notices | contained by |
|---|---|---|
| **The check is placed before `require_self_or_any` and 404 starts leaking learner existence** | nobody — a 404 reads as normal | the authorization call stays the first statement; a parity assertion pins cross-learner as **403** |
| **A real erasure is refused because the check is wrong** — a legal obligation silently not met | **nobody, which is the worst case here** | the predicate is copied from the insert that follows it; a parity assertion pins an existing learner at 200 with the unchanged shape |
| Export starts 404ing where a caller expected 500 | a caller, immediately and correctly | that is the fix |
| The new test only passes because the fix is in | nobody | PJ2's acceptance requires it demonstrated red against the unfixed binary |

## 6. What has no mitigation

**This does not make erasure verifiable.** It changes an unknown learner from a 500 to a 404 and
nothing else. Whether a *successful* erasure actually removed everything is what
`privacy_delete_preserves_other_learners_teacher_reviews` and the audio-erasure tests cover, and
neither is touched here.
