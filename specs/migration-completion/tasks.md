# Migration completion — Tasks

Scope approved 2026-08-01: **Q1 = F-A**, **Q2 = N7–N17 (all 36 routes)**, **Q3 = local
digest-pinned image tags**. See [`plan.md`](plan.md) §8 and [`research.md`](research.md).

**Task-ID prefixes `N7…N17`, `FL*`, `AR1`.** `scripts/update-ledger.sh` matches `- \[ \] <task> `
across **every** `specs/*/tasks.md`, so a collision would flip another spec's row. Checked against
the full existing set (`C*`, `CU1…CU4`, `F1…F5`, `FK*`, `G*`, `K*`, `MIG*`, `N1…N6`, `NB*`, `OC*`,
`P0.1…P7.6`, `PAR*`, `PJ*`, `S*`, `T*`): `N7`+, `FL*` and `AR1` collide with nothing.

**Ported ≠ enabled.** `NODE_API_PORTED ?? ""` stays empty for every task below, so `traffic-share`
remains UNMET and no production traffic moves. Enabling is a separate decision after a cutover drill.

**FL9 (iOS device + simulator) stays OPEN by construction** — no Xcode on this machine
(`research.md §1`). A green-looking substitute is not a result; `MIG5` and `CU2` set that precedent.

---

## Track N — route-by-route port

Every wave follows the same five steps (`plan.md §2`), and step 4 is not optional:

1. A/B parity case written **first**, against Rust, passing while still proxied.
2. Port using `withTenant` + `requireAnyRole`/`requireSelfOrAny`. No raw client.
3. Re-run the A/B ported: identical status, body bytes, headers.
4. **Mutate the port and watch the A/B go red.** A green that cannot go red is not evidence.
5. `bash scripts/verify.sh`, then `scripts/update-ledger.sh`.

- [x] N7 — Route table — 38 `if` blocks → one table + per-domain route modules; `PORTABLE` still parseable by `cutover-readiness.mjs`.
- [x] N8 — Infra routes — `/health`, `/ready`, `/metrics` (Prometheus text format, dev-open gate).
- [x] N9 — Quran routes — 3 read-only routes; canonical text byte-identical, digest-anchored, never normalized.
- [x] N10 — Progress writes — `POST /v1/learner/progress` + weekly; SM-2 arithmetic pinned to Rust.
- [x] N11 — Agent/audit/eval READS — `GET` agent-runs, audit-events, eval-runs; jsonb key order, f32 narrowing.
- [x] N18 — `POST /v1/agent-runs` — split out of N11: it carries the learner-facing AI gate (a
      server-side re-derivation of `canShowLearnerFacingAiOutput`) and is the ONLY place an agent
      run's status is set. Three reads and one security-critical write do not belong in one slice.
- [x] N12a — `POST /v1/auth/token` — JWT minting; admin/ops, DB-derived role, cross-verified with Rust.
- [ ] N12b — `register` + `login` — **BLOCKED on ADR-0025.** bcrypt has no stdlib equivalent and no
      existing dependency provides it, so these two routes need a new runtime dependency handling
      credentials. AGENTS.md requires an ADR; ADR-0025 is written and **Proposed**, awaiting the
      owner. Implementing first would be deciding it by writing code.
- [x] N13a — Pilot cookie AUTH path — the credential path every ported route shares; `__Host-` cookie
      parsing, Origin + CSRF gates, and the idle roll inside a tenant transaction.
- [x] N13b — Pilot ROUTES — `bootstrap`, `logout`, `invitations`; cookie attributes on the wire.
- [x] N14a — Recitation READS — `GET` sessions, session, alignments, active-learners; one jsonb column
      with TWO serialization rules in the same handler file.
- [x] N14b — Recitation WRITES — `create-session`, `persist-alignments`, `request-teacher-review`;
      consent capture, the FK-skip policy, and model-version provenance.
- [x] N15 — Review gates — 5 operations; AI feedback withheld absent source + confidence + approval.
- [x] N16 — ML/ASR proxies — 4 operations; server-side key injection, 16 MB limit.
- [x] N17 — Privacy — `export`, `delete`; erasure verified by querying storage, not by a 200.
- [x] N19 — **N-7's missing evidence.** The impact map named
      `tests/node-api/no-secret-logging.test.mjs`; no such file existed, so the one general criterion
      covering every ported route had nothing behind it. Written, and it found a real leak.

## Track F — Flutter client

### FL1 RESULT: SDK installed and working. Both device toolchains still blocked.

Evidence: [`evidence/fl1-flutter-doctor.log`](evidence/fl1-flutter-doctor.log), captured verbatim.

| category | verdict |
|---|---|
| **Flutter 3.44.8 / Dart 3.12.2** | ✅ `~/flutter`, user-space, no admin rights used |
| **Chrome (web)** | ✅ available as a run target |
| **macOS desktop** | ✅ available as a run target |
| **Android toolchain** | ❌ SDK 33.0.2 present, but `cmdline-tools` missing and licences unaccepted |
| **Xcode** | ❌ "installation is incomplete" — CLT only. CocoaPods present but non-functional |

So `dart analyze`, `flutter test`, and running the app on **macOS/Chrome** are all reachable here;
**building for iOS or Android is not**. `flutter doctor` says so in its own words, which is why the
log is committed rather than summarized. **FL9 stays open.**

> **FL2–FL8 were over-claimed, and this note is the correction.** Each row below is true as
> written, but read together they said "client" when what existed was a component library — no entry
> point, no host projects, no recorder, no socket. The owner's 2026-08-01 audit called it a P0 and
> was right. `AUD1` is the row that actually delivers an application; these are its parts. `FL7` in
> particular claims i18n, and the app has no ARB bundle: locales resolve RTL, the strings are
> English.

- [x] FL1 — Toolchain — Flutter SDK in user space; `flutter doctor` captured verbatim, gaps recorded.
- [x] FL2 — Package + contract — `apps/flutter` skeleton, Dart models + typed client from `openapi.yaml`.
- [x] FL3 — Secure auth — bearer tokens in Keychain/Keystore; never prefs, logs, or disk.
- [x] FL4 — Mushaf reader — Uthmani rendering, RTL, canonical bytes preserved end to end.
- [x] FL5 — Consent-gated capture — no audio stream constructed before consent is granted.
- [x] FL6 — Feedback surfaces — tajweed + progress; nothing rendered without source/confidence/approval.
- [x] FL7 — Privacy + i18n + a11y — export/delete, locale switching, semantics labels, contrast.
- [x] FL8 — Offline/error states — no stale data presented as live.
- [ ] FL9 — 🔓 Device matrix — **OPEN, and the reason changed on 2026-08-03.** Xcode is no longer
      absent: `/Applications/Xcode-beta.app` is installed but `xcode-select` still points at
      CommandLineTools, so `xcodebuild` and `simctl` do not exist. iOS/macOS is one owner-run
      command away (`sudo xcode-select -s /Applications/Xcode-beta.app/Contents/Developer` — note
      the BETA path; `flutter doctor` prints `Xcode.app`, which is not what is installed here).
      Android is separately blocked on missing `cmdline-tools` + unaccepted licences. Measured:
      [`evidence/fl9-blocked-2026-08-03.md`](evidence/fl9-blocked-2026-08-03.md).
      A simulator would still not be a phone, and would still not execute the recorder's
      hardware path.
- [x] FL10 — **F-7's missing evidence.** The impact map named a Dart contract test; none existed.
      Written as a Node test instead (`verify.sh` SKIPS every Flutter step without the SDK, so a
      Dart-side test would be skipped on CI — the one gate that matters). It found three contract
      defects, none of them in the client.

## Track AUD — the owner's audit, 2026-08-01

Five findings, all confirmed against the code before any of them was touched. Four were approved for
work; **AUD3 was not, and must not be closed by renaming fields** — see its row.

- [x] AUD1 — **A runnable Flutter app.** `apps/flutter` was 8 library files: no `main.dart`, no
      iOS/Android/web host projects, no recorder, no WebSocket. FL2–FL8 were marked done on
      components, which over-claimed what existed.
      **Delivered:** `main.dart` + a four-tab shell; iOS/Android/macOS/web host projects; a real
      `AudioRecorder` (PCM16 microphone → gateway WebSocket, ADR-0026); the practice flow that
      collects consent, creates the session, takes a ticket and streams; microphone permissions and
      entitlements on all four platforms. 78 Flutter tests (was 63).
      **Proven:** `flutter build web --release`, then the built bundle served and driven in a real
      browser — the reader's offline state and the consent form both rendered.
      **NOT proven:** anything on a phone. A web build is not device proof and `FL9` is untouched by
      this row. The recorder's *hardware* path has never executed: every test injects the PCM
      stream, so what is asserted is ordering and routing, not that a microphone opens.
- [x] AUD2 — Privacy request body — the client posted `{}` to two routes whose handler requires
      `learnerId`; both actions were a 422. The contract was wrong too: `/v1/privacy/delete` had no
      `requestBody` at all, so a client written from it would make the same mistake.
- [x] AUD4 — Node boot guard — port of `main.rs` `ensure_secure_config`. Node took
      `quran-ai-dev-secret`, `smoke-secret` and `smoke-ml-api-key` as defaults where Rust panics.
      Dormant at zero enabled routes; the point is that it is already there on enablement day.
- [x] AUD5 — No learner in a log line — `privacy.mjs` logged `tenant=` and `learner=`. Rust does the
      same at `privacy.rs:60` and is outside this spec's boundary, so this is a deliberate
      log-only divergence, recorded rather than quietly matched.

**AUD3 — learner tajweed feedback — BLOCKED on the owner, and not merely a field rename.**
`list_tajweed_findings` requires teacher/scholar/admin/ops, so a learner is 403'd before any
parsing; the field drift (`status`/`source` vs `reviewStatus`/`sources`) is the second failure
behind the first. There is no learner-scoped endpoint for this data. Creating one is a product
decision about what a learner may see of their own review queue, and inventing it here would be
deciding it by writing code — the same reasoning that holds `N12b`.

**2026-08-02 — measured against the running service, and it is wider than one route.** Probed with a
real learner bearer token:

| route | learner gets | gate |
|---|---|---|
| `GET /v1/tajweed-findings?sessionId=…` | **403** | teacher/scholar/admin/ops (`review.rs:253`) |
| `GET /v1/recitation-sessions/{id}/alignments` | **403** | teacher/admin/ops (`recitation.rs:445`) |

Both refuse with `{"error":"actor is not allowed to perform this action"}`. So **the practice flow
is write-only for a learner**: they consent, record and stream — the gateway acks every frame, see
[`evidence/live-gateway-e2e.md`](evidence/live-gateway-e2e.md) — and then there is no route by which
they can ever see what was heard. The app is honest about it today (the panel says "No reviewed
feedback yet"; the practice screen says the recitation was sent for review), but honest is not
complete.

Adding a client method for either route was considered and **rejected**: it would put a 403 in front
of every learner. `api_client.listTajweedFindings` carries that warning in its doc comment rather
than being deleted, so the learner-visibility gate in `tajweed_panel.dart` still has a caller the
day this is decided.

## Track A — cutover artifact

- [x] AR1 — Rollback artifact — ADR-0022 Accepted (local digest-pinned tags) + a workflow that builds, pins and retains images.

---

## Progress log

*(appended as tasks land; each entry states what was proven, not what was written)*

### 2026-08-01 — N7–N11 and FL1–FL2

**Track N: 11 of 36 routes ported, 13 of 38 portable, 0 enabled.**
`cutover-readiness.mjs` reports `Node serves 0 of 38 routes by default (13 portable)`.

Five wire divergences found by the A/B differ, every one of them **already shipping** in the two
routes ported before this spec (N4, N5) because nothing had ever compared a locally-served
response's headers or bytes against Rust's:

| # | divergence | wave |
|---|---|---|
| 1 | tower-http emits `vary` on every response; `@fastify/cors` only on preflights | N8 |
| 2 | axum's `Json` sets `application/json`; Fastify adds `; charset=utf-8` | N9 |
| 3 | `serde_json` writes a whole f64 as `100.0`; `JSON.stringify` writes `100` | N10 |
| 4 | a jsonb column round-trips through a **BTreeMap**, so its keys come back alphabetized | N11 |
| 5 | `EvalRun`'s metrics are **f32**: narrowed, then printed shortest-for-a-single | N11 |
| 6 | **caller checked AFTER the body was parsed** — Rust named its schema to anonymous callers | — |

**Divergence 6 — FOUND, then FIXED IN RUST.** In Axum a `Json<T>` argument is an extractor: it runs
before the handler function body, where `resolve_actor` and `require_any` live. So every Rust handler
with a JSON body parsed first and identified the caller second. With **no credentials at all**,
`POST /v1/pilot/invitations` answered *missing field `learnerId`*. **Sixteen routes**, measured — not
the six this entry first claimed.

Two corrections to that first write-up, both forced by measurement:

- It is not only *unauthorized* callers. An **unauthenticated** one — no headers whatsoever — got the
  same disclosure. That is the more serious half, and the first draft missed it.
- The four ML-proxy routes take an untyped `serde_json::Value`, which accepts `{}`. Probed with `{}`
  they looked correct; probed with `{` they leaked like the rest. A first pass reported them as
  already-fine — an artifact of the probe body, not a property of the code.

Fixed by taking `Result<Json<T>, JsonRejection>` — an extractor that **cannot** fail — and unwrapping
it after the caller checks (`types::JsonBody<T>`). Where authorization genuinely reads the body
(`require_self_or_any(&req.learner_id, ...)` in `create_session` and `create_privacy_job`) the order
is authenticate -> parse -> authorize; an anonymous caller is still refused before the parse.

Wire compatibility held exactly: **42 body-error responses (422 / 400 / 415) captured for authorized
callers before and after, diffed byte-for-byte, no change.** `ApiError::BodyRejection` carries axum's
own status and text verbatim rather than reconstructing them.

Found because the A/B differ cannot see it: the suite sends valid bodies as authorized roles and
invalid bodies as authorized roles. **Unidentified caller + invalid body** is the cell nobody wrote.
Now asserted on both implementations by `tests/api-parity/authz-matrix.test.mjs` with two body
shapes, because either one alone would have missed part of it.

Three bugs in **my own** work, each caught by the test written for it rather than by review:

- the f64 fix used a fixed sentinel → a learner-supplied string could be unwrapped into a JSON
  number (content injection). Now a per-call random nonce: impossible by construction.
- that nonce first contained a literal `U+0001`, which `JSON.stringify` escapes, so the unwrap
  regex could never match and the marker leaked onto the wire.
- two test expectations were fabricated rather than measured (a guessed f32 string, and an
  exact-representability premise that was the wrong discriminator). Both now assert properties.

**Mutations that ran GREEN, recorded as gaps rather than counted as coverage:**

- N9 — `??` instead of a truthiness check on `english_name`: no surah in this corpus has an
  *empty* name, so Rust's `.filter(|n| !n.is_empty())` branch is unreachable here.
- N11 — `f32()` replaced by `f64()`: for every seeded eval value the two formatters print the same
  string. Each has a premise test that fires the moment the data makes the branch live.

**Track F: the app compiles and is tested; it has never run on a phone.**
`dart analyze --fatal-infos` clean, 22 tests green, both wired into `verify.sh`. That gate covers
**analysis and headless tests only** — `FL9` is open and no device or simulator evidence exists.
