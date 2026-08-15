# W2.17 specification — local ML, audio, and privacy boundary

## Acceptance criteria (EARS)

- **MLB-1:** WHEN production inference code is loaded or packaged, THE system SHALL source its
  algorithms, orchestration, fixtures, attribution, and audio lifecycle only from `server/`, with no
  production import or image rooted at `services/ml-inference`.
- **MLB-2:** WHEN a finalization or session-evaluation job is claimed, THE worker SHALL invoke the
  package-local inference interface and preserve all consent, provenance, source, review, fixture,
  refusal, span, and persistence gates without an ML HTTP round trip.
- **MLB-3:** WHEN the API accepts finalization, session evaluation, or privacy work, THE API SHALL
  enqueue and boundedly await the durable job without importing or executing inference/job handlers
  on its event loop; disconnect or timeout SHALL leave recoverable durable work.
- **MLB-4:** WHEN a worker operation is cancelled or exceeds its deadline, THE system SHALL propagate
  one parent `AbortSignal` to ASR and storage, SHALL NOT commit or mark the job complete after
  cancellation, and SHALL preserve retry/dead-letter fencing semantics.
- **MLB-5:** WHEN the Rust gateway sends a chunk to the private compatibility ingress, THE worker
  SHALL require the ML key, validate bounded input, perform create-only storage before platform
  indexing, preserve identical-retry/conflicting-overwrite and retention behavior, and never log PCM.
- **MLB-6:** WHEN Node serves privacy export/delete or teacher playback, THE system SHALL use the
  injected object-store interface directly; deletion SHALL remain idempotent and receipt-preserving,
  and no missing store SHALL silently re-enable an ML HTTP fallback in production composition.
- **MLB-7:** WHEN retained audio reaches its configured expiry, THE worker SHALL run a single
  non-overlapping, cancellation-aware sweep, preserve `training-opt-in`, report bounded counts, and
  close the store during graceful shutdown.
- **MLB-8:** WHILE Rust remains the W2.18 traffic/rollback oracle, THE worker SHALL expose a closed,
  key-gated compatibility allowlist for every measured Rust ML consumer; after those consumers move,
  only gateway audio ingress may remain until W3.
- **MLB-9:** WHEN the production stack and release evidence are built, THE system SHALL run API,
  worker/compatibility, and later realtime roles from the one server image/dependency graph, keep
  Python ASR isolated, and report readiness only when each role's actual dependencies are usable.

Every criterion maps to automated tests named in `plan.md`; all are registered in
`scripts/verify.sh`. W2.17 does not authorize HTTP traffic cutover or Rust image removal.
