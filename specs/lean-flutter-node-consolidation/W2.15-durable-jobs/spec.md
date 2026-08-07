# W2.15 specification — durable Postgres jobs and outbox effects

**Status:** approved under the owner-approved W0–W7 consolidation plan<br>
**Criteria:** BE-4, BE-6

## EARS acceptance criteria

| ID | Criterion | Automated proof |
|---|---|---|
| JOB-1 | WHEN two workers claim ready work concurrently, THE system SHALL lease each job to at most one worker generation without blocking unrelated ready jobs. | `tests/jobs/durable-jobs.test.mjs` concurrent lease cases |
| JOB-2 | IF a worker crashes or exceeds its operation deadline, THEN THE job SHALL become claimable after its bounded lease, and a stale worker SHALL NOT commit an effect with an superseded fence. | `tests/jobs/durable-jobs.test.mjs` crash/expiry/fencing cases |
| JOB-3 | IF an attempt fails transiently, THEN THE system SHALL record only a fixed error code, schedule bounded retry backoff, and SHALL transition to an observable dead letter at the configured attempt ceiling. | `tests/jobs/durable-jobs.test.mjs` retry/dead-letter cases |
| JOB-4 | WHEN the same server-derived idempotency key is enqueued concurrently, THE system SHALL create one job, return the same result, and SHALL reject a conflicting payload for that key. | `tests/jobs/durable-jobs.test.mjs` enqueue races |
| JOB-5 | WHEN finalization or session evaluation is retried after a crash, THE domain database effect and job completion SHALL commit in one tenant transaction and SHALL occur once. | `tests/e2e/durable-workflows.test.mjs` finalize/evaluate effect counters |
| JOB-6 | WHEN privacy delete is accepted, THE durable intent SHALL exist before object deletion; IF the process dies after storage deletion, THEN a retry SHALL finish the database cascade once without claiming that no deletion occurred. | `tests/e2e/durable-workflows.test.mjs` privacy crash-window case |
| JOB-7 | WHEN a job payload, result, error, or log is written, THE system SHALL contain no raw audio, transcript, credential, dependency URL, or unbounded caller object. | `tests/security/job-boundary.test.mjs` hostile/redaction cases |
| JOB-8 | WHEN the worker starts or receives SIGTERM, THE process SHALL validate strict timing limits, poll without a privileged DB role, stop claims, cancel work, close storage/database resources, and exit within its grace budget. | `tests/node-api/worker-lifecycle.test.mjs` |
| JOB-9 | WHEN job state is inspected operationally, THE worker SHALL expose bounded ready/running/retry/dead gauges and fixed attempt outcomes without tenant, learner, session, or object-key labels. | `tests/node-api/worker-lifecycle.test.mjs`, `tests/jobs/durable-jobs.test.mjs` |
| JOB-10 | WHEN offline model evaluation evidence is produced, THE existing offline evaluator/signature authority SHALL remain the only producer; W2.15 SHALL NOT add an online evaluation-write or release-signing path. | `tests/security/job-boundary.test.mjs`, existing model-evidence tests |

No criterion changes canonical Quran bytes, login posture, learner feedback gates, public response
shapes, or the offline model-evaluation trust boundary.
