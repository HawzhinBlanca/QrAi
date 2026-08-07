# W2.9 plan — one executable route registry and Rust-free standalone mode

**Status:** approved under the repository owner's W0–W7 consolidation approval<br>
**Architecture change:** implements the already approved Node standalone/compatibility boundary

## EARS acceptance criteria

1. WHEN the Node application is created without `PLATFORM_API_UPSTREAM`, THE application SHALL
   register every executable route from one registry and SHALL require no Rust process. Test:
   `tests/node-api/standalone.test.mjs` registry and health assertions.
2. WHEN an unmatched request reaches standalone mode, THE application SHALL return a local 404 and
   SHALL NOT attempt an upstream fetch. Test: fetch-refusal unknown-route vector.
3. IF standalone receives a pilot cookie while its database is unavailable, THEN authentication
   SHALL fail closed with the generic 401 contract and SHALL NOT delegate. Test: cookie/no-pool
   fetch-refusal vector.
4. WHEN compatibility mode has an explicit upstream, THE application SHALL register only its
   requested executable subset and proxy all unmatched requests byte-for-byte. Tests: existing
   shell and direct/through-Node parity suites.
5. IF `NODE_API_PORTED` names an unknown route, or is supplied without an upstream, THEN process
   startup SHALL exit with a configuration error. Tests: boot/standalone startup vectors.
6. WHEN route registration is audited, THE registry SHALL include every manifest-retained baseline
   operation and every `implemented-node` addition, SHALL exclude `planned-owner-gated` additions,
   and SHALL allow extras only for explicitly removal-blocked transition operations. Test:
   `tests/node-api/route-registry.test.mjs`.
7. WHEN canonical through-Node parity selects all local handlers, THE gate SHALL derive that list by
   importing the executable registry and SHALL contain no source parser or second route copy. Tests:
   NUL invocation guard, module-relocation guard, and canonical gate.

## Implementation tasks

1. Add red registry and standalone tests to canonical verification; observe duplicate-allowlist and
   mandatory-upstream failures.
2. Export `ROUTE_KEYS` as a derived projection of `ROUTES`; delete the `PORTABLE` literal and
   validate compatibility keys against the projection.
3. Refactor `createApplication` so standalone registers all routes and has no proxy catch-all;
   preserve explicit compatibility subset/proxy behavior and expose mode/local keys for assurance.
4. Make no-pool pilot-cookie behavior conditional on compatibility availability: delegate only when
   an upstream exists, otherwise refuse generically.
5. Replace source parsing in verification, cutover readiness, authz matrix, relocation, and NUL
   guards with executable registry imports. Keep readiness structurally unable to report GO.
6. Run focused hermetic tests, package type/build, the full live canonical gate, and a source-built
   non-root image in standalone no-upstream mode. Record evidence; do not check W2.9 until remote CI
   is green.
