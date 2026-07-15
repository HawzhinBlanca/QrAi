# Impact Map: Number-One Release Program

This is a release program, not one code change. Each implementation slice must
replace this preliminary map with symbol-level Serena references before editing.

| Area | Likely symbols/files | Direct callers/consumers | Regression proof |
|---|---|---|---|
| Release gate | `scripts/verify.sh`, CI workflows | CI, every task ledger | Clean-clone verification and required-check enforcement. |
| Aggregate proof | `scripts/smoke-all.mjs`, smoke scripts | Release manifest, staging services | Single trace across all smoke summaries. |
| Web session orchestration | `App`, `AuthenticatedApp`, `loadInitialData`, `startPractice`, `sendToTeacher` | Sidebar, LearnerHome, PracticeFlow, PrivacySettings, TeacherSurface | Browser E2E happy/failure/role matrix. |
| Learner feedback gate | `canShowLearnerFacingAiOutput`, UI gate helpers | ML responses, TajweedPanel, PracticeFlow | Mutation tests prove unsourced/unreviewed output cannot render. |
| Tajweed rules | `tajweed.js` rule functions and golden tests | ML prediction API, scholar packet | Scholar scope matrix and held-out evaluation. |
| Tenant transaction/RLS | `begin_tenant_tx`, handler queries, `0003_tenant_rls.sql` | API routes, background jobs, storage adapters | Live multi-tenant API/SQL/object tests. |
| Privacy lifecycle | consent guards, privacy handlers, ML storage logic | Record/upload, external ASR, export/delete endpoints | Live object+DB before/after evidence. |
| Realtime ingress | ticket validation, WebSocket session lifecycle | Browser uploader, gateway, ML/API | Replay/origin/tenant negative tests and fault recovery. |
| Accessibility/i18n | Sidebar, TopBar, CSS direction/layout, locale resources | Every web screen | Axe + keyboard/AT + RTL visual/device suite. |
| Mobile | Expo App, session/auth/recording modules | Native UI, platform API | Supported-device E2E matrix. |
| Production platform | Compose/IaC, Dockerfiles, nginx, DB roles, observability | All deployed services | Image policy, deploy, backup/restore, load/chaos evidence. |

## Required impact-map rule per implementation task

Before an agent edits any row above, it must run symbol/reference discovery,
record every caller and test in that task's own impact map, and add the
affected caller tests to the task ledger. If a caller cannot be identified, the
task is blocked rather than guessed.
