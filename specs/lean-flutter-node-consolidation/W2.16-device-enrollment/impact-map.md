# W2.16 impact map — controlled device enrollment

Serena is unavailable; the main agent and read-only identity-map subtask used exact-name `rg` and
source inspection before planning. No implementation code or test was changed in this phase.

| Symbol/surface to touch | Direct callers/consumers | Required preservation/change | Proof |
|---|---|---|---|
| migration manifest + new 0035 tables/functions | migration runner, schema fingerprint/adoption, restricted role, SQL smoke, restore/release | additive checksum history; forced RLS; generation/family constraints; pinned definer search path; PUBLIC execute revoked | device migration, runner, equivalence, restricted-role, SQL smoke |
| `infra/provision/app-role.sql` function grants | role provisioner, Compose/CI/staging app role | grant only named discovery/consume functions to restricted role; no `BYPASSRLS` | restricted-role + migration privilege assertions |
| `createDb::{withTenant,withDiscoveredTenant,forDeadline}` | every route, pilot exchange, new device exchange/refresh/auth resolver | reuse unchanged transaction-local GUC/deadline boundary; no route-owned raw transaction | DB tenant/architecture + concurrent exchange/refresh |
| new `identity/device-sessions.mjs` | device route handlers, `resolveActor`, provisioning script tests | sole token/hash/lifetime/generation/family authority; generic failures and commit-before-401 replay outcome | enrollment E2E + unit refusal vectors |
| `authz.mjs::resolveActor` | all protected Node route handlers | reserved opaque prefix before JWT verification; database-derived current actor; preserve JWT → pilot → dev compatibility semantics for all other inputs | authz, authz matrix, pilot/auth-token parity, enrollment E2E |
| new device route handlers + `routes/index.mjs::{ROUTES,ROUTE_KEYS}` | standalone/compatibility registration, route manifest/OpenAPI, shell and registry tests | exactly three accepted operations; no caller tenant/user/role; owner gate default off | route registry, standalone, boot guard, enrollment E2E |
| `app.mjs::createApplication` + `main.mjs` config | API entrypoint, test harness, boot/lifecycle tests | strict boolean owner gate, default false; inject request-deadline DB only; no login screen/gate change | boot guard, lifecycle, config tests |
| new provisioning command + `server/package.json` lint | authorized operator, server image/package, operational docs | validate stored admin and role allowlist in tenant transaction; generate raw token internally/show once; no new driver/dependency | provisioning E2E, package build, DB architecture |
| `privacy.mjs` identity inventory/delete ordering | Flutter/Web privacy callers, job workflows, privacy parity/lifecycle/observability | inventory safe counts only; delete device sessions/invitations before user; never export hashes/tokens | privacy parity, durable workflow, erasure journey |
| OpenAPI device schemas/paths + route manifest statuses | contract parser/generator, registry/coverage/completeness, future Flutter W4.10 | strict request/response; mark implemented-owner-gated; retain four-route count arithmetic and retirement blockers | OpenAPI completeness, target registry, coverage/retirement tests |
| DB architecture and no-secret logging guards | all raw runtime SQL and Fastify/console sinks | enumerate the new security-definer consumers only; reject token/invite/refresh canaries at trace | DB architecture, no-secret-logging, device security cases |
| `scripts/verify.sh` | canonical local/CI gate | invoke the accepted enrollment/migration proof exactly once; live DB absence remains an explicit skip | verify-invocations + canonical gate |
| decisions/architecture/testing/inventory/runbook/threat model | operators, W4.10, W6 release, future security review | document inactive-by-default posture, lifetimes, replay-family response, provisioning, erasure, and later DPoP/App Attest decision | living-doc guards/manual review |

## Preserved callers and deferred work

T2 exact-name reference mapping before edit found `resolveActor` callers in `auth.mjs`,
`agent-write.mjs`, `ml-proxy.mjs`, `privacy.mjs`, `progress.mjs`, `recitation.mjs`, `reports.mjs`,
`review.mjs`, `session-writes.mjs`, `sessions.mjs`, and `pilot.mjs`. They remain API-compatible
because the new branch is reserved to `qrai_at_v1.` and all other Bearer values retain HS256
verification before the existing pilot-cookie and explicit development-header branches.

T3 exact-name mapping before edit found route-registry consumers in `app.mjs`, `main.mjs`, canonical
through-Node derivation, cutover readiness, the authorization matrix, standalone/module-relocation
guards, manifest/OpenAPI coverage, and image/runtime tests. Dormant owner-gated entries are declared
by the registry and contract but excluded from default registration, cutover traffic accounting,
and Rust parity selection.

T4 exact-name mapping before edit found `capturePrivacyManifest` called only by `createPrivacyJob`
and `commitPrivacyInTransaction` called only by `preparePrivacyWorkflow`; both privacy routes share
that durable path. The server lint command is pinned by `standalone-lifecycle.test.mjs`, and the new
operator command is consumed only by its package script and accepted device-enrollment E2E. Device
inventory markers are aggregate counts, and device deletion remains inside the existing fenced
tenant transaction.

- Flutter `TokenStore`, `Actor.fromJwt`, `ApiClient`, and `main.dart` remain unchanged until W4.10;
  release auth therefore remains unavailable, honestly, while the server boundary is proved.
- Web pilot `mintInvitation/bootstrap/logout`, HS256 `issueToken`, Rust password compatibility, and
  their callers/tests remain byte/behavior compatible. Retirements wait for zero callers/canary.
- Canonical Quran bytes, Arabic processing, model/eval authority, feedback review/source gates,
  realtime tickets, and background-job behavior are outside this change.
