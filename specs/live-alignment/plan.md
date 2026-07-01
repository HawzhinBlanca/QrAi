# Plan — Live alignment in the console (feature #2, persist+poll MVP)

## Context (grounded)
The learner's real alignment is computed by ml-inference (REST) and rendered in the browser
but NEVER persisted — the Command console's `GET /v1/recitation-sessions/{id}/alignments`
only ever shows SEEDED demo rows (0006_seed_internal). `word_alignments` has strict FKs:
`word_id → canonical_words(id)` (format "surah:ayah:index", matches the ML wordId exactly),
`session_id`, `model_version_id`, `audit_event_id`; status CHECK ∈ matched/misread/missed/
extra/needs-review. Synthetic "extra-N" wordIds have no canonical row.

## Acceptance (EARS)
- WHEN a learner completes an alignment for a persisted session, THE web app SHALL POST the
  results so they are stored in `word_alignments` for that session.
- WHEN the console views that session, THE stored (real) alignment SHALL appear, and the
  console SHALL refresh it periodically while open.
- Persisting SHALL skip alignments whose wordId is not a real canonical word (e.g. "extra").

## Tasks (each: edit → `bash scripts/verify.sh` green)
1. **Backend `POST /v1/recitation-sessions/{id}/alignments`** (`recitation.rs`): auth =
   session's learner or staff; verify the session exists in-tenant; DELETE existing rows for
   the session then INSERT each alignment whose word_id exists in canonical_words (skip
   others); one audit event; model_version from body (default model-v0.3). Integration test.
2. **Web api** (`lib/api.ts`): `persistSessionAlignments(sessionId, alignments, modelVersion)`.
3. **Web wire** (`App.tsx`): after `predictAlignment` in `runAlignmentAndTajweed`, persist
   (fire-and-forget, only for a real session id — not the `practice-<ts>` fallback).
4. **Console poll** (`PlatformCommand.tsx`): re-fetch session alignments on an interval while
   mounted so newly-persisted alignments appear without a manual reload.
5. **Verify**: verify.sh VERIFY OK; live proof (recite → persisted rows → console shows them);
   smoke-all green.

## Impact / risk
- New write endpoint; tenant + FK constrained; replace-on-write keeps it idempotent.
- Deferred (Phase 2, documented): true low-latency gateway-WS streaming of partial alignments.
