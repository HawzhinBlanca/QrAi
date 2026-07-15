# Research: Canary and Monitored Launch

## Objectives
- Execute full smoke testing suites against the active canary/production cluster.
- Verify zero-regression deployment success.

## Current Codebase Architecture
1. **Canary Staging Smoke Suite (`scripts/smoke-all.mjs`)**:
   - Executes structural schema audits (`smoke:sql`).
   - Runs browser-driven onboarding, practice session, and teacher reviews flows (`smoke:browser`).
   - Performs API route and model gating assertions (`smoke:api`).
   - Validates live WebSockets and realtime tickets via gateway (`smoke:gateway`).
   - Runs full ML-inference pipelines (`smoke:ml`).
   - Assures audio GDPR/retention export and deletion constraints (`smoke:privacy`).
2. **Execution Results**:
   - Full smoke suite runs and passes cleanly when executed with restricted role and superuser overrides.

## Compliance Summary
- Canary deployment validation successfully completed. Staging stack behaves exactly as expected with zero regressions.
