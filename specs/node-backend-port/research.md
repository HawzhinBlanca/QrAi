# Research — Phase 7: the Node backend

Measured against `bc9eae5` (Phase 6 merged). Commands included so every number can be re-derived.

---

## 1. What has to be ported

```bash
find services/platform-api/src   -name '*.rs' | xargs wc -l | tail -1   # 5080
find services/realtime-gateway/src -name '*.rs' | xargs wc -l | tail -1 # 1969
wc -l services/shared-ticket/src/lib.rs                                 #  299
grep -rho 'sqlx::query' services/platform-api/src/ | wc -l              #   90
```

| | lines |
|---|---|
| `platform-api` (18 files) | **5,080** |
| `realtime-gateway` | **1,969** |
| `shared-ticket` | **299** |
| **total** | **7,348** |

90 `sqlx::query` call sites. The largest single file is `handlers/recitation.rs` at 757 lines with 21
of them; `handlers/privacy.rs` has 18 and is the cascade whose scoping Phase 6 pinned.

`migration/plan.md §2` quotes "4,705 prod LOC" for platform-api. Recounted: **5,080** — the number
predates Phase 3–6 work. Not a large drift, but the plan's estimates rest on it.

## 2. 34 method+path pairs, from 34 registrations over 33 distinct paths

`/v1/learner/progress` is registered **twice** (`lib.rs:252` GET, `lib.rs:256` POST). axum merges
distinct methods on a repeated path. Worth knowing before the port: `migration/plan.md §2.1` chose
Fastify partly because it "throws on duplicate method+path at boot instead of last-wins" — this repo
has a duplicate *path* (legal, distinct methods), not a duplicate method+path. The Fastify argument
still holds; the example is not this one.

## 3. 🔴 The oracle gap: 9 of 34 pairs have NO executable check

Cross-referencing the Phase 5 fixtures (26 steps) with the Phase 6 parity suite (39 tests), matching
on axum's route pattern with `{param}` normalised on both sides:

| coverage | pairs |
|---|---|
| fixture **and** parity | 9 |
| fixture only (response shape) | 8 |
| parity only (behaviour + DB state) | 8 |
| **neither — nothing would catch a wrong port** | **9** |

The nine:

```
GET  /v1/audit-events
GET  /v1/eval-runs/{model_version}
GET  /v1/quran/surahs/{surah_number}
POST /v1/asr/force-align
POST /v1/asr/transcribe
POST /v1/ml/tajweed-findings:predict
POST /v1/pilot/session/logout
POST /v1/realtime-session-tickets
POST /v1/teacher-reviews
```

Two of these matter disproportionately:

- **`POST /v1/realtime-session-tickets`** mints the HMAC the gateway trusts. It is the one credential
  crossing a service boundary, and nothing executable checks it.
- **`POST /v1/teacher-reviews`** is the teacher's decision write path — the human-review gate the
  whole scholar/tajweed pipeline depends on.

**Porting an uncovered route is unverifiable by construction.** Coverage has to come first for these
nine, or the port's correctness rests on reading the Rust and hoping.

## 4. 🔴 The realtime ticket IS portable — the migration plan's claim is too strong

`migration/plan.md §5.3` states:

> "Dual-run is **not** possible for the realtime path: the HMAC ticket is a cross-service wire
> contract, so `platform-api` and `realtime-gateway` cut over together."

That is the single constraint forcing Phase 7 to be a flag day. It does not hold.

`shared-ticket/src/lib.rs:146-156` — the ticket is a **pure deterministic string function**:

```
payload   = "{session}.{tenant}.{learner}.{external_asr}.{expires_at}.{nonce}"
signature = hex(HMAC-SHA256(secret_utf8, payload_utf8))
ticket    = "rt_v1.{session}.{tenant}.{learner}.{external_asr}.{expires_at}.{nonce}.{signature}"
```

No Rust-specific serialization anywhere: `{external_asr}` is Rust's `Display for bool`
(`"true"`/`"false"`, identical to JS `String(bool)`), `{expires_at}` is a `u64` in decimal, and the
digest is lowercase hex.

**Verified by execution, not by reading.** A Rust-minted ticket from the live service, re-signed in
Node from the same secret and the nonce carried in the ticket itself:

```
rust signature : 212339de79ac547fa2c0d4cdc04c0d0eafa1b3a00bb698fa6764ba9d5997d8d5
node recomputed: 212339de79ac547fa2c0d4cdc04c0d0eafa1b3a00bb698fa6764ba9d5997d8d5
MATCH — Node reproduces the Rust HMAC byte-for-byte.
```

(`crypto.createHmac("sha256", secret).update(payload).digest("hex")`.)

**Consequence:** a Node `platform-api` can mint tickets that the **unchanged Rust gateway** accepts.
The two services do **not** have to cut over together, so Phase 7 does not have to be a flag day —
it can be a route-by-route migration where each step is independently reversible.

The constraint that remains real is narrower and worth stating: the format is **unversioned in
practice** (`rt_v1` is a literal both sides compare), so any change to field order or separator is a
simultaneous two-service change. Golden ticket vectors pin that.

## 5. The four named blockers, re-checked against current code

`migration/plan.md §2.2-§2.6`. All four are still live:

| § | blocker | current code | why a naive port breaks it |
|---|---|---|---|
| 2.2 | tx-scoped tenant GUC | `lib.rs` `begin_tenant_tx` → `set_config('app.tenant_id',$1,true)`; sqlx `Transaction` binds one connection by RAII | a `pg` client released while still in a transaction keeps `app.tenant_id`. A **stale-but-valid** tenant fails **OPEN** — Phase 6 only proved the NULL case fails closed |
| 2.3 | `require_self_or_any` | Rust compares non-`Option` `String`s; a missing DB column is a `try_get` **error** | in JS `undefined === undefined` is `true`. It is the only ownership check on 8 endpoints |
| 2.4 | CORS | tower-http emits literal `*` when unset, which browsers refuse to combine with credentials | `@fastify/cors`'s `origin: true` **reflects** the Origin, which *is* valid with credentials |
| 2.6 | `ALLOW_INSECURE_DEFAULTS` | one var disables five controls across two services | Phase 6 found it already means two different things: `metrics_dev_open` checks `== "1"`, the boot checks accept `"1" OR "true"` |

Phase 6's parity suite already covers §2.3 and §2.4 behaviourally (ownership gates, CORS group) and
has teeth-checked both. §2.2's stale-tenant case and §2.6 have **no** test in any language.

## 6. What the existing oracles would and would not catch

The Phase 6 suite is black-box, so it runs unchanged against a Node service — that was the point.
What it checks:

- 26 incident-class behaviours: tenant isolation, ownership, privacy scoping, consent override,
  concurrency, the approval gate, CORS, metrics fail-closed.
- Five server configurations, each proven to go red under a deliberate weakening.

What it does **not** check:

- The 9 uncovered pairs (§3).
- The 46 `mechanical-remainder` Rust tests — status codes, validation, round-trips on routes the
  fixtures cover only at shape level.
- §2.2's stale-tenant-fails-open case: the suite proves RLS backstops a **missing** context, never a
  **wrong** one carried over from a previous request on a pooled connection.

## 7. Scale context

7,348 lines, 34 endpoints, 90 SQL sites, two services, a 10–18 week estimate — against a product
with **zero users**, whose own migration plan (`§ PART 7`) recommended re-deciding phases 5–9 after a
5–10 learner pilot that has not happened. The Kurdish ASR accuracy work, which is the actual product
risk, is untouched by any of this.

That is context for sizing the first increment, not an argument against the decision.
