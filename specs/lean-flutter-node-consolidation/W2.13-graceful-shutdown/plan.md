# W2.13 plan — bounded graceful HTTP shutdown

**Status:** APPROVED under the W0–W7 implementation approval<br>
**Approved-by:** Repository owner (current instruction: “approved”; prior: “proceed/continue”)<br>
**Criterion:** BE-5

## Approach

Use Fastify's existing close lifecycle as the normal path and add one dependency-free process
controller around it. The first signal starts `app.close()` immediately, which closes admission and
drains active HTTP. A timer at 80% of the configured budget force-closes remaining HTTP/raw sockets,
leaving 20% for `onClose` resource teardown. A hard timer exits non-zero at the outer deadline only
if normal cleanup fails. A repeated signal escalates socket closure but never duplicates hooks.

The same `SHUTDOWN_GRACE_SECS` value sizes the process controller and Postgres.js `sql.end()` timeout.
Docker/Compose will explicitly send SIGTERM and allow a larger stop window. No runtime dependency,
route, migration, auth behavior, canonical data, or Quran feedback contract changes.

## Test-first sequence

1. Add `tests/node-api/graceful-shutdown.test.mjs` and register it exactly once in the canonical gate.
   First prove that the current entrypoint dies immediately rather than draining.
2. Add `server/src/lib/shutdown.mjs` with strict configuration parsing, deterministic phase sizing,
   raw-socket tracking, idempotent first/repeated-signal behavior, force escalation, and a hard exit.
3. Wire the controller before `listen()` in `server/src/main.mjs`; startup failure must use the same
   bounded resource-close path with a non-zero exit status.
4. Make `createApplication` explicitly preserve graceful Fastify close semantics and derive the DB
   close reserve from the shutdown grace. Make `createDb.end()` use that bounded reserve.
5. Add `STOPSIGNAL`, Compose grace environment/stop window, static topology assertions, operations
   documentation, architecture/ADR implementation notes, and threat-model closure text.
6. Run the focused child tests both hermetically and with the live restricted database, affected
   lifecycle/DB/image/contract tests, `git diff --check`, then the exact canonical gate.

## EARS acceptance mapping

| BE-5 behavior | Automated proof in `graceful-shutdown.test.mjs` |
|---|---|
| WHEN SIGTERM arrives during a completing request, THE API SHALL refuse new work, preserve the in-flight response, close resources, and exit zero inside the grace. | real `main.mjs` child + delayed compatibility upstream |
| IF an HTTP dependency/request remains hung, THE API SHALL disconnect it at the force phase and SHALL still exit inside the outer grace. | real child + never-finishing upstream + socket-close observation |
| IF a raw/upgraded connection is not owned by Node HTTP close, THE process SHALL destroy it before the hard deadline. | child fixture using the production shutdown controller and held upgrade socket |
| WHEN the live API owns a Postgres pool, THE pool SHALL close through Fastify `onClose` before successful shutdown completion. | unique `application_name`, `pg_stat_activity`, and ordered completion log assertion |
| IF shutdown configuration is malformed or unsafe, THE process SHALL refuse startup. | invalid/zero/oversized `SHUTDOWN_GRACE_SECS` child vectors |

## Verification boundary

The canonical command is:

```sh
set -a
source scripts/stack.env
set +a
MIGRATION_TEST_ADMIN_URL='postgresql://hawzhin@127.0.0.1:5433/postgres' bash scripts/verify.sh
```

W2.13 remains unchecked until that command exits zero and required remote CI is green.
