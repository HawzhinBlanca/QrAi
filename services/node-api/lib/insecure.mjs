/**
 * Port of `services/platform-api/src/insecure.rs`'s decision function.
 * specs/insecure-defaults-split/plan.md §3.1
 *
 * Only `is_relaxed` / `relaxed` are ported. `enforce_legacy_alias` is deliberately NOT: it is a
 * boot-time panic, and adding a second process that refuses to start on the same env would make the
 * strangler's two halves fail at different times for the same reason. The Rust service already
 * refuses; that is where the operator finds out.
 *
 * The asymmetry between `truthy` and `LEGACY_ONE_ONLY` is real and is carried over verbatim rather
 * than tidied: before the split, the /metrics gate accepted only the literal `"1"` from the legacy
 * variable, while the boot checks accepted `"1"` or `"true"`. Normalizing it here would make the
 * Node shell OPEN /metrics in a configuration where Rust keeps it closed — a divergence that fails
 * in the unsafe direction.
 */

/** Values a *new* per-control variable accepts. Consistent everywhere, unlike the legacy one. */
const truthy = (value) => value === "1" || value === "true";

export const LEGACY_VAR = "ALLOW_INSECURE_DEFAULTS";

/** What the legacy variable accepted AT THE /metrics CALL SITE before the split. Not "true". */
export const LEGACY_ONE_ONLY = ["1"];

/** What it accepted at the BOOT checks before the split — insecure.rs `LEGACY_ONE_OR_TRUE`. */
export const LEGACY_ONE_OR_TRUE = ["1", "true"];

export const ALLOW_INSECURE_SECRETS = "ALLOW_INSECURE_SECRETS";

/**
 * Relaxes the refusal to boot while connected as a superuser / `BYPASSRLS` database role.
 *
 * Same name and same semantics as `insecure.rs` `ALLOW_SUPERUSER_DB_ROLE`, because it governs the
 * same database. platform-api has refused that role since the RLS work; this port did not, and
 * connected to the SAME `DATABASE_URL`. Measured: with a superuser connection and no relaxation set,
 * platform-api panics ("RLS tenant isolation is INERT") while node-api booted and served real rows
 * from `/v1/quran/surahs`.
 *
 * At cutover node-api serves 37 of 42 routes. A privileged role there makes all 17 tenant-isolation
 * policies a no-op — `app.is_rls_bypass_enabled()` is gated on `rolsuper`, and every policy reads
 * `is_rls_bypass_enabled() OR tenant_id = current_tenant_id()` — leaving isolation resting entirely
 * on each handler remembering `withTenant`. That is exactly the single point of failure the boot
 * check exists to keep from being single.
 */
export const ALLOW_SUPERUSER_DB_ROLE = "ALLOW_SUPERUSER_DB_ROLE";

/**
 * The known-weak values `main.rs` `ensure_secure_config` refuses, transcribed exactly.
 *
 * `minLength` mirrors Rust's `.len() < 32`. Rust compares BYTES (`str::len`); JS `.length` counts
 * UTF-16 code units, so a secret of 32 non-ASCII characters passes here and would pass there too
 * (more bytes, not fewer) — the divergence can only ever be Node being stricter, never looser.
 */
const SECRET_RULES = [
  {
    name: "JWT_SECRET",
    weak: ["quran-ai-dev-secret", "production-secret-change-me"],
    minLength: 32,
    why: "it signs and verifies every bearer token",
  },
  {
    name: "REALTIME_GATEWAY_TICKET_SECRET",
    weak: ["smoke-secret", "production-secret-change-me"],
    minLength: 32,
    why: "it is the HMAC key the realtime gateway trusts",
  },
  {
    name: "ML_API_KEY",
    weak: ["smoke-ml-api-key"],
    minLength: 0,
    why: "it is the only credential gating the ML inference service",
  },
  {
    name: "ASR_API_KEY",
    weak: ["smoke-asr-api-key"],
    minLength: 0,
    why: "it gates the ASR inference service behind the /v1/asr proxy",
  },
  {
    name: "CORS_ALLOWED_ORIGINS",
    weak: [],
    minLength: 0,
    why: "unset makes BOTH the pilot Origin allowlist and browser CORS permissive",
  },
];

/**
 * Boot-time refusal to run with missing or known-weak credentials — the port of `main.rs`
 * `ensure_secure_config`. Returns the problems; the caller decides what to do with them.
 *
 * ── Why this one IS ported when `enforce_legacy_alias` is not ───────────────────────────────────
 * The module header above declines to port the legacy-alias panic, because two processes refusing
 * to boot over a DEPRECATED VARIABLE NAME is one operator lesson delivered twice. This is a
 * different thing: these are the credentials **node-api itself uses** once it serves a route. It
 * verifies bearer tokens with `JWT_SECRET` and MINTS realtime tickets with
 * `REALTIME_GATEWAY_TICKET_SECRET`. A Node process booting on `quran-ai-dev-secret` in front of a
 * Rust service that refused those very values would accept forged tokens the upstream would have
 * rejected — the strangler's two halves disagreeing about who a caller is.
 *
 * It is dormant while `NODE_API_PORTED` is empty, and that is the point of adding it now rather
 * than during a cutover: the guard must already be there on the day a route is first enabled.
 */
export function insecureSecretProblems(env) {
  if (isRelaxed(env[ALLOW_INSECURE_SECRETS], env[LEGACY_VAR], LEGACY_ONE_OR_TRUE)) return [];

  const problems = [];
  for (const { name, weak, minLength, why } of SECRET_RULES) {
    const value = env[name] ?? "";
    if (value.trim() === "") {
      problems.push(`${name} must be set in production — ${why}.`);
    } else if (weak.includes(value)) {
      problems.push(`${name} is a known default (${value}) — ${why}.`);
    } else if (value.length < minLength) {
      problems.push(`${name} must be at least ${minLength} characters — ${why}.`);
    }
  }
  return problems;
}

/** Pure decision — insecure.rs `is_relaxed`. */
export function isRelaxed(specific, legacy, legacyValues) {
  if (specific !== undefined && specific !== null && truthy(specific)) return true;
  if (legacy === undefined || legacy === null) return false;
  return legacyValues.includes(legacy);
}

/** [`isRelaxed`] against the process environment — insecure.rs `relaxed`. */
export function relaxed(specificVar, legacyValues, env = process.env) {
  return isRelaxed(env[specificVar], env[LEGACY_VAR], legacyValues);
}
