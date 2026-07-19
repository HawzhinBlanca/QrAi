# Impact Map: 10/10 Readiness Recovery

This is a planning map, not authorization to edit.  Before each implementation
task, the assigned agent must re-index with `ccc`, find the concrete symbol,
find its callers/references, and update this map with the observed result.

| Change area | Primary symbols/files | Known callers / affected paths | Required regression proof |
| --- | --- | --- | --- |
| Release evidence | `scripts/release-manifest.mjs`, `scripts/release-challenge.mjs`, `scripts/verify.sh`, `scripts/smoke-all.mjs`, smoke scripts, release CI workflow, proof docs | Build runner generates evidence; independent runner verifies manifest and reruns release gate; retained smoke summary consumers | Valid and invalid manifests, dirty/untracked tree, wrong SHA, missing digest, expired artifact, unsigned evidence, runner/build identity separation, dedicated release DB requirement, and fresh independent verification. |
| Browser bootstrap | `apps/web/src/App.tsx`: `AuthenticatedApp`, `loadInitialData`; learner route rendering | `LearnerHome` retry callback, practice start, consent flow, teacher/reviewer shell, browser startup | Real browser starts at default route, gets progress, begins practice, retries after a controlled failure, and logs neither 401 nor uncaught error. |
| Web API identity | `apps/web/src/data/platform.ts`: `actorHeaders` and fetch methods; `apps/web/src/lib/api.ts` duplicate header helper | Every learner, teacher, reviewer, privacy, and recitation fetch; development proxy/config | Unit and E2E tests in pilot and production policy modes; no client-controlled tenant/role trust in production. |
| API authorization | `services/platform-api/src/auth.rs`: `JwtConfig`, `actor_from_headers`; `services/platform-api/src/lib.rs` state/config | handlers: `recitation`, `progress`, `privacy`, `review`, `eval`, `agent`, `user`, `auth`, `audit`, `ml_proxy`; integration tests | Spoof rejection, valid bearer/session acceptance, role checks, RLS isolation, CORS/cookie behavior, and all handler paths. |
| Live-DB test determinism | `services/platform-api/tests/integration.rs`: `list_tajweed_findings_returns_the_seeded_finding_not_an_empty_list`; `services/platform-api/src/handlers/review.rs`: capped priority query | `bash scripts/verify.sh`, CI's persistent or disposable Postgres, teacher findings queue | The test's own fixture remains above the endpoint's intentional 200-row priority cap; assertion still proves that exact fixture is returned rather than a historical row. Pagination/product semantics remain separate work. |
| Environment policy | `package.json` `api:dev`, Compose/deployment config, CI environment settings | local dev, smoke stack, staging/pilot, production rollout | Policy matrix proves header auth only where explicitly allowed; production invariant refuses it. |
| Localization | `apps/web/src/data/platform.ts`: `localeCapabilities`, `getSelectableInterfaceLanguages`, `resolveSelectableInterfaceLanguage`; `App.tsx` language initialization/switching; `TopBar.tsx`, `PlatformCommand.tsx`; i18n setup and `apps/web/src/locales/*` | learner/teacher/reviewer strings, normal-route and internal selectors, URL locale input, direction/HTML lang, bounded Sorani verse loader, native mobile copy if shared | Capability-registry selector, expiry, and URL rejection; key parity, reviewed pack manifest, no English fallback, semantic RTL, visual RTL, accessibility label tests. |
| Quran/domain provenance | `packages/contracts`: `canShowLearnerFacingAiOutput`; `apps/web/src/lib/tajweedReview.ts`: `learnerVisibleTajweedFindings`; `apps/web/src/components/TajweedPanel.tsx`; `packages/quran-data/src/translation-bundles.ts`; `fetch-translations.mjs`; inference services, scholar docs | Learner Tajweed panel calls the shared contract gate; teacher review queue remains a distinct staff-only workflow. The Sorani provenance record pins the legacy raw assets; a future importer writes to a new version directory. | Source/review gate, withheld unapproved/unsourced/low-confidence paths, visible citation for eligible findings, byte-drift and inventory check, append-only import, real/fixture label, model/version/corpus linkage. |
| Privacy and tenancy | `infra/sql/0003_tenant_rls.sql`, platform handlers, privacy contracts, audit-log code | all database queries, export/delete jobs, retention workers, observability | multi-tenant suite, export/delete lifecycle, consent/retention, audit events, raw-audio/secret redaction. |
| Reliability/operations | `services/realtime-gateway/src/lib.rs`: `RealtimeGateway::start_session`, `end_session`, session map and Redis tracking; retry/reconnect code, queues/jobs, compose/Dockerfiles, deployment/IaC, telemetry/runbooks | Socket setup/end mutates the local session map; best-effort Redis reconciliation runs only after the map lock is released. Web reconnect, API/inference dependencies, health checks, alerts, backups, and rollback remain affected. | Stalled-Redis lock-isolation tests, fault injection, load/performance budget, telemetry trace linkage, restore rehearsal, deployment/rollback drills. |
| Product/device quality | learner/teacher/reviewer components, mobile app, E2E test harness, design tokens | desktop/mobile browsers, native device flows, keyboard and screen reader paths | critical-path E2E, axe/regression tests, mobile device matrix, manual assistive-tech signoff. |

## Change-control rules

1. One task changes one mapped surface at a time; no broad cleanup hidden in a
   readiness task.
2. Any new identity, deployment, data, runtime, queue, or observability
   dependency requires an ADR and security/SRE review before implementation.
3. A source/review, RLS, privacy, or evidence test cannot be weakened to make
   a gate pass.  Failed proof becomes an open task with root cause and owner.
4. A task changes status only after its failing-first test, `bash
   scripts/verify.sh --release` result, CI result, artifact path/hash, and
   independent reviewer are recorded in `tasks.md`.
