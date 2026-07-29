# QrAi — Flutter + Node.js Migration: Full E2E Plan

**Status:** PROPOSED. **Decision (Flutter frontend + Node.js backend) is made by the owner** — this
document plans it properly rather than re-litigating it.
**Basis:** 14-agent parallel audit of the real repo at `e0f37c1` — 177 inventory items, 54 adversarial
findings, 12 blockers, across security / correctness / delivery / Quranic-domain lenses.
**Every claim below is measured or executed, not recalled.** Where I verified something personally it
says so.

**Scope of this approval round:** `specs/flutter-node-migration/tasks.md` **MIG1–MIG5 only**
(Phase 1–2 discovery + fixture work). Approving this line authorizes that scope — not Phase 3's
schema-breaking corpus rework and not phases 5–9, which need their own plan once MIG1's evidence and
the owner/scholar/SRE assignments in `P0.1` exist.

**Approved-by:**

---

# PART 0 — STOP: three live bugs, found while planning

These are **defects in the product today**. None is caused by the migration; all three are made
*worse* by it, because a rewrite faithfully copies bugs into two more languages. **Fix before porting
anything.**

## 0.1 🔴 The Arabic normalizer destroys every Arabic letter — VERIFIED BY EXECUTION

`services/asr-inference/forced_align.py:21`

```python
_DIACRITICS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ﻿]")
```

Two ranges **overlap**: `U+0610–U+064B` and `U+061A–U+0670`. Their union `U+0610–U+0670` swallows the
entire Arabic **letter** block `U+0621–U+064A`.

I ran the shipped code:

```
_strip_diacritics("بِسْمِ ٱللَّهِ ٱلرَّحِيمِ")  →  ' ا ا'
```

Every letter gone. `align_words()` then falls through to `vocab.get("<unk>")` for **every word**, so
**word-level forced alignment currently returns fabricated timings.** `docs/ROAD_TO_1_TASKS.md` claims
~64 ms MAE against Quran.com ground truth — that measurement cannot be true with letters stripped.

The sibling JS normalizer (`services/ml-inference/alignment.js:5-19`) uses a *different* and correct
class. This is a literal character-by-character transcription that reordered the range endpoints —
**exactly the failure mode a Rust→Node→Dart port multiplies.**

**Fix:** correct the character class, and add `assert _strip_diacritics("بِسْمِ") == "بسم"`.

## 0.2 🔴 4,578 of 82,456 "words" are silent symbols — VERIFIED BY COUNTING

Measured across `packages/quran-data/src/data/full-quran/*.json`: **4,578 mark-only tokens**
(waqf `U+06D6–U+06DC`, sajdah `U+06E9`, rub'-el-hizb `U+06DE`) carry real canonical word ids
`surah:ayah:index`.

Al-Baqarah 2:2 ships as 9 "words" — two of which (`2:2:5`, `2:2:7`) are muanaqah pause marks. 7:206
ends with `۩` as its own word.

`QuranReader.tsx:73-89` renders each as a tappable `<button aria-label="{{text}} {{status}}">`, and
they are fed to the CTC aligner.

**Consequence:** learners are scored on symbols they must never recite — marked "missed" on a sajdah
sign — and the aligner must find audio for 4,578 silent tokens, dragging adjacent word timings off.

**This is the true critical path.** A Flutter per-word mushaf built on this corpus is rework by
construction. Re-deriving `canonical_words` is a **schema-breaking data migration** (word ids,
timings, and the `word_alignments` / `tajweed_findings` / `teacher_reviews` rows that FK into them):
**4–6 weeks**, and it must happen before any new client renders words.

## 0.3 🔴 RLS has never actually executed — and this corrects what I told you earlier

I told you an hour ago that RLS "fails closed, good design, survives the rewrite." **The design is
real. It has never once been exercised.**

- `.github/workflows/ci.yml:14` — `POSTGRES_USER: hawzhin` (the container's **superuser**)
- `.github/workflows/ci.yml:26` and `scripts/verify.sh:28` — both connect as that role
- `begin_tenant_tx`'s own doc comment (`lib.rs:449-451`) admits it: *"In dev the connection role is a
  superuser (RLS bypassed), so this is a no-op there."*

So all 16 tenant policies are **inert in every environment where they have been tested**, and
`infra/sql/rls-app-role.sql` is applied but never used by the suite.

**Fix first, before a line of Node exists:** switch CI to `quran_ai_app`, run the existing Rust suite,
and repair the fallout. The security audit estimates **2–3 weeks of pure discovery** — inert writes
like the pilot idle-roll will surface, each needing a product decision. Doing this *after* the port
means you can never tell whether a failure is the port's fault or was always there.

## 0.4 🟠 No Unicode normalization contract — 92.5% of the corpus is NFC-unstable

Measured: **5,771 of 6,236 ayahs change under `.normalize("NFC")`.** Dominant transform is canonical
shadda reordering `U+0651 U+064E → U+064E U+0651` (14,622 occurrences, because shadda ccc=33 vs fatha
ccc=30). A second changes *character count*: `U+0627 U+0653 → U+0622` (2,178).

`services/asr-inference/server.py:626-632` explicitly depends on the raw, un-normalized order.

Adding Dart as a fourth runtime over text with **no declared normal form** is the migration's single
largest correctness hazard. Any layer that normalizes — Swift/Foundation across a platform channel,
Postgres `normalize()`, a JSON library — silently stops the tajweed detectors firing and breaks every
canonical checksum.

**Fix:** declare **NFC-forbidden / byte-exact-as-shipped** an explicit invariant in `AGENTS.md`, pinned
by cross-runtime golden vectors (ayahs as explicit codepoint arrays) asserted identically in TS,
Python, Node and Dart.

---

# PART 1 — Delivery reality (the brutal part you asked for)

| Fact | Measured value |
|---|---|
| Engineers on this repo | **1** (`git shortlog -sne`: 352 + 14 commits, one human) |
| Repo age | **~1 month** (first commit 2026-06-30, HEAD 2026-07-29, 366 commits) |
| Users | **0**. Pilot never run (`docs/pilot-report-2026-06-28.md:60`) |
| Readiness ledger | 17 of 51 closed |
| **Total migration effort** | **45–70 engineer-weeks** |
| **Calendar time for one developer** | **11–17 months** |

Component estimates, from measured LOC and independently produced by four lenses:

| Area | Engineer-weeks | What drives it |
|---|---|---|
| Backend Rust→Node | **18–30** | Not the 4,705 LOC — porting 34 routes is ~4 weeks. It's the **3,881-line / 79-test** integration suite, which must be ported *first* (it is the only executable evidence for most security controls), plus §0.3 discovery |
| Qur'an-correctness slice | **14–20** | §0.2 corpus rework (4–6w) + §0.4 normalization contract + tajweed re-validation. **Excludes** the Flutter UI itself |
| Flutter client | included above/below | Mushaf, audio, auth, i18n, a11y from zero |
| **Total** | **45–70** | |

## 1.1 The ledger goes backwards

The rewrite **voids ~10 of the 17 closed items**, taking the ledger from **17/51 (33%) to ~7/51 (14%)**
— every item whose evidence is bound to the Rust binary:

`P1.3` symbol map · `P1.4` server-scoped pilot identity boundary · `P1.5` proof that production rejects
spoofed headers/CSRF/tenant crossover · `P1.6` browser-proven no-401 learner path *against the native
platform-api* · `P4.2` RLS/cross-tenant coverage · `P4.3` privacy lifecycle on real topology · `P5.2`
per-dependency timeout/retry map (it documents reqwest/tower_governor/sqlx by name) · `P0.5`/`P0.6`
candidate-bound release evidence · `P2.5` axe-core a11y automation, which Flutter kills outright
against a `P6.2` that is already open.

**Measured in the project's own currency, the migration is a regression.** Anyone approving it should
first annotate each of the 17 closed items keep/void and re-present the number.

## 1.2 Cutover is a flag day with an unrehearsed rollback

The realtime ticket is a cross-service HMAC wire contract, so `platform-api` and `realtime-gateway`
**must move together**. Meanwhile Phase 5 of the ledger is 1/7 closed: `P5.5` (prove deploy and
rollback), `P5.6` (timed restore/DR drill), `P5.7` (SRE signs rollback evidence), `P7.5` (challenger
rehearses rollback) — **all open.**

You cannot flag-day a security-critical auth surface holding learners' recitation audio and GDPR
erasure obligations when the rollback path has never been executed once. **`P5.5` + `P5.6` + `P7.5`
become hard prerequisites, not follow-ups** — and they are days of work you need regardless of
framework.

## 1.3 Rewriting an unvalidated specification

Zero users means every one of the ~150 parity assertions encodes behaviour **reality has never
contradicted**. You would spend a year achieving byte-identical parity with untested behaviour, then
learn at first contact with learners that the actual product risk is ASR/tajweed accuracy — which the
rewrite does not touch.

---

# PART 2 — Target architecture: Node.js backend

Replaces `platform-api` (4,705 prod LOC, 34 routes) + `realtime-gateway` + `shared-ticket` (2,268 LOC).

## 2.1 Stack

| Choice | Why this one |
|---|---|
| **Node 22 LTS** | Already the repo's engine; global `fetch`/undici + `node:test` remove three would-be deps |
| **Fastify 5** | The only candidate whose per-route `bodyLimit` natively expresses the 2 MB global / 16 MB ASR split, and whose `request.routeOptions.url` yields the matched route pattern — bounding `http_requests_total{path}` cardinality exactly as axum's `MatchedPath` does. Plugin encapsulation makes middleware order *structural*; it also throws on duplicate method+path at boot instead of last-wins |
| **`postgres` (porsager) 3.x** | **The most important decision in this plan** — see §2.2 |
| **zod 4** via `setValidatorCompiler` | One declaration yields both the TS type (`z.infer`) and the runtime allowlist, so the **9 Rust enums cannot drift** between compile-time type and runtime check. This replaces serde's automatic 422 at the trust boundary |
| **jose 6** | `jwtVerify(..., { algorithms: ['HS256'] })` refuses `alg: none` **by construction**. `jsonwebtoken` trusts the token-declared alg unless you remember the allowlist — the single most likely security regression in this port |
| **@node-rs/bcrypt** | Async by default, cost 12, prebuilt napi binaries. Replaces the two `spawn_blocking` bcrypt calls with no node-gyp |
| **ws 8, explicit `maxPayload`** | Node's default is 100 MiB vs tungstenite's 64 MiB. Pinning it is the only way to keep the two-layer (protocol ceiling / 2 MiB app check) limit identical |

**Rejected:** Express (middleware order is positional with no encapsulation — the documented
CORS-outermost invariant at `lib.rs:337-346` becomes a comment instead of a structure); NestJS
(ceremony without benefit at this size); Prisma (cannot express the RLS discipline in §2.2).

## 2.2 🔴 The database layer — where a naive port silently breaks tenant isolation

Rust today (`lib.rs:452-462`):

```rust
let mut tx = pool.begin().await?;
sqlx::query("SELECT set_config('app.tenant_id', $1, true)")  // true = transaction-local
```

`sqlx::Transaction` binds every subsequent query to **one physical connection** by RAII, and its `Drop`
queues `ROLLBACK`. **28 call sites across 12 handler modules depend on this.**

**The trap:** the security lens found a fatal hole in the obvious node-postgres port:

```js
// DO NOT DO THIS
try { ... } catch { await c.query('ROLLBACK'); throw } finally { c.release() }
```

If the `ROLLBACK` itself throws — connection reset, statement timeout, backend termination, *exactly
the cases that matter* — `c.release()` returns a **client still inside a transaction with
`app.tenant_id` set to the previous tenant** to the pool. `SET LOCAL` only resets at transaction end;
if the transaction never ends, the GUC persists on that connection.

And my earlier "Postgres fails closed" reassurance **only holds for NULL**. A *stale-but-valid* tenant
id **fails OPEN**: `tenant_id = app.current_tenant_id()` evaluates true for the wrong tenant's rows.

**Decision: use `postgres` (porsager) `sql.begin(async sql => …)`**, which *structurally* binds every
statement in the callback to one reserved connection. Structure beats discipline. If `pg` is used
anyway, the error path must be `c.release(err)` so node-postgres **destroys** the client rather than
pooling it.

**Non-negotiable companions:** connect as `quran_ai_app` (never superuser); `SET LOCAL
statement_timeout`; a test that asserts a poisoned connection is destroyed, not reused.

## 2.3 🔴 `require_self_or_any` becomes an auth bypass in JavaScript

Rust: `self.user_id == owner_id` where `user_id` is a non-`Option` `String` from a mandatory serde
claim, and `owner_id` comes from `row.try_get::<String,_>()` which **errors** on a missing column or
NULL.

JavaScript: `row.learner_id` on a renamed column is `undefined`; `payload.sub` on a JWT missing that
claim is `undefined`. **`undefined === undefined` is `true`** — the ownership gate passes for every
caller.

This is the **only** ownership check on 8 endpoints: privacy delete, session read, alignment persist,
realtime ticket mint, progress, and the ML proxy's consent gate.

**Mandatory shape — refuse degenerate input, don't just compare:**

```ts
function requireSelfOrAny(actor, ownerId, allowed) {
  if (typeof ownerId !== 'string' || ownerId === '' ||
      typeof actor.userId !== 'string' || actor.userId === '') {
    throw new ApiError('Forbidden', 403)   // fail closed on degenerate input
  }
  if (actor.userId === ownerId) return
  if (!allowed.includes(actor.role)) throw new ApiError('Forbidden', 403)
}
```

## 2.4 🔴 CORS: the obvious port is wrong in the CSRF-enabling direction

tower-http `AllowOrigin::any()` emits the **literal `*`**, which browsers refuse to combine with
credentials — so today, with `CORS_ALLOWED_ORIGINS` unset, a cross-origin page **still cannot** send the
`__Host-qrai-pilot` cookie.

`@fastify/cors`'s `origin: true` **reflects the request Origin**, which *is* valid with credentials.
That is strictly weaker. Add the near-certain follow-on (`credentials: true`, which a developer sets
the first time cookie auth "doesn't work" during the web/mobile split) and you have full CSRF against
every pilot learner.

**Rule:** never `origin: true`. Emit literal `'*'` on the unset path. **Hard-ban `credentials: true`**
with a boot assertion and a test asserting `access-control-allow-credentials` is absent from every
response.

## 2.5 Middleware order is a security invariant — test it

Effective request order today (layers apply bottom-up): **CORS → maintenance_guard → rate limit →
trace → metrics → handler.** CORS is deliberately outermost so preflight is never rate-limited and
429/503 still carry CORS headers. Maintenance before the handler is what makes the kill-switch work.

Fastify plugin encapsulation makes this explicit — **plus an ordering test**, because in any Node
framework this is otherwise a line-number accident.

## 2.6 Split `ALLOW_INSECURE_DEFAULTS` — the port is the cheap moment

One env var currently disables **five independent controls** across two services: all secret-strength
panics, the superuser-role assertion, the `/metrics` fail-closed gate, the gateway's entire CSWSH
Origin check, and its missing-Origin fail-closed branch.

**And the Flutter client creates the exact operational pressure to set it** — native clients send no
`Origin` header, so "mobile can't connect" leads straight to it. One operator setting one variable
then ships a known-public JWT key, a superuser DB role that makes all 16 RLS policies inert, public
metrics, and no WebSocket origin check.

**Split into:** `ALLOW_INSECURE_SECRETS`, `ALLOW_SUPERUSER_DB_ROLE`, `METRICS_DEV_OPEN`,
`GATEWAY_ALLOW_MISSING_ORIGIN`. Keep the old name as a dev-only alias with a boot assertion that it is
never set in production.

## 2.7 Behaviours a port will "clean up" and break

- `POST /v1/auth/token` returns **snake_case** — the only such body in the API. An accidental
  camelCase "fix" breaks callers.
- `login` **never early-returns** on a missing user; it always runs exactly one bcrypt verify against
  a decoy hash (`user.rs:205-206`). A naive `if (!user) return 401` reintroduces an account-existence
  oracle.
- `register` maps a unique-violation on `idx_users_tenant_email_unique` to a clean 400 because the
  SELECT pre-check races under READ COMMITTED. node-postgres exposes `err.constraint` — get it wrong
  and a 400 becomes a leaking 500.
- Missing consent snapshot falls back to the **most restrictive** consent (`recitation.rs:216-225`).
  A JS `?? {}` silently fabricates consent.
- `/metrics` returns **404, not 401**, when unauthorized (hides existence).

---

# PART 3 — Target architecture: Flutter client

## 3.1 🔴 Mushaf rendering — QCF page fonts REJECTED for v1

I recommended investigating QCF/KFGQPC page fonts earlier. The domain audit says **don't**, for v1:

- **No SPDX-identifiable licence** and no written permission on file.
- **No-modification terms** forbid the subsetting you'd need for 604 page files (25–40 MB).
- **PUA codepoints kill screen readers, copy/paste, and search** — a direct accessibility regression
  for blind learners, against an already-open `P6.2`.

**Decision: HarfBuzz-backed Flutter `Paragraph` shaping with a properly licensed Uthmani font.**
Revisit QCF only with written KFGQPC/QUL permission in hand.

This also **weakens the strongest argument for Flutter** — but the decision is made, so the plan
optimizes for it rather than reopening it.

## 3.2 Stack

| Choice | Why |
|---|---|
| **Flutter ≥3.35 / Dart ≥3.9**, pinned via `fvm` + committed `.fvmrc` | Scripture rendering must never change under a silent toolchain bump |
| **flutter_riverpod 3** + generator + lint | `AsyncValue` is a 1:1 fit for the loading/data/error triad `App.tsx` hand-rolls in ~15 booleans; `ref.onDispose` structurally fixes the three documented mic-leak/race workarounds |
| **go_router 16** | `?invite=` deep links are the entire pilot onboarding path (`App.tsx:130-156`); `redirect` is the one declarative place to reproduce the role gate |
| **record ^6** | `startStream(RecordConfig(encoder: pcm16bits, sampleRate: 16000, numChannels: 1))` → raw LE PCM16 mono on both platforms; one path feeds both batch WAV upload and the gateway, zero container branching |
| **just_audio + audio_session** | `positionStream` (~200 ms) drives word follow-along. **`audio_session` is mandatory on iOS** — set `playAndRecord` + `defaultToSpeaker`, or reference audio comes out of the *earpiece* after a recording. A mobile-only failure with no web analogue |
| **package:http + a ~60-line ApiClient** | dio's interceptor machinery buys nothing yet |

## 3.3 Auth: the pilot cookie cannot port

`__Host-` requires same-origin HTTPS in a browser. A Flutter app is not an origin. **None of the P1.6
flow ports** — not the cookie, not the Origin allowlist, not the CSRF digest.

Mobile needs bearer tokens + secure storage (Keychain/Keystore). This is **backend security work**, and
it re-opens `P4.1` (threat model) and `P1.7` (identity boundary signature). Budget it as such, not as
frontend plumbing.

## 3.4 Flutter Web — honest answer

Viable but a downgrade for this app: larger initial bundle than the current Vite build, weaker
accessibility than DOM, and no SEO. **Recommendation: keep React for web, Flutter for mobile.** If web
must move, do it last and with eyes open.

---

# PART 4 — Cross-language contract + safety layer

Three runtimes (TS, Dart, Python) must agree exactly. Dart cannot import TypeScript.

| Choice | Why |
|---|---|
| **OpenAPI 3.1** — one hand-authored YAML | 3.1's Schema Object *is* JSON Schema 2020-12, so "OpenAPI vs JSON Schema" is a false choice: one file serves route contracts *and* raw schemas |
| **openapi-typescript 7** | Zero-runtime TS types; server keeps compile-time shape without shipping a generated client |
| **ajv 8 + ajv-formats** | Compiles the *same* components into runtime validators — the replacement for serde's automatic 422 |
| **quicktype** (devDep, offline) | Dart models with no JVM toolchain in a repo that has none |
| **package:crypto + dart:convert** | `utf8.encode` is the **only** correct byte source — `String.codeUnits` is UTF-16 and silently wrong for Arabic |
| **`dart test`, not `flutter test`** | The parity runner needs `dart:io` to read fixtures from disk |

**Rejected:** Protobuf/gRPC — would force a wire change across HTTP+JSON, the WebSocket snake_case ack
(`realtime-gateway lib.rs:495-504`), the `__Host-` cookie flow, and the `rt_v1.<...>` HMAC string.

## 4.1 The golden-vector corpus (do this even if the migration is cancelled)

`packages/contracts` exports **10 functions**, not just types — including `canShowLearnerFacingAiOutput`
(fail-closed allowlist), the canonical checksum verifiers, `mustDiscardAudio`, `canUseExternalAsr`.

A language-neutral JSON fixture corpus, executed identically by TS, Node, Python and Dart suites,
covering:

- **Arabic normalization** (§0.4) — ayahs as explicit codepoint arrays, NFC-forbidden asserted.
- **Diacritic stripping** — would have caught §0.1 instantly.
- **SHA-256 + string-join byte-equivalence** across four runtimes.
- **Adversarial gate cases** — an unrecognized `reviewStatus` must fail **CLOSED**. A naive Dart port
  using an enum or a denylist fails **open**; this is the case most likely lost in translation.

**This is phase 1 and it is framework-independent.** It hardens the safety gates whichever way the
decision goes, so the first real work cannot be wasted.

---

# PART 5 — Gates, CI, and migration verification

## 5.1 What replaces Rust's guarantees

| Lost | Compensating control |
|---|---|
| sqlx compile-time query verification | Integration tests against a **real** Postgres as `quran_ai_app` — the existing 79-test suite ported *first* |
| Enum exhaustiveness | zod `.strict()` allowlists at every boundary; the fail-closed gate fixtures in §4.1 |
| No null/undefined | `strict` + `noUncheckedIndexedAccess` tsconfig; the §2.3 degenerate-input guard |
| Memory safety | N/A (GC), but `maxPayload` and body limits must be pinned explicitly |
| Rust mutation-testing gate (exists today) | **Stryker** for Node. Worth it *only* on the auth/tenant/consent modules |

## 5.2 CI matrix

Today CI installs **no Python and no Dart** and runs **no Python tests** — so `test_audio_guards.py`
and the new `test_eval_metrics.py` are ungated. The target adds `setup-python` + `setup-dart` +
`flutter` jobs, plus the existing secret scan, dependency audit, SBOM, and security-headers gates.

## 5.3 How you prove the Node backend matches the Rust one

**Record golden API fixtures from the running Rust service first** — request/response pairs for all
34 routes including error shapes, headers, and status codes — then assert the Node service reproduces
them byte-for-byte. Without this you are comparing the port against your memory of the original,
which is how rewrites acquire silent behaviour drift.

Dual-run is **not** possible for the realtime path: the HMAC ticket is a cross-service wire contract,
so `platform-api` and `realtime-gateway` cut over together.

---

# PART 6 — Phased execution, every phase gated

| Phase | Work | Weeks | Gate to proceed |
|---|---|---|---|
| **0** | **Fix §0.1** (normalizer) + add the assert | 0.5 | `_strip_diacritics("بِسْمِ") == "بسم"` |
| **1** | **Switch CI/dev to `quran_ai_app`**, run the Rust suite, repair fallout (§0.3) | 2–3 | Existing suite green with RLS **actually enforcing** |
| **2** | **Golden-vector corpus** (§4.1) + Arabic normalization contract (§0.4) | 2–3 | TS + Python green on fixtures. *Useful even if migration is cancelled* |
| **3** | **Canonical corpus rework** (§0.2) — separate 4,578 non-recited marks, re-index, migrate FKs | 4–6 | Aligner no longer asked to find audio for silent tokens |
| **4** | Rehearse deploy + rollback + restore on the **current** stack (`P5.5`/`P5.6`/`P7.5`) | 1–2 | Rollback executed once, for real |
| **5** | Record golden API fixtures from the Rust service (§5.3) | 1–2 | All 34 routes captured incl. error shapes |
| **6** | Port the 79-test integration suite to `node:test` | 4–5 | Suite runs against real Postgres |
| **7** | Node backend: routes, auth, RLS discipline, gateway + ticket | 10–18 | Golden fixtures byte-identical; ordering test green |
| **8** | Flutter client: mushaf, audio, bearer auth, i18n, a11y | 12–20 | Parity checklist; physical-device matrix |
| **9** | Cutover + `P4.1`/`P1.7` re-review | 2–4 | Security sign-off on the new boundary |

**Phases 0–4 are framework-independent and pay for themselves whether or not you migrate.**

---

# PART 7 — Recommendation

**Do phases 0–4 now. They are ~8–14 weeks, they fix three real defects, and they are required
regardless of language.** Phase 0 alone is half a day and repairs the core alignment path.

**Then re-decide phases 5–9 with evidence**, ideally after the 5–10 learner pilot your own pilot
report names as the next step — run on the stack that already passes `verify.sh`.

The migration as specified is **45–70 engineer-weeks / 11–17 months for one developer**, takes the
readiness ledger from 33% to ~14%, and flag-days a security-critical auth surface whose rollback has
never been rehearsed — while the product has zero users and the real risk (ASR/tajweed accuracy) goes
untouched.

If the decision is to proceed regardless, **the sequencing above is how to do it without shipping a
security regression** — the four blockers in §2.2, §2.3, §2.4, §2.6 are the ones that turn a rewrite
into an incident, and every one of them is invisible in a code review that only checks "does it return
the same JSON."
