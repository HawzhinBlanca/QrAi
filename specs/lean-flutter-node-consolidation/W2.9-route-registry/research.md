# W2.9 research — one executable route registry and Rust-free standalone mode

## Scope and approved boundary

- W2.9 removes the duplicate `PORTABLE` literal and makes `server/src/routes/index.mjs::ROUTES`
  the only hand-maintained executable method/path/handler registry.
- The normal process mode becomes standalone: when `PLATFORM_API_UPSTREAM` is absent, all entries in
  `ROUTES` register locally and unmatched requests receive a local 404. The reversible strangler
  remains available only when an upstream is explicitly configured; `NODE_API_PORTED` then selects
  the local compatibility subset.
- This task does not invent the three owner-gated device-identity operations, remove agent routes
  while their manifest removal gate is blocked, or re-enable password login. Those approved target
  transitions remain W2.16/W7 work. W2.9 proves the current executable transition set honestly:
  every retained baseline route plus every `implemented-node` addition is local; any extra route
  must be a manifest-declared, removal-blocked transition route.

## Symbol and caller map

- Serena mapped `ROUTES`, `fastifyPath`, `createApplication`, `resolveActor`, and their runtime
  references. The language server under-reports source-parsing consumers, so a read-only `rg`
  fallback enumerated the process, gate, cutover, module-relocation, parity, and image tests.
- `server/src/main.mjs::PORTABLE` is a second 41-entry copy. It is parsed by startup validation,
  `scripts/verify.sh`, `scripts/cutover-readiness.mjs`, `authz-matrix.test.mjs`, the old route-table
  test, the NUL invocation guard, and module-relocation assertions.
- `createApplication` currently requires an upstream, defaults `ported` to an empty set, registers
  only that set, and proxies every unmatched request. Direct consumers are `main.mjs`, shell tests,
  package lifecycle tests, and no-secret logging tests; process consumers start it through the
  parity harness and boot guard.
- Twenty-nine protected handler paths contain a delegation branch. They all depend on the same
  `resolveActor` result. Pilot-cookie resolution is already local when a DB pool exists; only the
  no-pool compatibility fallback returns `{delegate}`. Standalone must turn that state into a
  generic 401 rather than call a missing Rust upstream.

## Contract state found

- The immutable Rust baseline is 42 operations. ADR-0038 marks 38 retained and four retired.
- The current executable Node registry has 41 operations: all 38 retained operations, the
  implemented learner-history addition, and two agent operations whose zero-caller removal gate is
  still blocked. Password login/register are not implemented locally.
- The final approved target is also 42 operations, but it is a different set: 38 retained plus four
  additions after all four retirements. Three device additions remain `planned-owner-gated`, so
  claiming exact final-target convergence in W2.9 would fabricate implementation.
- Therefore registry proof must derive lifecycle expectations from `route-manifest.json`: retained
  and `implemented-node` operations are required, owner-gated additions are forbidden, and runtime
  extras are allowed only while their explicit retirement gate is blocked. Later tasks make this
  same test converge to the final set without changing registration architecture.

## Lean runtime decision

- `ROUTES` remains the executable registry and exposes a mechanically derived `ROUTE_KEYS` frozen
  list. No manifest or OpenAPI parsing occurs in the production request path.
- `createApplication` derives its local set from mode:
  - no upstream: standalone, register all `ROUTES`;
  - explicit upstream: compatibility, register only the supplied compatibility keys and proxy the
    rest.
- A compatibility subset without an upstream is a boot error. This prevents a process described as
  standalone from silently serving only part of the retained contract.
- `main.mjs` validates `NODE_API_PORTED` against `ROUTE_KEYS`. It rejects that variable without an
  upstream, but preserves an explicitly configured empty subset as a pure proxy for oracle tests.
- Compose remains an explicit Rust-shadow/canary in this task because traffic cutover is W2.18 and
  the current image contract intentionally keeps Rust as the public target. The source-built image
  receives a separate isolated no-upstream probe.

## Assurance changes required

- Replace `routes-table.test.mjs` with the approved `route-registry.test.mjs`. It owns uniqueness,
  key/method/path/handler consistency, manifest lifecycle projection, absence of `PORTABLE`, and
  Fastify path conversion.
- Add `standalone.test.mjs` to prove all required local routes register with no upstream, local
  health works, an unknown route does not fetch/proxy, no-DB pilot authentication fails closed, and
  partial standalone selection is impossible.
- Make `verify.sh` and the absolute authorization matrix import the executable registry instead of
  parsing JavaScript source. Update cutover readiness to compare supplied route keys against
  required method/path keys; its verdict-flip tests stay hermetic.
- Preserve all compatibility proxy transparency, direct/through-Node parity, image non-root, and
  Compose shadow assertions. Local proof is not release or traffic-cutover proof.
