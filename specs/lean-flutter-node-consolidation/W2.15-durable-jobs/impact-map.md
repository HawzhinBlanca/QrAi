# W2.15 impact map — durable Postgres jobs and outbox effects

Serena is unavailable; the main agent and read-only research subagent mapped these callers with
`rg` and exact source inspection before edits.

| Symbol/surface to touch | Direct callers/consumers | Required preservation/change | Proof |
|---|---|---|---|
| migration manifest + new 0034 table/RLS/indexes | migration runner, schema fingerprint/adoption, role provisioner, SQL smoke, restore/release | additive checksum history; forced tenant RLS; restricted grants; no privileged worker | job migration, schema equivalence, restricted-role, SQL smoke |
| `createDb::{withTenant,forDeadline,end}` | every Node route, app lifecycle, new worker/store | keep single driver owner and transaction-local tenant GUC; add only encapsulated global tenant discovery if needed | DB architecture/tenant plus job concurrency |
| `persistAlignmentsInTransaction` | public alignment write, `finalizeSession`, finding/review readers | remain the single destructive alignment writer; fenced job commit must reuse it and preserve review supersession/provenance | finalization parity, crash/exact-effect, real audio/provenance |
| `finalizeSession` | Flutter `ApiClient.finalizeSession`, `PracticeScreen._loadFindings`, Web/contract, Rust oracle | authorize and enqueue/execute durable `session.finalize`; identical response/refusal semantics | session-finalize parity + durable workflow |
| `proxyMl` / `persistTajweedFindings` | Flutter/Web prediction, review queues, learner gate, ML service | isolate `session.evaluate` prepare/commit; preserve stored consent/spans, release evidence check and learner redaction | ML parity, learner gate, durable workflow |
| `createPrivacyJob` / `eraseMlAudio` | Flutter/Web privacy screens, privacy/audit/restore tests, object store | durable intent before erase; reuse completed `privacy_jobs` wire manifest; preserve auth→existence ordering and cascade | privacy parity, lifecycle, crash-window, timeout |
| `createApplication` composition/context | all local routes/tests; DB/store lifecycle | inject one job runtime, include it in readiness/close, no module singleton or hidden worker | lifecycle/readiness/standalone suites |
| `main.mjs` + new `worker.mjs` | API/worker containers, Compose, shutdown tests | strict job config; API preserves inline sync execution; worker polls/drains independently | boot guard, production image, worker lifecycle |
| `metrics.mjs` / worker metrics surface | API parity scrape, operations | do not add names to Rust-compatible API scrape; worker labels are closed finite enums only | infra parity + worker metric test |
| server image/package + Compose | local stack, release/image/license/secret checks | same production graph/image, second command only; restricted DB and private storage reused | image/Compose/health/license guards |
| `scripts/verify.sh` | local canonical gate and CI | invoke each new proof exactly once; live DB skip remains loud, never fake | invocation guard + canonical gate |
| docs/ADRs/runbooks/inventory | operators, recovery, future W2.17/W6 | document pause/drain/replay/dead-letter/retention and honest unproven production drills | living-doc guards/manual review |

## Effect boundaries

- Finalization: external transcript/alignment can repeat; only one fenced transaction may replace
  alignments and complete the job for the captured input identity.
- Session evaluation: external inference can repeat; the existing finding-authority checks and one
  fenced transaction prevent duplicate stored findings/audits.
- Privacy: durable intent precedes storage erase; storage delete can repeat; the manifest/cascade and
  job completion are one fenced tenant transaction.
- Offline model evaluation: no new producer, caller, signing key, `eval_runs` write, or release claim.

Canonical Quran packages/bytes, Arabic regexes, login-off posture, role set, public route registry,
and learner source/review/calibration gates are outside the change and must remain byte/behavior stable.
