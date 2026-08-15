# W2.6 research — local Node session finalization

## Scope and method

- Goal: port `POST /v1/recitation-sessions/{id}/finalize` without creating a second alignment writer.
- Serena mapped `server/src/routes/session-writes.mjs::persistSessionAlignments` and its only runtime
  reference in `server/src/routes/index.mjs`; the active Serena language server does not index Rust,
  so Rust symbols/tests were inspected read-only by exact file and line range.
- Reviewed the Rust finalizer, transactional alignment helper, OpenAPI operation, Flutter caller,
  ML transcript/alignment envelopes, DB migrations, parity coverage, and live integration harness.

## Current call and data flow

1. Flutter `ApiClient.finalizeSession` sends only a session id; `PracticeScreen` finalizes before
   Tajweed analysis and stored-finding retrieval.
2. Rust reads in-tenant session ownership, Quran reference, selected model, consent snapshot, and
   current consent, then commits before either network call.
3. ML `/v1/session-transcript` returns measured tokens, `server-derived`, chunk/gap facts, and an ASR
   attribution envelope; no transcript is a normal `finalized:false` answer with no DB replacement.
4. ML `/v1/alignments:predict` receives tokens and the exact upstream attribution, never caller text;
   finalization requires a Quran-aligner attribution that extends the ASR envelope exactly.
5. Only `matched`/`misread` canonical rows with usable spans may persist. One invalid status, unknown
   word, missing field, or unusable span rolls back the whole replacement and preserves prior rows.
6. All persisted words link to one `alignment_runs` row with dataset, evidence, consent snapshot,
   latency, source, model attribution, and the session-selected model.

## Existing Node boundary and gap

- Node already has the correct FK-safe replacement order: detach reviews, delete findings, words,
  stale run, append audit, then insert canonical usable spans inside `db.withTenant`.
- That logic is embedded in the public client-reported handler and omits `alignment_run_id`; copying
  it into a finalizer would create two destructive authorities and guaranteed drift.
- Node ML forwarding validates a producer envelope but its helper is route-private; exact attribution
  extension has no Node boundary helper yet.
- Node `fetch` calls are currently unbounded. ADR-0050 requires an AbortSignal budget; Rust defaults
  `UPSTREAM_TIMEOUT_SECS` to 60 and strictly rejects zero/non-integers.
- The route is absent from `ROUTES`/`PORTABLE`; old parity coverage can therefore pass through proxy.

## Decision

- Extract one exported internal `persistAlignmentsInTransaction` in the existing session-write module.
  Both the public client-reported handler and finalizer call it; only the HTTP shells authorize.
- The helper requires source/provenance agreement, validates the session model, owns the complete
  cascade/audit/run/word write, and returns skip counts so finalization can abort atomically.
- Add a small shared producer-attribution boundary under `server/src/lib`; ML proxy and finalizer use
  the same validator and exact-extension check rather than duplicating trust logic.
- Add a deadline-aware private ML POST for finalization, driven by strict startup configuration.
  Never log response bodies, transcripts, tokens, audio, keys, or full upstream errors.
- Keep finalization synchronous for parity now. The approved durable outbox/job conversion remains
  W2.9 and must preserve this handler's response and atomic persistence semantics.

## Callers and proof obligations

- Affected: route registry/startup allowlist, public alignment write, ML proxy attribution boundary,
  Flutter finalization flow, alignment/finding/progress readers, release image, parity harness.
- Red first: force the finalizer route local; registry 38→39; prove happy path, consent/no transcript,
  ownership/404, producer/model mismatch, malformed output, full rollback, gaps/no gaps, and timeout.
- Run focused Node/Rust A/B, real-audio and provenance E2E through local Node, source-built non-root
  image, then the live canonical gate. Remote CI is still required before W2.6 can be checked done.
