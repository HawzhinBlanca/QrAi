# Plan — split `ALLOW_INSECURE_DEFAULTS` into per-control knobs

**Status: APPROVED 2026-08-01 — option A, full split.**

Approved-by: repo owner (hawzhin88@gmail.com), 2026-08-01 — §9 answered **A**, and §3.4 answered
"warn + repo gate, state the gap" rather than inventing `APP_ENV`.

Evidence: [`research.md`](research.md). Impact: [`impact-map.md`](impact-map.md).

---

## 1. The problem, stated exactly

One environment variable disables **six independent security controls** across two services, via
**seven read sites** and **thirteen assertions**:

secret-strength boot panics (×7) · the superuser/`BYPASSRLS` DB-role assertion · `/metrics`
fail-closed (×2 services) · the CSWSH `Origin` allowlist · the missing-`Origin` fail-closed branch ·
chaos fault injection.

A Flutter client sends no `Origin` header. "Mobile can't connect" leads straight to the one variable
that also ships a public JWT key and makes all 16 RLS policies inert.

## 2. Two corrections this research produced, independent of the split

1. **§2.6 undercounted.** It lists five controls; chaos fault injection (`gateway/lib.rs:463`) is a
   sixth. Its own comment claims a production gateway "cannot be told to sabotage itself" — a
   guarantee resting entirely on this variable.
2. **🔴 `boundary.md §3.4` is factually wrong.** It tells a security reviewer "The Node shell reads
   the same single variable." `services/node-api/` does not read it at all. **This gets corrected in
   every option below, including "do nothing".**

## 3. Design

### 3.1 The new names

| new variable | replaces, at | polarity |
|---|---|---|
| `ALLOW_INSECURE_SECRETS` | `platform-api/main.rs:26`, `gateway/main.rs:9` | opt-in to weaken |
| `ALLOW_SUPERUSER_DB_ROLE` | `platform-api/main.rs:197` | opt-in to weaken |
| `METRICS_DEV_OPEN` | `platform-api/lib.rs:86`, `gateway/lib.rs:459` | opt-in to weaken |
| `GATEWAY_ALLOW_MISSING_ORIGIN` | the missing-`Origin` branch of `gateway/lib.rs:713` | opt-in to weaken |
| `ALLOW_CHAOS_INJECTION` | `gateway/lib.rs:463` | opt-in to weaken |

Five names, because §2.6's four did not cover chaos (§2.1). All keep the repo's stated
opt-in-to-weaken convention (`research.md §8`).

### 3.2 🟢 The real security win is the `Origin` split

Today one variable disables the **whole** CSWSH check. After the split:

- `GATEWAY_ALLOW_MISSING_ORIGIN=1` → a request with **no** `Origin` passes. **A request that *has*
  an `Origin` is still checked against the allowlist.**
- Nothing but the deprecated legacy name can disable the allowlist itself.

So a native/Flutter deployment gets the one relaxation it actually needs, and **browsers stay
protected against cross-site WebSocket hijacking**. That is the difference between this being
bookkeeping and being a fix.

### 3.3 Backwards compatibility, per-control and byte-faithful

Each site resolves as `specific_var_is_truthy() || legacy_alias_applies_here()`, where the legacy
arm reproduces **today's exact values per site** — including `"1"`-only at
`platform-api/lib.rs:86`.

That deliberately carries the `"1"`/`"true"` asymmetry (`research.md §5`) forward **inside the
deprecated alias only**, where it is a documented compat quirk. The new names are consistent
everywhere. Result: **`tests/api-parity/metrics.test.mjs` stays green unchanged**, and its dependency
on the asymmetry stops being load-bearing because the same state is now reachable by name
(`ALLOW_INSECURE_SECRETS=1` with `METRICS_DEV_OPEN` unset).

### 3.4 🟠 What cannot be built as §2.6 specifies

§2.6 wants "a boot assertion that [the legacy name] is never set in production". **Neither service
knows what environment it is in** (`research.md §6`), and inventing `APP_ENV` to find out is the same
mistake in a new costume.

What is buildable, and what this plan does instead:

1. **A loud boot warning** naming every control the legacy variable is currently relaxing. Not a
   panic — panicking on it would break CI, compose, staging and the documented local command
   (`research.md §7`) in one commit.
2. **A boot panic on ambiguity**: legacy set **and** any specific variable set → refuse to start,
   rather than silently picking a winner.
3. **A repo gate** (`tests/`) asserting no production-shaped artifact enables the legacy variable —
   possible precisely because `gen-production-secrets.sh:44`, `recreate-staging.sh:26` and both
   `docker-compose.yml` defaults already set it to `0`.

**(3) is weaker than a runtime assertion and this plan says so rather than implying otherwise.** It
catches the repo shipping a bad default; it cannot catch an operator exporting the variable by hand.

## 4. Scope — the decision for the approver

| option | what changes | risk |
|---|---|---|
| **A — full split** ⭐ | all 5 names, all 7 sites, legacy alias kept + deprecation warning + ambiguity panic + repo gate + docs/compose/ADR | touches boot paths in both Rust services; a mistake here is a service that will not start |
| **B — `Origin` only** | only `GATEWAY_ALLOW_MISSING_ORIGIN` (§3.2), the one with a live product driver; the other five controls stay fused | smallest diff, real win, but `boundary.md §3.4` stays open and the reviewer still has to carry it |
| **C — corrections only** | fix the `boundary.md` error (§2.2) + record the chaos undercount; **no code change** | the finding stays 🔴 exactly as it is |

**Recommendation: A.** The port was called "the cheap moment" for a reason — and B leaves a reviewer
holding a finding that is then 90% closed but not closed.

**Under every option, §2.2's factual correction ships.** A wrong sentence in a security review
package is not a thing to leave pending on a scope decision.

## 5. Tasks (option A)

### S1 — One resolver per service, tested first

A single `insecure_defaults` helper in each service: `relaxed(specific: &str, legacy_values: &[&str])`
→ `bool`. Unit-tested **before** any call site moves, including the `"1"`-only case.

**Acceptance:** tests cover specific-set, legacy-set, both-set, neither, and the `"1"`/`"true"`
split — each shown failing against a deliberately wrong resolver.

### S2 — platform-api: 3 sites

`main.rs:26` → `ALLOW_INSECURE_SECRETS`; `main.rs:197` → `ALLOW_SUPERUSER_DB_ROLE`;
`lib.rs:86` → `METRICS_DEV_OPEN` (legacy arm `"1"`-only).

Panic messages updated to name the **specific** variable, not the legacy one.

**Acceptance:** `cargo test -p platform-api` green; `tests/api-parity/*` green **unchanged**.

### S3 — gateway: 4 sites, and the `Origin` narrowing

`main.rs:9` → `ALLOW_INSECURE_SECRETS`; `lib.rs:459` → `METRICS_DEV_OPEN`;
`lib.rs:463` → `ALLOW_CHAOS_INJECTION`; `lib.rs:713` → the narrowing in §3.2.

**Acceptance:** a test proving the case that motivates the whole change — with
`GATEWAY_ALLOW_MISSING_ORIGIN=1`, a **missing** `Origin` connects **and** a **disallowed** `Origin`
is still 403. Takes `ORIGIN_ENV_LOCK` (`research.md §8`).

### S4 — Deprecation: warn, refuse ambiguity, gate the repo

§3.3's three mechanisms. The repo gate is a `node --test` file so it runs in the fast lane.

**Acceptance:** the ambiguity panic demonstrated firing; the repo gate demonstrated failing against
an artifact that enables the legacy variable.

### S5 — Docs and config, and correct the review package

`docker-compose.yml` (both services), `scripts/gen-production-secrets.sh`,
`scripts/recreate-staging.sh`, `docs/TESTING.md`, `docs/SHIP_READINESS.md`, `docs/DECISIONS.md`
(ADR), and **`specs/cutover/boundary.md §3.4` rewritten** — the §2.2 correction plus the resolved
state.

**Acceptance:** `bash scripts/verify.sh` → VERIFY OK, including
`tests/contract/boundary-references.test.mjs`, which asserts `boundary.md` still discloses
`ALLOW_INSECURE_DEFAULTS` — it must keep doing so, as history rather than as an open finding.

## 6. Non-goals

- **Removing `ALLOW_INSECURE_DEFAULTS`.** It stays as a working alias. Removal is a separate,
  breaking change and needs its own decision.
- **Inventing `APP_ENV`.** See §3.4.
- **Touching `ALLOW_HEADER_AUTH`, `TRUST_PROXY_HEADERS`, `DISABLE_RATE_LIMIT`.** Same family, already
  single-purpose, not part of this finding.
- **Changing what any control does.** Only *which variable* switches it — except §3.2, which is
  narrower than today, never wider.
- **Closing `P1.7`/`P4.1`.** This removes one item from a reviewer's list. It does not sign anything.

## 7. Risks

| risk | mitigation |
|---|---|
| **A boot path breaks and a service will not start** | S1 tests the resolver before any call site moves; every panic path already has coverage in `cargo test` and `tests/api-parity/` |
| A legacy deploy silently loses a relaxation it depended on | the legacy arm is byte-faithful per site (§3.3), asymmetry included |
| The `Origin` narrowing breaks a working browser client | it is strictly narrower: anything that passes today with the check **on** still passes |
| `metrics.test.mjs` goes red | §3.3 is designed around it; it must pass **unchanged**, and if it needs editing the design is wrong |
| The repo gate reads as stronger than it is | §3.4 states its ceiling in the plan and the code comment |

## 8. What this does NOT do

- It does not make anyone unable to run the whole product insecurely — `ALLOW_INSECURE_DEFAULTS=1`
  still does exactly that. It makes the safer path **available and named**.
- It does not prove any deployment is configured correctly. There is no deployment.
- It does not close the cutover. `P1.7`, `P4.1`, `ADR-0022`, `P5.5`, `P5.6` are untouched.

## 9. Question for the approver

**Scope: A (full split, recommended), B (`Origin` only), or C (corrections only)?**

"Approved" alone means **A**. §2.2's factual correction to `boundary.md` ships under all three.
