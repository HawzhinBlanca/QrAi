# W2.18 specification — candidate-bound Node HTTP canary and rollback

## Acceptance criteria (EARS)

- **HCR-1:** WHEN release images are built, THE release pipeline SHALL publish every deployable to
  durable registry storage under the full source SHA, record its immutable digest under one
  canonical service identity, and preserve both candidate and previous manifests.
- **HCR-2:** WHEN the release Compose topology is rendered, THE system SHALL consume only the exact
  image digests in the selected manifest, SHALL map API and worker to the same Node-backend digest,
  SHALL bind the one-shot migration runner separately, and SHALL contain no source build fallback.
- **HCR-3:** WHEN an HTTP canary starts, THE deployment SHALL bind one explicit environment and
  approved test-actor cohort to Node for exactly the 39 retained operations, SHALL send realtime
  indexing through Node, and SHALL keep Rust healthy for transition-only routes and rollback.
- **HCR-4:** WHEN a retained write is exercised during canary, THE system SHALL execute it on exactly
  one backend, preserve tenant/RLS/privacy/feedback/effect invariants, and SHALL NOT shadow or replay
  the write merely to compare implementations.
- **HCR-5:** WHEN canary evidence is accepted, THE evidence SHALL bind source SHA, candidate and
  previous image digests, rendered topology hash, environment identity, actor class, exact route
  set, actual container image IDs, command hashes, start/end times, and observation result; any
  mismatch, dirty source, expiry, or undeclared fixture SHALL fail closed.
- **HCR-6:** WHEN hostile-input and effect parity are claimed, THE proof SHALL address the actual
  candidate Node image and Rust oracle, prove all retained routes remain local when Rust is
  unavailable, and SHALL NOT substitute source-checkout processes for declared image digests.
- **HCR-7:** WHEN load, burst, or soak evidence is recorded, THE runner SHALL target Node HTTP plus
  its real worker/storage/DB dependencies, use approved classroom and durable-job scenarios, enforce
  declared thresholds, and preserve failed thresholds instead of rewriting them to fit results.
- **HCR-8:** WHILE canary observation is active, THE system SHALL observe Node/Rust readiness, HTTP
  error/latency/fallback share, worker backlog/retry/dead state, privacy, tenant isolation, lost
  chunks, and learner-feedback withholding without sensitive labels.
- **HCR-9:** IF any approved stop condition or invariant fails, THE controller SHALL stop promotion,
  route HTTP and realtime indexing back to Rust, restore the previous immutable manifest, verify
  health and non-duplication, and emit failed candidate-bound evidence within a bounded timeout.
- **HCR-10:** WHEN W2.18 is proposed complete, THE required remote CI, deployed canary/soak/rollback
  evidence, and owner/security/SRE approvals SHALL be signed, candidate-bound, and unexpired;
  automation SHALL validate but never generate a human approval.

Every criterion maps to named automated tests in `plan.md` and those tests run from
`scripts/verify.sh` or its release mode. W2.18 does not authorize Rust deletion, production GO,
random traffic splitting, Kubernetes/service-mesh adoption, or shadowing mutable requests.
