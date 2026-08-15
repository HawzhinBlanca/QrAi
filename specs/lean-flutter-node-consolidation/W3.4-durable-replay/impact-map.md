# W3.4 impact map — durable Postgres realtime replay authority

Serena is unavailable; the main agent and a read-only research subagent resolved callers using
exact `rg` references and source inspection before edits.

| Symbol/surface to touch | Direct callers and consumers | Planned effect | Regression obligation |
|---|---|---|---|
| new migration 0036 + manifest | migration runner/ledger, fresh/0021/0027 convergence, role provisioner, restore/release, SQL smoke | additive claim table, composite session key/FK, forced RLS, hash/u64 constraints, unique claim, expiry index | new migration suite + runner/equivalence/restricted-role/smoke |
| `recitation_sessions(tenant_id,id)` composite key | every session writer/reader; replay FK; privacy/test teardowns | redundant uniqueness only; no row/wire change; enables tenant-matching cascade | schema convergence, API parity, cascade and two-tenant proof |
| new `createRealtimeReplayAuthority` | `createRealtimeApplication`; W3.4 direct/live benchmark tests; future W3.5 admission consumer | claims-only atomic store, no fallback, bounded cleanup/lifecycle/fixed metrics | race/restart/scope/expiry/outage/load/hash/cleanup tests |
| `createDb.withTenant` (reuse unchanged) | all Node tenant routes/jobs, realtime replay | bind claim/cleanup to one restricted tenant transaction; no privileged/security-definer path | existing DB architecture/leak tests + W3.4 restricted two-tenant cases |
| `createRealtimeAdmission().admit` | `realtime/main.mjs`; all direct W3.3 ticket cases | async durable claim after rate validation; accepted only after fresh; generic 401/503; nonce stripped | all six fixtures, hostile/origin/rate, duplicate/outage, metrics/context cases |
| `REALTIME_ADMISSION_OUTCOMES` / metrics | private `/metrics`; W3.3 ticket/lifecycle and monitoring consumers | add only `replay_rejected` and `replay_unavailable`; no identity/error labels | exact label/counter assertions and privacy scan |
| `createRealtimeApplication` lifecycle | W3.2 process tests, W3.3 raw upgrades, `startRealtimeProcess`, Compose node-realtime | construct real authority from DB; start/stop cleanup in Fastify lifecycle before DB close | health/ready/drain/close/failure isolation plus no test bypass in production start |
| W3.2/W3.3 fake DB/replay seams | process lifecycle and ticket-boundary tests, spawned process fixtures | inject explicit always-fresh replay only where the test is about another boundary; preserve all old assertions | unchanged W3.2/W3.3 counts and real W3.4 default composition proof |
| `CORE_TABLES` + SQL smoke inventories | contracts tests, RLS static/live smoke, data inventory | name the new tenant table, seed two tenants, prove forced isolation and exact visible counts | contracts + smoke + new migration suite |
| migration hard-coded 34/0035-last assertions | runner, schema convergence, device migration proof | advance total to 35 and locate 0035 by id instead of asserting it remains last | all migration suites with live DB |
| `scripts/verify.sh` + invocation guard | local gate, CI, release evidence | one isolated W3.4 command, never duplicate it in giant Node/live blocks | exact-one guard; full canonical gate |
| ADR/architecture/testing/ops/inventory docs | operators, reviewers, W3.5–W3.9 and W7 retirement | record implemented Node authority, benchmark result, cleanup/failure/rollback, and continued Rust traffic | realtime decision contract + manual evidence review |

## Explicitly unaffected callers

- `server/src/lib/ticket.mjs` and both ticket issuers keep exact `rt_v2` bytes and the existing
  issuance hash row. The replay module receives validated claims only; fixture truth does not move.
- `services/realtime-gateway` keeps its Redis/in-memory oracle unchanged. No Redis service or Node
  dependency is added, and W3.4 does not claim public production replay protection before traffic.
- Web/Flutter clients, reverse proxy, Compose traffic target, audio frames/queues/acks/sequences,
  storage/indexing, inference, Quran bytes, login-off posture, and learner review gates do not change.
- Existing Node and Rust privacy handlers need no branch: the composite session FK cascades replay
  claims when either implementation deletes the owning recitation session. Cleanup harnesses must
  prove this; they change only if a non-cascading manual order remains necessary.
