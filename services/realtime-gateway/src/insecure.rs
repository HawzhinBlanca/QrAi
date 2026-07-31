//! Per-control opt-outs from the production security posture.
//!
//! `specs/insecure-defaults-split/plan.md §3`
//!
//! Before this module, ONE variable — `ALLOW_INSECURE_DEFAULTS` — disabled **six independent
//! controls** across two services via seven read sites. Four of those sites are in this crate,
//! including the entire CSWSH `Origin` allowlist.
//!
//! Every name here keeps this codebase's stated polarity: **opt-in to weaken**, never opt-in to
//! secure (see the `DISABLE_RATE_LIMIT` note in `lib.rs` for what happened the one time that was
//! inverted).
//!
//! Deliberately **duplicated** from `services/platform-api/src/insecure.rs` rather than shared. A
//! new workspace crate for ~25 lines buys a dependency edge and nothing else; `shared-ticket` exists
//! because a *wire format* must not diverge, which this is not. The two copies differ where the
//! services do: platform-api needs a `"1"`-only legacy arm for its `/metrics` gate, this crate does
//! not, and this crate needs [`legacy_alias_active`], which platform-api does not.

/// The deprecated blunt instrument. Still honoured, so existing deploys keep working — removing it
/// is a separate breaking change (`plan.md §6`).
pub const LEGACY_VAR: &str = "ALLOW_INSECURE_DEFAULTS";

/// Relaxes the boot panics on a weak/missing `REALTIME_GATEWAY_TICKET_SECRET` or `ML_API_KEY`.
pub const ALLOW_INSECURE_SECRETS: &str = "ALLOW_INSECURE_SECRETS";
/// Opens `/metrics` with no token. This gateway is meant to be reachable off-host, so an open
/// `/metrics` publishes operational telemetry to the internet.
pub const METRICS_DEV_OPEN: &str = "METRICS_DEV_OPEN";
/// Accept a WebSocket upgrade that carries **no** `Origin` header.
///
/// This is the narrow knob the Flutter/native client actually needs — native clients send no
/// `Origin`, and before the split the only way to accept them was the legacy variable, which also
/// turned off the allowlist itself. With this set, **a request that DOES carry an `Origin` is still
/// checked against `CORS_ALLOWED_ORIGINS`**, so browsers stay protected against cross-site
/// WebSocket hijacking. That narrowing is the point of the whole split (`plan.md §3.2`).
pub const GATEWAY_ALLOW_MISSING_ORIGIN: &str = "GATEWAY_ALLOW_MISSING_ORIGIN";
/// Makes `REALTIME_CHAOS_DROP_AFTER_CHUNKS` readable — deliberate fault injection (T13).
///
/// `migration/plan.md §2.6` listed five controls and missed this one, even though its own comment
/// promises a production gateway "cannot be told to sabotage itself"; that promise rested entirely
/// on the legacy variable being unset (`research.md §3`).
pub const ALLOW_CHAOS_INJECTION: &str = "ALLOW_CHAOS_INJECTION";

/// Every per-control variable this service reads — the ambiguity check in [`enforce_legacy_alias`]
/// is only as complete as this list.
pub const SPECIFIC_VARS: &[&str] = &[
    ALLOW_INSECURE_SECRETS,
    METRICS_DEV_OPEN,
    GATEWAY_ALLOW_MISSING_ORIGIN,
    ALLOW_CHAOS_INJECTION,
];

/// Values that mean yes. Every site in this crate accepted `"1"` or `"true"` before the split, so
/// unlike platform-api there is no per-site legacy value set to carry.
fn truthy(value: &str) -> bool {
    value == "1" || value == "true"
}

/// Pure decision, so it is testable without touching process env — `cargo test` runs multi-threaded
/// in one process, which is exactly why `lib.rs`'s `ORIGIN_ENV_LOCK` has to exist.
pub fn is_relaxed(specific: Option<&str>, legacy: Option<&str>) -> bool {
    specific.map(truthy).unwrap_or(false) || legacy.map(truthy).unwrap_or(false)
}

/// [`is_relaxed`] against the process environment.
pub fn relaxed(specific: &str) -> bool {
    let specific_value = std::env::var(specific).ok();
    let legacy_value = std::env::var(LEGACY_VAR).ok();
    is_relaxed(specific_value.as_deref(), legacy_value.as_deref())
}

/// True only when the **deprecated** alias is set.
///
/// One behaviour has no narrow replacement on purpose: disabling the CSWSH `Origin` allowlist
/// *entirely*. No deployment legitimately needs that — a native client needs
/// [`GATEWAY_ALLOW_MISSING_ORIGIN`], not a disabled allowlist — so it stays reachable only through
/// the name that is on its way out.
pub fn legacy_alias_active() -> bool {
    std::env::var(LEGACY_VAR)
        .map(|v| truthy(&v))
        .unwrap_or(false)
}

/// Boot-time handling of the deprecated alias. See platform-api's copy for the full contract.
///
/// - `Err(_)` — refuse to start: legacy AND a per-control variable are both set, and silently
///   picking a winner is how a control ends up off without anyone deciding it should be.
/// - `Ok(Some(_))` — start, but say loudly what is being relaxed.
pub fn legacy_verdict(
    legacy: Option<&str>,
    specifics_set: &[&str],
) -> Result<Option<String>, String> {
    if !legacy.map(truthy).unwrap_or(false) {
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
        "DEPRECATED: {LEGACY_VAR} is set and is relaxing EVERY security control in this gateway — \
         secret-strength boot checks, the /metrics fail-closed gate, chaos fault injection, and the \
         ENTIRE CSWSH Origin allowlist. A native client needs {GATEWAY_ALLOW_MISSING_ORIGIN}=1, \
         which keeps the allowlist enforced for browsers. Replace it with only the ones you need: \
         {}. See specs/insecure-defaults-split/plan.md §3.2.",
        SPECIFIC_VARS.join(", ")
    )))
}

/// [`legacy_verdict`] against the process environment: panic on ambiguity, warn on deprecation.
///
/// `eprintln!` rather than `tracing::warn!` because this runs before the tracing subscriber is
/// initialised (`main.rs` sets it up *after* `ensure_secure_config`), and a deprecation notice that
/// gets swallowed teaches an operator nothing.
///
/// This is NOT the "assert it is never set in production" `migration/plan.md §2.6` asked for: no
/// service here knows what environment it is in, and inventing an `APP_ENV` to find out is the same
/// mistake in a new costume. `tests/security/legacy-insecure-flag.test.mjs` catches a bad
/// *committed* default; nothing catches an operator exporting the variable by hand (`plan.md §3.4`).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specific_variable_relaxes_on_its_own() {
        assert!(is_relaxed(Some("1"), None));
        assert!(is_relaxed(Some("true"), None));
    }

    #[test]
    fn legacy_alias_still_relaxes_so_existing_deploys_keep_working() {
        assert!(is_relaxed(None, Some("1")));
        assert!(is_relaxed(None, Some("true")));
    }

    #[test]
    fn nothing_set_stays_strict() {
        assert!(!is_relaxed(None, None));
    }

    #[test]
    fn falsy_values_stay_strict() {
        for value in ["0", "false", "", "no", "yes", "TRUE", "1 "] {
            assert!(
                !is_relaxed(Some(value), None),
                "specific={value:?} must not relax anything"
            );
            assert!(
                !is_relaxed(None, Some(value)),
                "legacy={value:?} must not relax anything"
            );
        }
    }

    #[test]
    fn both_set_is_ambiguous_and_refuses_to_boot() {
        let message = legacy_verdict(Some("1"), &[GATEWAY_ALLOW_MISSING_ORIGIN])
            .expect_err("both set must refuse to boot");
        assert!(message.contains(GATEWAY_ALLOW_MISSING_ORIGIN), "{message}");
        assert!(message.contains(LEGACY_VAR), "{message}");
    }

    #[test]
    fn legacy_alone_warns_and_points_at_the_narrow_origin_knob() {
        let warning = legacy_verdict(Some("true"), &[])
            .expect("legacy alone must not refuse to boot — CI and compose still set it")
            .expect("legacy alone must warn");
        assert!(warning.contains("DEPRECATED"), "{warning}");
        // The operator reaching for this variable is almost always trying to connect a native
        // client. If the warning does not name the knob that actually solves that, it will be
        // ignored and the blunt instrument stays.
        assert!(warning.contains(GATEWAY_ALLOW_MISSING_ORIGIN), "{warning}");
        for name in SPECIFIC_VARS {
            assert!(
                warning.contains(name),
                "warning must name {name}: {warning}"
            );
        }
    }

    #[test]
    fn specifics_alone_are_silent() {
        assert_eq!(legacy_verdict(None, &[ALLOW_CHAOS_INJECTION]), Ok(None));
    }

    #[test]
    fn legacy_switched_off_is_not_ambiguous() {
        // compose passes ALLOW_INSECURE_DEFAULTS=0 through by default; setting a per-control
        // variable alongside it is the intended migration path, not a conflict.
        assert_eq!(legacy_verdict(Some("0"), &[METRICS_DEV_OPEN]), Ok(None));
        assert_eq!(legacy_verdict(Some(""), &[METRICS_DEV_OPEN]), Ok(None));
    }
}
