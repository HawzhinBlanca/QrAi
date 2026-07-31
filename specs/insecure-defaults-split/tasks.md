# Splitting `ALLOW_INSECURE_DEFAULTS` — Tasks

Scope approved 2026-08-01: **option A** — full split, with "warn + repo gate, state the gap" rather
than inventing `APP_ENV`. See [`plan.md`](plan.md) §4 and §3.4.

Closes the last engineering item in `specs/cutover/boundary.md`. It does **not** close the cutover:
`P1.7`, `P4.1`, `ADR-0022`, `P5.5` and `P5.6` are untouched and still need a person.

**Task-ID prefix `S`.** Checked against `CU*`, `F*`, `K*`, `MIG*`, `N*`, `OC*`, `P0.1…P7.6`, `PAR*`,
`T*` — no collision.

---

## S1 — One resolver per service, tested before anything moves

`services/platform-api/src/insecure.rs` (10 tests) · `services/realtime-gateway/src/insecure.rs`
(8 tests). Pure decision functions, so they are testable without touching process env — `cargo test`
runs multi-threaded in one process, which is why `ORIGIN_ENV_LOCK` has to exist at all.

**Four mutations, four named failures:**

| mutation | caught by |
|---|---|
| legacy arm ignores the per-site value set | `legacy_metrics_asymmetry_is_carried_forward_verbatim` |
| `truthy` accepts anything non-empty | `falsy_values_stay_strict` |
| ambiguity no longer refuses to boot | `both_set_is_ambiguous_and_refuses_to_boot` |
| a per-control variable alone stops relaxing | `specific_variable_relaxes_on_its_own` + one more |

- [x] S1 — Resolver — Pure, per-service, and shown to fail four ways.

---

## S2 — platform-api: three sites

`main.rs` → `ALLOW_INSECURE_SECRETS` (5 boot panics) and `ALLOW_SUPERUSER_DB_ROLE`;
`lib.rs` → `METRICS_DEV_OPEN`. Every panic message now names the **specific** variable, so an
operator who hits one is told the narrow fix rather than the blunt one.

**Acceptance:** `cargo test` 34 + 5 + 10 green; `tests/api-parity/*` green **unchanged**.

- [x] S2 — platform-api — Three sites, panic messages renamed.

---

## S3 — gateway: four sites, and the narrowing that is the actual fix

`main.rs` → `ALLOW_INSECURE_SECRETS`; `lib.rs` → `METRICS_DEV_OPEN`, `ALLOW_CHAOS_INJECTION`, and the
`Origin` split.

**`GATEWAY_ALLOW_MISSING_ORIGIN` relaxes only the missing-`Origin` branch.** A request carrying a
disallowed `Origin` is **still 403**. Disabling the allowlist outright has no legitimate deployment,
so it stays reachable only through the deprecated name.

`missing_origin_knob_does_not_disable_the_allowlist` asserts all three cases. Mutated back to the old
fused behaviour, it fails with its own message:

```
assertion `left == right` failed: GATEWAY_ALLOW_MISSING_ORIGIN must NOT disable the allowlist —
this is the difference between the split being a fix and being bookkeeping
```

- [x] S3 — gateway — Four sites; the allowlist survives the native-client relaxation.

---

## S4 — Deprecation: warn, refuse ambiguity, gate the repo

`enforce_legacy_alias()` at the top of both `main()`s: **panic** if the legacy variable is set
alongside any per-control one, **warn** (naming every control, and the narrow `Origin` knob) if it is
carrying the load alone. `eprintln!` not `tracing::warn!` — it runs before the subscriber exists, and
a swallowed deprecation notice teaches nobody anything.

`tests/security/legacy-insecure-flag.test.mjs` (5 tests): no committed production artifact ships a
relaxation switched on, and the deprecated variable is **read** only through `insecure.rs`.

**It fired on its first run** — `set_var(` ends in `var(`, so it flagged the origin tests, which
legitimately *set* the alias to prove it still works. Anchored to `env::var(` and re-verified both
ways: injecting a direct read and a `:-1` compose default each produced a named failure.

**Stated ceiling, in the test and in `plan.md §3.4`:** this catches a bad *committed* default. It
**cannot** catch an operator exporting the variable by hand. A green tick here is not "production is
safe".

- [x] S4 — Deprecation — Warns, refuses ambiguity, gates the repo, and admits what it misses.

---

## S5 — Config, docs, and correcting the review package

`docker-compose.yml` (both services), `scripts/gen-production-secrets.sh`,
`scripts/recreate-staging.sh`, `docs/TESTING.md`, `docs/SHIP_READINESS.md`, `ADR-0024`, and
`specs/cutover/boundary.md` §3.4–§3.5.

- [x] S5 — Config and docs — Five new names wired through; two corrections shipped.

---

## Findings

### 1. 🔴 The gateway never received `CORS_ALLOWED_ORIGINS` in compose

Found while wiring the `Origin` split. `docker-compose.yml` set it on **platform-api only**. The
gateway reads the same variable for its CSWSH allowlist, and with it unset in strict mode
`validate_origin` **403s every WebSocket upgrade** — including from an allowed browser origin.

The committed production default is `ALLOW_INSECURE_DEFAULTS=0`, so **a production compose deploy had
realtime audio entirely broken.** Nothing was live, so nothing broke; the point is that the gateway's
strict-mode path had never been exercised against the committed compose file.

It fails in the safe direction — a security control rejecting legitimate traffic, not admitting
illegitimate traffic — which is exactly why it could sit there unnoticed.

### 2. 🟠 `§2.6` undercounted, and this document's predecessor was wrong

- §2.6 listed **five** controls; there are **six**. It missed chaos fault injection, whose own
  comment promises a production gateway "cannot be told to sabotage itself" — resting entirely on the
  variable being unset.
- `boundary.md §3.4` told a security reviewer "The Node shell reads the same single variable."
  `services/node-api/` never read it. Corrected in place. A review package that overstates a blast
  radius trains its reader to discount it.

### 3. The `"1"`/`"true"` asymmetry was kept on purpose

Reproduced verbatim **inside the deprecated alias only**, so `tests/api-parity/metrics.test.mjs` —
which depends on `ALLOW_INSECURE_DEFAULTS=true` skipping the boot checks while leaving `/metrics`
closed — passes **unchanged**. That suite passing untouched is the sharpest available evidence that
backwards compatibility held. The new names are consistent.

---

## Not done, and needing a person

- **The alias is not removed.** `ALLOW_INSECURE_DEFAULTS=1` still relaxes everything. This reduces
  the *pressure* to reach for the blunt instrument; removal is a separate breaking change.
- **`§2.6`'s "never set in production" assertion is not implemented.** No service knows what
  environment it is in, and inventing `APP_ENV` to find out is the same mistake in a new costume.
  The repo gate is strictly weaker and says so.
- **No deployment was tested.** There is no deployment. Every claim here is `cargo test` and
  `node --test`, not a running stack.
- **`P1.7` / `P4.1` still need a security reviewer's signature.** This removes one item from their
  list and adds §1 to it.
