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
