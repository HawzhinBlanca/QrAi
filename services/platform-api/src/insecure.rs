//! Per-control opt-outs from the production security posture.
//!
//! `specs/insecure-defaults-split/plan.md §3`
//!
//! Before this module, ONE variable — `ALLOW_INSECURE_DEFAULTS` — disabled **six independent
//! controls** across two services via seven read sites. A Flutter/native client sends no `Origin`
//! header, so "mobile can't connect" led an operator straight to the single switch that also ships
//! a known-public JWT key and a `BYPASSRLS` DB role that makes all 17 RLS policies inert.
//! (16 when this was written; `tests/security/rls-policy-coverage.test.mjs` now counts them against
//! the live database, so the number cannot drift silently again.)
//!
//! Every name here keeps this codebase's stated polarity: **opt-in to weaken**, never opt-in to
//! secure (see `realtime-gateway/src/lib.rs`'s `DISABLE_RATE_LIMIT` note for why that convention
//! exists and what happened the one time it was inverted).
//!
//! Deliberately **duplicated** in `services/realtime-gateway/src/insecure.rs` rather than shared. A
//! new workspace crate for ~25 lines buys a dependency edge and nothing else; `shared-ticket` exists
//! because a *wire format* must not diverge, which this is not. If a third service ever needs it,
//! that is the moment to extract it.

/// The deprecated blunt instrument. Still honoured, so existing deploys keep working — removing it
/// is a separate breaking change (`plan.md §6`).
pub const LEGACY_VAR: &str = "ALLOW_INSECURE_DEFAULTS";

/// Relaxes the boot panics on weak/missing `JWT_SECRET`, `REALTIME_GATEWAY_TICKET_SECRET`,
/// `ML_API_KEY`, `ASR_API_KEY` and `CORS_ALLOWED_ORIGINS`.
pub const ALLOW_INSECURE_SECRETS: &str = "ALLOW_INSECURE_SECRETS";
/// Relaxes the refusal to boot while connected as a superuser / `BYPASSRLS` role, which makes every
/// RLS policy a no-op.
pub const ALLOW_SUPERUSER_DB_ROLE: &str = "ALLOW_SUPERUSER_DB_ROLE";
/// Opens `/metrics` with no token.
pub const METRICS_DEV_OPEN: &str = "METRICS_DEV_OPEN";

/// Every per-control variable this service reads — the ambiguity check in [`enforce_legacy_alias`]
/// is only as complete as this list.
pub const SPECIFIC_VARS: &[&str] = &[
    ALLOW_INSECURE_SECRETS,
    ALLOW_SUPERUSER_DB_ROLE,
    METRICS_DEV_OPEN,
];

/// What the legacy variable accepted at most call sites before the split.
pub const LEGACY_ONE_OR_TRUE: &[&str] = &["1", "true"];
/// What the legacy variable accepted at the `/metrics` gate — and **only** there. Carried forward
/// verbatim so `tests/api-parity/metrics.test.mjs`, which depends on the asymmetry, stays green
/// unchanged. The asymmetry now lives only inside the deprecated alias; the new names are
/// consistent. See `research.md §5`.
pub const LEGACY_ONE_ONLY: &[&str] = &["1"];

/// Values a *new* per-control variable accepts. Consistent everywhere, unlike the legacy one.
fn truthy(value: &str) -> bool {
    value == "1" || value == "true"
}

/// Pure decision, so it is testable without touching process env — `cargo test` runs multi-threaded
/// in one process, and `realtime-gateway`'s `ORIGIN_ENV_LOCK` exists because of exactly that.
///
/// `legacy_values` is the set the legacy variable accepted **at this call site** before the split,
/// which is why it is a parameter rather than a constant.
pub fn is_relaxed(specific: Option<&str>, legacy: Option<&str>, legacy_values: &[&str]) -> bool {
    if specific.map(truthy).unwrap_or(false) {
        return true;
    }
    legacy.map(|v| legacy_values.contains(&v)).unwrap_or(false)
}

/// [`is_relaxed`] against the process environment.
pub fn relaxed(specific: &str, legacy_values: &[&str]) -> bool {
    let specific_value = std::env::var(specific).ok();
    let legacy_value = std::env::var(LEGACY_VAR).ok();
    is_relaxed(
        specific_value.as_deref(),
        legacy_value.as_deref(),
        legacy_values,
    )
}

/// Boot-time handling of the deprecated alias.
///
/// - `Err(_)` — refuse to start. The legacy variable is relaxing everything **and** a per-control
///   variable is also set. There is no defensible winner, and silently picking one is precisely how
///   a control ends up off without anyone deciding it should be.
/// - `Ok(Some(_))` — start, but say loudly what is being relaxed.
/// - `Ok(None)` — nothing to say.
///
/// `specifics_set` is the subset of [`SPECIFIC_VARS`] present and non-empty. Empty counts as unset,
/// because `docker-compose.yml` passes variables through as `"${FOO:-}"` and would otherwise make
/// every deploy ambiguous.
pub fn legacy_verdict(
    legacy: Option<&str>,
    specifics_set: &[&str],
) -> Result<Option<String>, String> {
    // Note the asymmetry: a legacy value of "0", "false" or "" relaxes nothing at any call site, so
    // it is not worth a word. Only "1"/"true" are load-bearing.
    if !legacy
        .map(|v| LEGACY_ONE_OR_TRUE.contains(&v))
        .unwrap_or(false)
    {
        return Ok(None);
    }
    if !specifics_set.is_empty() {
        return Err(format!(
            "{LEGACY_VAR} is set AND per-control variable(s) are also set: {}. \
             {LEGACY_VAR} is DEPRECATED and relaxes every control at once, so combining the two has \
             no defensible meaning — this service refuses to start rather than silently pick a \
             winner. Unset {LEGACY_VAR} and use the per-control variables \
             (see specs/insecure-defaults-split/plan.md §3.1).",
            specifics_set.join(", ")
        ));
    }
    Ok(Some(format!(
        "DEPRECATED: {LEGACY_VAR} is set and is relaxing EVERY security control in this service — \
         secret-strength boot checks, the superuser/BYPASSRLS DB-role assertion, and the /metrics \
         fail-closed gate. Replace it with only the ones you need: {}. \
         See specs/insecure-defaults-split/plan.md §3.1.",
        SPECIFIC_VARS.join(", ")
    )))
}

/// [`legacy_verdict`] against the process environment: panic on ambiguity, warn on deprecation.
///
/// `eprintln!` rather than `tracing::warn!` on purpose — this runs before the tracing subscriber is
/// initialised, and a deprecation notice that gets swallowed teaches an operator nothing.
///
/// This is NOT the "assert it is never set in production" that `migration/plan.md §2.6` asked for.
/// Neither service knows what environment it is in — there is no `APP_ENV` anywhere in `services/`
/// — and inventing one to find out is the same mistake in a new costume. The repo-level gate
/// `tests/security/legacy-insecure-flag.test.mjs` catches a bad *committed* default; nothing here
/// catches an operator exporting the variable by hand. Stated, not papered over (`plan.md §3.4`).
pub fn enforce_legacy_alias() {
    let legacy_value = std::env::var(LEGACY_VAR).ok();
    let specifics_set: Vec<&str> = SPECIFIC_VARS
        .iter()
        .copied()
        .filter(|name| {
            std::env::var(name)
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false)
        })
        .collect();
    match legacy_verdict(legacy_value.as_deref(), &specifics_set) {
        Err(message) => panic!("{message}"),
        Ok(Some(warning)) => eprintln!("WARN {warning}"),
        Ok(None) => {}
    }
}

/// The spoofable-header identity fallback, as a boot decision.
///
/// `ALLOW_HEADER_AUTH` makes `x-tenant-id` / `x-user-id` / `x-user-role` — headers any client can
/// send — an accepted identity (`auth.rs:114`). It is the single switch that collapses the whole
/// authentication boundary, and it was the ONLY prod-critical control in this service with no
/// boot-time refusal: `JWT_SECRET`, `REALTIME_GATEWAY_TICKET_SECRET`, `ML_API_KEY`, `ASR_API_KEY`
/// and `CORS_ALLOWED_ORIGINS` all fail closed in `ensure_secure_config`; this one did not.
///
/// Its BEHAVIOUR is well covered — `tests/api-parity/auth-disabled.test.mjs` runs the suite with it
/// off, and the `header-auth-on` mutation proves those tests have teeth. What nothing covered is a
/// deploy that simply has it on.
///
/// Returned as a message rather than panicking here, so the decision is a pure function with an
/// explicit input and can be tested without touching the process environment — the same split as
/// `is_relaxed` above. `None` means boot may proceed.
///
/// Deliberately NOT added to [`SPECIFIC_VARS`]: `tests/api-parity/lib/harness.mjs` BASE_ENV sets
/// `ALLOW_INSECURE_DEFAULTS=1` and `ALLOW_HEADER_AUTH=1` together, so listing it there would make
/// every parity group ambiguous under [`legacy_verdict`] and refuse to start. The relax path is the
/// one `ensure_secure_config` already honours.
pub fn header_auth_refusal(allow_header_auth: bool, insecure_relaxed: bool) -> Option<String> {
    if !allow_header_auth || insecure_relaxed {
        return None;
    }
    Some(format!(
        "ALLOW_HEADER_AUTH is enabled, which accepts client-supplied x-tenant-id/x-user-id/\
         x-user-role headers as identity — any caller could name any tenant, user and role. It is a \
         dev/CI affordance and must never be on in production. Unset it, or set \
         {ALLOW_INSECURE_SECRETS}=1 for local dev only."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specific_variable_relaxes_on_its_own() {
        assert!(is_relaxed(Some("1"), None, LEGACY_ONE_OR_TRUE));
        assert!(is_relaxed(Some("true"), None, LEGACY_ONE_OR_TRUE));
    }

    #[test]
    fn nothing_set_stays_strict() {
        assert!(!is_relaxed(None, None, LEGACY_ONE_OR_TRUE));
        assert!(!is_relaxed(None, None, LEGACY_ONE_ONLY));
    }

    #[test]
    fn falsy_values_stay_strict() {
        // The polarity that matters: anything that is not an explicit yes must NOT weaken.
        for value in ["0", "false", "", "no", "yes", "TRUE", "1 "] {
            assert!(
                !is_relaxed(Some(value), None, LEGACY_ONE_OR_TRUE),
                "specific={value:?} must not relax anything"
            );
            assert!(
                !is_relaxed(None, Some(value), LEGACY_ONE_OR_TRUE),
                "legacy={value:?} must not relax anything"
            );
        }
    }

    #[test]
    fn legacy_alias_still_relaxes_so_existing_deploys_keep_working() {
        assert!(is_relaxed(None, Some("1"), LEGACY_ONE_OR_TRUE));
        assert!(is_relaxed(None, Some("true"), LEGACY_ONE_OR_TRUE));
    }

    #[test]
    fn legacy_metrics_asymmetry_is_carried_forward_verbatim() {
        // lib.rs:86 accepted "1" only, every other site accepted "1" or "true". Reproduced here so
        // ALLOW_INSECURE_DEFAULTS=true still leaves /metrics CLOSED, which is what
        // tests/api-parity/metrics.test.mjs depends on. If this flips, that suite goes red — which
        // is the point of pinning it.
        assert!(is_relaxed(None, Some("1"), LEGACY_ONE_ONLY));
        assert!(!is_relaxed(None, Some("true"), LEGACY_ONE_ONLY));
    }

    #[test]
    fn the_new_name_is_consistent_where_the_legacy_one_was_not() {
        // The asymmetry lives ONLY inside the deprecated alias. METRICS_DEV_OPEN=true works.
        assert!(is_relaxed(Some("true"), None, LEGACY_ONE_ONLY));
    }

    #[test]
    fn both_set_is_ambiguous_and_refuses_to_boot() {
        let verdict = legacy_verdict(Some("1"), &["METRICS_DEV_OPEN"]);
        let message = verdict.expect_err("both set must refuse to boot");
        assert!(message.contains("METRICS_DEV_OPEN"), "{message}");
        assert!(message.contains(LEGACY_VAR), "{message}");
    }

    #[test]
    fn legacy_alone_warns_but_boots() {
        let warning = legacy_verdict(Some("true"), &[])
            .expect("legacy alone must not refuse to boot — CI and compose still set it")
            .expect("legacy alone must warn");
        assert!(warning.contains("DEPRECATED"), "{warning}");
        // The warning has to name the replacements, or it tells an operator to do something without
        // saying what.
        for name in SPECIFIC_VARS {
            assert!(
                warning.contains(name),
                "warning must name {name}: {warning}"
            );
        }
    }

    #[test]
    fn specifics_alone_are_silent() {
        assert_eq!(legacy_verdict(None, &["ALLOW_INSECURE_SECRETS"]), Ok(None));
    }

    #[test]
    fn legacy_switched_off_is_not_ambiguous() {
        // compose passes ALLOW_INSECURE_DEFAULTS=0 through by default. Setting a per-control
        // variable alongside it is the intended migration path, not a conflict.
        assert_eq!(legacy_verdict(Some("0"), &["METRICS_DEV_OPEN"]), Ok(None));
        assert_eq!(legacy_verdict(Some(""), &["METRICS_DEV_OPEN"]), Ok(None));
    }

    #[test]
    fn header_auth_on_in_production_refuses_to_boot() {
        let refusal =
            header_auth_refusal(true, false).expect("header auth must refuse in production");
        // The message has to name the variable an operator must act on, and say what it DOES —
        // "insecure" alone tells nobody why their deploy stopped.
        assert!(refusal.contains("ALLOW_HEADER_AUTH"), "{refusal}");
        assert!(refusal.contains("x-user-role"), "{refusal}");
        assert!(refusal.contains(ALLOW_INSECURE_SECRETS), "{refusal}");
    }

    #[test]
    fn header_auth_off_boots() {
        assert_eq!(header_auth_refusal(false, false), None);
    }

    #[test]
    fn dev_and_ci_are_unaffected() {
        // The control. tests/api-parity/lib/harness.mjs BASE_ENV sets ALLOW_INSECURE_DEFAULTS=1
        // alongside ALLOW_HEADER_AUTH=1 for every parity group; if this refused, the entire parity
        // suite would stop booting.
        assert_eq!(header_auth_refusal(true, true), None);
        assert_eq!(header_auth_refusal(false, true), None);
    }
}
