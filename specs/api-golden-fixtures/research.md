# Research — golden API fixtures from the Rust service

**Phase 5 of** `specs/flutter-node-migration/plan.md`. Read-only; no code written.
**Measured at** main `964ffef`.

The first phase that is *migration work* rather than preparation. It produces the behavioural
baseline every later phase is checked against — without it, the Node port is verified against
someone's memory of what the Rust service did.

---

## 1. The surface to capture

**33 distinct paths, 38 method+path entries**, plus 3 infrastructure routes.

```
/health  /ready  /metrics

/v1/auth/login   /v1/auth/register   /v1/auth/token
/v1/recitation-sessions            /v1/recitation-sessions/{id}
/v1/recitation-sessions/{id}/alignments
/v1/recitation-sessions/{id}/request-teacher-review
/v1/learners/active                /v1/learner/progress   /v1/learner/progress/weekly
/v1/quran/surahs                   /v1/quran/surahs/{surah_number}
/v1/quran/ayahs/{surah_number}/{ayah_number}
/v1/tajweed-findings               /v1/teacher-reviews    /v1/teacher-review-queue
/v1/scholar-approvals              /v1/agent-runs         /v1/audit-events
/v1/eval-runs/{model_version}
/v1/ml/alignments:predict          /v1/ml/tajweed-findings:predict
/v1/asr/transcribe                 /v1/asr/force-align
/v1/privacy/export                 /v1/privacy/delete
/v1/realtime-session-tickets
/v1/pilot/invitations   /v1/pilot/session/bootstrap   /v1/pilot/session/logout
```

Note `/v1/ml/alignments:predict` — a **colon in the path segment**. Any capture or replay tooling
that naively uses paths as filenames, or that re-encodes URLs, will corrupt these. Worth knowing
before, not after.

---

## 2. 🔴 The central difficulty: almost every response is non-deterministic

Fixtures are only useful if a re-run produces the same bytes. Measured across
`services/platform-api/src/handlers/*.rs`, the fields that vary run-to-run:

| Field | Occurrences | Why it varies |
|---|---|---|
| `trace_id` / `traceId` | 9 | per-request |
| `id` | 8 | generated per row |
| `auditEventId` | 4 | generated |
| `token` | 4 | JWT — embeds `exp`, and the signature changes with it |
| `sessionId` | 3 | generated |
| `startedAt`, `nextReviewAt` | 3 | wall-clock |
| pilot `csrfToken` | — | random per session |

**So a naive capture produces fixtures that fail on the second run** — including against the Rust
service that generated them. The normalization layer is not a refinement; without it there is no
usable artifact at all.

The right shape: replace volatile values with typed placeholders (`<UUID>`, `<ISO8601>`, `<JWT>`)
while asserting the *shape* (present, correct type, matching a pattern). That keeps the fixture
strict about everything that is genuinely contractual and silent about what cannot be.

---

## 3. What must be captured byte-exactly (and is easy to lose)

### 3.1 `POST /v1/auth/token` returns **snake_case**

`handlers/auth.rs` returns `token`, `user_id`, `tenant_id`, `role`, `audit_event_id` — the **only**
snake_case body in an otherwise camelCase API. A Node port using a global camelCase serializer
silently breaks every caller of this route, and a fixture that normalizes key casing would not
catch it. **Key casing must be part of the comparison.**

### 3.2 The error envelope is a closed set

`types.rs:334` defines `ApiError` with a fixed variant list and `:375` maps each to a status:
`Unauthorized`→401, `Forbidden`→403, `NotFound`→404, `MissingSources`/`HighRiskApproval`/
`BadRequest`→400. The `#[error(...)]` strings are the wire messages — e.g.
*"source references are required for scholar-approved content"*.

These strings are part of the contract. A Node port that returns a different message for the same
condition is a behavioural change even though the status matches, and clients may match on them.

`UpstreamUnavailable` is documented as deliberately generic so upstream topology never leaks —
**a port that "improves" that message by adding detail is a security regression**, not a fix.

### 3.3 Status-code subtleties already documented in the code

- `/metrics` returns **404, not 401**, when the token is wrong — hides the endpoint's existence.
- `maintenance_mode` returns **503** for app routes while `/health`, `/ready`, `/metrics` stay 200
  (proven in the Phase 4 T3 drill).
- CORS headers must be present **on error responses too** (429/503), which is why CORS is the
  outermost layer.

None of these survive a capture that only records happy-path 200s.

---

## 4. What already exists

`scripts/smoke-api.mjs` (377 lines) already drives the API over `fetch` with a configurable base
URL and checks statuses. It **asserts**; it does not **capture**. Its request-construction and
auth-header handling are directly reusable, and reusing them keeps one definition of "how you call
this API" rather than two that can drift.

The `scripts/release-*.mjs` family shows the house style for evidence artifacts: canonical JSON,
SHA-256 digests, strict schema assertions. Golden fixtures should look like they belong to that
family.

---

## 5. Auth modes — three, and all three need coverage

`auth.rs` `resolve_actor` resolves in a fixed order: **Bearer JWT → `__Host-` pilot cookie → dev
headers** (gated by `ALLOW_HEADER_AUTH`). Each produces different behaviour on the same route:

- JWT: normal path.
- Pilot cookie: role pinned to Learner, Origin allowlist enforced, CSRF digest checked on mutating
  verbs.
- Dev headers: only when explicitly enabled; **must 401 when disabled** — that is a shipped security
  control (P1.5) and belongs in the fixture set as an expected-401 case.

Capturing only one auth mode would leave the Node port free to get the other two wrong.

---

## 6. Ordering and coupling

Many routes need prior state: a session must exist before alignments can be persisted; an
invitation must be minted before a pilot bootstrap. So the capture is a **scripted scenario**, not
an independent sweep of 38 endpoints — and the scenario order is itself part of what gets recorded.

`create_session` writes audit → consent → session inside one transaction, in an order forced by
foreign keys. A capture that fabricates rows directly in SQL rather than going through the API
would miss that ordering entirely.

---

## 7. Open questions for the plan

1. **Where do fixtures live?** `specs/api-golden-fixtures/` alongside the spec, or `packages/` so a
   future Node/Dart implementation can consume them as a dependency? The MIG3 corpus set a
   precedent (`packages/contracts/fixtures/`).
2. **Are fixtures gated in `verify.sh`?** Re-running them against the Rust service on every gate run
   would catch accidental API changes immediately — valuable, but it needs a live DB, so it would
   be DB-gated like the integration tests.
3. **Redaction:** `/v1/privacy/export` returns learner data by construction. Fixtures must use
   seeded synthetic learners only, and that must be enforced rather than assumed — a fixture file
   containing real learner audio metadata would be a privacy incident committed to git.
4. **Body limits:** `/v1/asr/*` accept 16 MB where the global limit is 2 MB. Capturing a real
   large-body case is impractical; capturing the *rejection* of an oversized body is both practical
   and more valuable.
