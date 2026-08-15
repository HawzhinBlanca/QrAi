# W2.13 research — bounded HTTP shutdown and resource drain

## Scope
W2.13 implements BE-5 for the current Node API process: admission stop, bounded HTTP drain, forced
socket fallback, Postgres close, and exit inside one grace budget. WebSocket close frames remain W3;
this task must still prevent an upgraded socket from defeating the hard deadline.

## Measured current state

- `server/src/main.mjs` is the sole API process/socket owner. It constructs `createApplication`,
  calls `app.listen`, and has no `SIGINT`/`SIGTERM` handler or shutdown configuration.
- `server/src/app.mjs::createApplication` uses Fastify 5.11.0. Its close lifecycle marks closing,
  rejects late work, stops acceptance, drains HTTP, then runs `onClose`. Measurement found its
  native-server branch treats documented `"idle"` as truthy and force-closes active connections;
  Node 22 `server.close()` already reaps idle sockets, so graceful operation requires explicit false.
- `createApplication` registers `db.end()` in `onClose`, which is correctly ordered after HTTP
  drain, but `server/src/lib/db.mjs::createDb` hard-codes a five-second pool-end timeout independent
  of any process grace budget.
- Node 22.13.1 `server.closeAllConnections()` force-closes active HTTP sockets but explicitly does
  not destroy protocol-upgraded sockets. No Node WebSocket route exists yet.
- `server/Dockerfile` has no explicit `STOPSIGNAL`; `docker-compose.yml::node-api` has no shutdown
  environment or `stop_grace_period`, so Docker's kill budget is not coordinated with app drain.
- `tests/node-api/standalone-lifecycle.test.mjs` proves import/start/close only. No real child test
  sends SIGTERM during a completing or wedged request, proves late-work refusal, observes upstream
  cancellation/pool cleanup, or bounds process exit.
- Parity `startShell().stop()` sends SIGTERM then SIGKILL after five seconds. Today unhandled SIGTERM
  terminates Node immediately; it is not evidence of resource drain.

## Symbol and caller map

- `main.mjs` is invoked by Docker/Compose, boot guards, parity harnesses, and release workflows.
- `createApplication` is called by `main.mjs` and the standalone, shell, middleware, DB-role,
  security, no-secret, and dependency-fault tests; lifecycle options must remain injectable.
- `createDb` is called only by `createApplication` in runtime and directly by DB tenant/fault tests.
  Its `end` facade is consumed by the app `onClose` hook and a request-scoped facade.
- Compose/Docker lifecycle assertions live in `tests/node-api/production-image.test.mjs`; exact gate
  invocation is pinned by `tests/contract/verify-invocations.test.mjs`.

## Design constraints and risks

- One grace budget must reserve pool teardown time; independent timers could exceed that budget.
- `process.exit()` before `app.close()` resolves would bypass pool cleanup; relying only on natural
  exit can hang forever on an active or upgraded socket. The hard deadline needs an explicit exit,
  while the normal path must await Fastify and Postgres cleanup.
- `closeAllConnections()` must run only after `app.close()` has started, avoiding Node's documented
  new-connection race. Tracking raw server sockets supplies the final upgraded-socket fallback.
- Signal handling must be idempotent; a second signal should escalate connection closure without
  installing duplicate timers or running `onClose` twice.
- The child proof needs both completing and hung requests. Live Postgres proof may skip loudly only
  when the administrative/restricted database is unavailable.

## Primary evidence

- Pinned Fastify 5.11.0 sources/docs in `node_modules/.pnpm/fastify@5.11.0/...`: `close()` ordering,
  `return503OnClosing`, default idle drain, and explicit upgraded-connection warning.
- Node 22.13.1 HTTP API: <https://nodejs.org/download/release/v22.13.1/docs/api/http.html>.
- Fastify shutdown lifecycle: <https://fastify.dev/docs/latest/Reference/Server/#close>.
- Postgres.js teardown contract: <https://github.com/porsager/postgres#teardown--cleanup>.

Serena MCP was unavailable; definitions/references were mapped read-only with `rg` and installed sources.
