# Research — splitting `ALLOW_INSECURE_DEFAULTS`

Measured against `9ee263b`. Every line number below was read, not recalled.

---

## 1. Why this is open

`specs/flutter-node-migration/plan.md §2.6` requires the split. It was **not done** in Phases 7–9,
and `specs/cutover/boundary.md §3.4` now carries it as a **🔴 live finding open for the security
reviewer**. It is the last item in that document that is engineering work rather than a signature.

That plan is **unsigned** (`plan.md:15`, `Approved-by:` blank) and its own scope note authorizes
`MIG1–MIG5` only. So §2.6 is a *proposal*, not an approved work item — this spec exists to get it
approved on its own terms rather than smuggling it in as "already planned".

## 2. Seven read sites, not one

| # | site | what it disables | accepted values |
|---|---|---|---|
| 1 | `services/platform-api/src/main.rs:26` | **five** boot panics: `JWT_SECRET`, `REALTIME_GATEWAY_TICKET_SECRET`, `ML_API_KEY`, `ASR_API_KEY`, `CORS_ALLOWED_ORIGINS` strength/presence | `1` or `true` |
| 2 | `services/platform-api/src/main.rs:197` | the superuser / `BYPASSRLS` DB-role assertion | `1` or `true` |
| 3 | `services/platform-api/src/lib.rs:86` | `/metrics` fail-closed | **`1` only** |
| 4 | `services/realtime-gateway/src/main.rs:9` | two boot panics: ticket secret, `ML_API_KEY` | `1` or `true` |
| 5 | `services/realtime-gateway/src/lib.rs:459` | gateway `/metrics` fail-closed | `1` or `true` |
| 6 | `services/realtime-gateway/src/lib.rs:463` | **chaos fault injection** (`REALTIME_CHAOS_DROP_AFTER_CHUNKS`) becomes readable | `1` or `true` |
| 7 | `services/realtime-gateway/src/lib.rs:713` | the **entire** CSWSH `Origin` allowlist **and** its missing-`Origin` fail-closed branch | `1` or `true` |

**Thirteen individual assertions in six groups across seven sites.**

## 3. 🟠 §2.6 undercounted, and missed the one that lets a deploy sabotage itself

§2.6 lists five controls. It does **not** mention site 6 — chaos fault injection. `lib.rs:463`'s own
comment says a production gateway "cannot be told to sabotage itself even if the env var leaks into
its config", and that guarantee rests entirely on `ALLOW_INSECURE_DEFAULTS` being unset. It is a real
control and it belongs in the split, so the correct count is **six groups, not five**.

## 4. 🔴 The Node shell does NOT read this variable — `boundary.md §3.4` is wrong

`boundary.md §3.4` states "The Node shell reads the same single variable." It does not:

```
$ grep -rn "INSECURE" services/node-api/
(none)
```

`services/node-api/server.mjs:379-401` reads `PLATFORM_API_UPSTREAM`, `NODE_API_BIND`,
`NODE_API_PORTED`, `DATABASE_URL`, `JWT_SECRET`, `ALLOW_HEADER_AUTH`, `CORS_ALLOWED_ORIGINS` and
`REALTIME_GATEWAY_TICKET_SECRET` — and no insecure-defaults flag at all.

That is a factual error in a document written **for a security reviewer**, and it must be corrected
whatever is decided about the split. A review package that overstates the blast radius trains its
reader to discount it.

## 5. The `"1"`-vs-`"true"` asymmetry is load-bearing in the test suite

`platform-api/src/lib.rs:86` accepts `"1"` only; every other site accepts `"1" or "true"`. So
`ALLOW_INSECURE_DEFAULTS=true` **skips the boot checks while leaving `/metrics` closed**.

`tests/api-parity/metrics.test.mjs:31` **depends on this**: it starts every server with
`ALLOW_INSECURE_DEFAULTS: "true"` because that is the only value that both survives CI (whose
`DATABASE_URL` is a superuser, so a server with the role check on would panic before serving) and
leaves `/metrics` closed enough to test the closed case.

**Consequence: naively making `metrics_dev_open` accept `"true"` turns those tests red.** The file
says so in a header comment. Any split has to keep that combination reachable *by name* rather than
by accident.

## 6. There is no environment marker in this repo

```
$ grep -rn "APP_ENV\|NODE_ENV\|DEPLOY_ENV\|ENVIRONMENT" --include='*.rs' services/
(none)
```

§2.6 asks for "a boot assertion that [the old name] is never set in production". **Nothing in either
Rust service knows whether it is in production.** That assertion is therefore not implementable as
stated without inventing a new environment variable — which is the same class of mistake as the one
being fixed. What *is* implementable is covered in the plan; the gap is stated there, not papered
over.

## 7. Where the value is configured today

| file | line | value |
|---|---|---|
| `docker-compose.yml` | 64, 107 | `"${ALLOW_INSECURE_DEFAULTS:-0}"` — both services |
| `.github/workflows/ci.yml` | 27 | `"1"` |
| `scripts/gen-production-secrets.sh` | 44 | `ALLOW_INSECURE_DEFAULTS=0` |
| `scripts/recreate-staging.sh` | 26 | `ALLOW_INSECURE_DEFAULTS=0` |
| `tests/api-parity/lib/harness.mjs` | 66, 87 | `"1"` (default env), `"1"` (metrics-dev-open mutation) |
| `docs/TESTING.md` | 118 | `ALLOW_INSECURE_DEFAULTS=1` in the documented local command |

**Every production-shaped artifact already sets it to `0` explicitly.** That is what makes a
repo-level gate possible where a runtime assertion is not (§6).

## 8. Existing conventions this must not break

- **Opt-in for LESS security.** `gateway/lib.rs:506-511` names the convention explicitly —
  `ALLOW_INSECURE_DEFAULTS`, `ALLOW_HEADER_AUTH`, `TRUST_PROXY_HEADERS`, `DISABLE_RATE_LIMIT` are all
  opt-in-to-weaken. New names must keep that polarity.
- **Env-var tests need a lock.** `gateway/lib.rs:1599` — `ORIGIN_ENV_LOCK`, because `cargo test`
  runs multi-threaded in one process and `validate_origin` reads the env **per request**. Any new
  test touching these vars must take it.
- **`metrics_dev_open` has a test override** (`platform-api/lib.rs:95`) that exists precisely to
  avoid process-env races.

## 9. The pressure that makes this urgent

A Flutter/native client sends **no `Origin` header**. `gateway/lib.rs:740-750` fails closed on that.
So "mobile can't connect" leads an operator to the one variable that also ships a known-public JWT
key, a `BYPASSRLS` DB role that makes all 16 RLS policies inert, an open `/metrics`, no CSWSH check,
and a gateway that will drop sockets on command.

**One operator, one variable, six controls.** That is the finding.
