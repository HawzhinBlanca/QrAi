# Impact Map: Canary and Monitored Launch

| Area | Affected Files / Symbols | Direct Callers / Consumers | Regression Proof / Test Strategy |
|---|---|---|---|
| Canary / Deployment | `scripts/smoke-all.mjs` | Release / Ops engineers | pnpm smoke:all exits 0. |
