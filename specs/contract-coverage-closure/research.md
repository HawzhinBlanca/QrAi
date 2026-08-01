# Research — closing the two mechanical cutover gaps

Measured against `25960bb` by running the repo's own tools, not by reading documents.

---

## 1. Where the cutover gate actually stands

```
$ node scripts/cutover-readiness.mjs
  UNMET        traffic-share                Node serves 0 of 38 routes by default
  UNMET        boundary-oracle-coverage     30 of 38 pairs have a fixture or parity test; 8 have neither
  UNMET        response-schemas-validated   23 of 38 operations validated; 15 marked x-unvalidated
  UNMET        rollback-artifact            no workflow builds or pushes an image (ADR-0022)
  UNMET        adr-0022-accepted            ADR-0022 is Proposed
  UNMET        operational-proof            P5.5 / P5.6 open
  NEEDS-HUMAN  security-sign-off            P1.7 / P4.1
```

**Only two of these are engineering work.** `traffic-share` is a deliberate default (`NODE_API_PORTED`
is empty on purpose); `rollback-artifact`, `adr-0022-accepted` and `operational-proof` need an owner
decision and infrastructure; the last needs a signature.

## 2. The 8 pairs with no oracle at all

| method | path | what it needs |
|---|---|---|
| `GET` | `/v1/quran/surahs/{surah_number}` | nothing — **no auth**, reads `canonical_ayahs` (`quran.rs:80`) |
| `GET` | `/v1/eval-runs/{model_version}` | admin/ops; a seeded row exists (`0006_seed_internal.sql`) |
| `GET` | `/v1/audit-events` | staff role |
| `POST` | `/v1/teacher-reviews` | a real `finding_id`; seeded findings exist |
| `POST` | `/v1/ml/tajweed-findings:predict` | the harness's `startMockUpstream()` |
| `POST` | `/v1/asr/transcribe` | a mock upstream on `ASR_INFERENCE_URL` |
| `POST` | `/v1/asr/force-align` | same |
| `POST` | `/v1/pilot/session/logout` | **nothing** — see §5 |

Every one is reachable with machinery the parity harness already has.

## 3. The 15 `x-unvalidated` operations, and the overlap

```
POST /v1/auth/register                                  GET  /v1/agent-runs
GET  /v1/quran/surahs/{surah_number}            ←       GET  /v1/audit-events                  ←
GET  /v1/recitation-sessions/{id}/alignments            GET  /v1/eval-runs/{model_version}     ←
POST /v1/recitation-sessions/{id}/alignments            POST /v1/privacy/delete
POST /v1/recitation-sessions/{id}/request-teacher-review POST /v1/pilot/session/logout         ←
POST /v1/learner/progress                               POST /v1/ml/tajweed-findings:predict   ←
POST /v1/teacher-reviews                        ←       POST /v1/asr/transcribe                ←
                                                        POST /v1/asr/force-align               ←
```

**All 8 of the uncovered pairs (marked ←) are also unvalidated** — corrected from "7" after computing
the set intersection rather than counting by eye. Every endpoint with no oracle also has no schema,
which is not a coincidence: both gaps have the same cause, which is that nothing ever observed a
response from these routes.

So writing a parity test for those 8 produces the response evidence a real schema needs, and the
remaining **7** must be served by evidence that already exists — or they stay `x-unvalidated`,
honestly.

## 4. 🟠 The coverage metric is method-blind — a latent looseness, not a live defect

`coveredPairs()` (`scripts/cutover-readiness.mjs:155`) matches a fixture on `METHOD + path-shape`,
but matches the parity suite on **path shape for any method**. So exercising `GET /v1/scholar-approvals`
would mark `POST /v1/scholar-approvals` covered too.

**I checked whether that is currently overstating anything. It is not.** Of the 30 covered pairs, 19
match a fixture with the exact method, and the other **11** rely on the shape rule:

```
POST /v1/auth/register                    GET  /v1/scholar-approvals
GET  /v1/recitation-sessions/{id}/alignments  POST /v1/scholar-approvals
POST /v1/recitation-sessions/{id}/alignments  GET  /v1/agent-runs
POST /v1/recitation-sessions/{id}/request-teacher-review   POST /v1/privacy/delete
POST /v1/realtime-session-tickets         POST /v1/learner/progress
POST /v1/ml/alignments:predict
```

**All 11 are genuinely exercised with the correct method.** I nearly reported
`POST .../request-teacher-review` as uncovered — my first scan missed it because
`default.test.mjs:464` builds the path into a variable before calling `request()`. It is exercised.

So the number is honest **today**, and the metric would not notice if it stopped being. That is worth
recording; it is not worth a red flag.

## 5. `POST /v1/pilot/session/logout` is testable without touching login

`pilot.rs:142-207`: with **no** `__Host-qrai-pilot` cookie the handler skips the revocation block
entirely and returns `200 {"status":"logged_out"}` plus a `Set-Cookie` that clears the cookie
(`Max-Age=0`). Idempotent logout.

**Nothing here mints a session, and nothing re-enables the login UI**, which stays disabled by the
owner's standing instruction. Covering the no-cookie path is the whole endpoint minus the branch that
requires a session to exist.

## 6. What the parity harness already provides

`tests/api-parity/lib/harness.mjs`: `startApi({env})`, `request()`, `withDb()`/`queryJson()`,
`startMockUpstream()`, `reservePort()`. `ml-proxy.test.mjs` already mocks an upstream and asserts the
proxy's status/tenant behaviour, so the three proxy routes in §2 are an extension of an existing
pattern rather than new machinery.

`specs/api-golden-fixtures/fixtures/platform-api.json` records 26 steps with **real response bodies**,
placeholder-normalised (`"<ID:audit#2>"`). That is exactly the evidence a validated schema needs.

## 7. What this cannot do

Closing both checks leaves **four** UNMET plus the signature, so
`scripts/cutover-readiness.mjs` still reports **NOT READY**. The value is the coverage itself —
`/v1/audit-events`, `/v1/teacher-reviews` and the two ASR proxies are security-relevant endpoints
with no black-box assertion today — not the counter moving.
