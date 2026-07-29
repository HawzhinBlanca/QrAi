# Impact Map: Auth, Session, and Realtime Boundaries

| Area | Affected Files / Symbols | Direct Callers / Consumers | Regression Proof / Test Strategy |
|---|---|---|---|
| Platform API CORS | `services/platform-api/tests/integration.rs` | Cargo test suite | Run `verify.sh` to compile and pass all tests. |
