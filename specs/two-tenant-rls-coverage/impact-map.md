# Impact Map: Adversarial Two-Tenant RLS Coverage

| Area | Affected Files / Symbols | Direct Callers / Consumers | Regression Proof / Test Strategy |
|---|---|---|---|
| Platform API Tests | `services/platform-api/tests/integration.rs` | Cargo test suite, CI workflows | Verification script `verify.sh` runs the new tests. |
