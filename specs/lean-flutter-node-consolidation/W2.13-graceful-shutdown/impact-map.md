# W2.13 impact map — bounded graceful shutdown

| Symbol/boundary | Callers/consumers mapped before edit | Planned change | Regression proof |
|---|---|---|---|
| new `server/src/lib/shutdown.mjs` controller | `main.mjs`; direct child fixture/test | Own one grace clock, socket set, normal/force/hard phases, repeated-signal escalation | completing, hung, raw-upgrade, and config vectors |
| `server/src/main.mjs` direct entrypoint | Docker `CMD`; Compose; boot guard; API-parity `startShell`; production/release image workflows | Parse grace strictly, install SIGINT/SIGTERM before listen, close bounded on startup error | boot guards, real child shutdown, full parity harness |
| `server/src/app.mjs::createApplication` | `main.mjs`; standalone/shell/middleware/DB/security/fault tests | Explicit closing semantics and derive DB close reserve from the same grace | standalone lifecycle, DB architecture/role, parity |
| `server/src/lib/db.mjs::createDb` and returned `end` | `createApplication`; DB tenant/fault direct tests; app `onClose`; request deadline facade | Validate a close timeout and use it for `sql.end`, including request-scoped facade | pool presence/removal child proof; DB tenant/role/fault suites |
| `server/Dockerfile` runtime | Compose; Docker CI; release image scripts | Declare SIGTERM stop signal | production-image static proof and Docker build |
| `docker-compose.yml::node-api` | local/staging stack; production-image test; Docker CI | Coordinate default app grace with a larger container stop window | parsed Compose topology assertion |
| `scripts/verify.sh` Node suite | local canonical gate and CI | Invoke the named child proof exactly once | `verify-invocations.test.mjs` |
| living operations/architecture/security docs | maintainers, staging operators, release gate | Document grace inequality, normal/forced logs, and remaining W3 WebSocket close-frame work | boundary-reference/decision guards plus review |

No route handler, Quran text, model output, learner gate, schema, migration, or tenant query changes.
