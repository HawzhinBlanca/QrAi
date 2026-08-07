# W2.14 impact map — private retained-audio object lifecycle

Serena is unavailable; these references were mapped with `rg` before edits.

| Symbol/surface | Direct callers/consumers | Required preservation or change |
|---|---|---|
| ML `storeAudioChunk`, `storeAudioObject`, conflict check | Rust gateway, privacy/smoke tools, overwrite/retention/index E2E | Shared async store; same retry succeeds, conflict refuses, key becomes server-derived |
| ML `readAudioObject` | Node/Rust teacher-audio proxy, playback parity | Shared read validates identity, metadata, retention, length, SHA; no signed URL |
| ML `listAudioObjects`, `exportPrivacy`, `deletePrivacy` | ML privacy routes/tests; Node `privacy.mjs` | Paginated learner prefix; direct Node primary path; compatibility HTTP fallback only |
| ML `loadSessionPcm`, retention sweep/cleanup | finalization, acoustic shadow, transcript/retention tests | Use store session/list/read APIs; preserve gaps, expiry, sample-rate and retention semantics |
| Node `indexAudioChunk` | gateway; audio-index parity/playback chain | Derive versioned key from verified ticket/session; caller key has no authority |
| Node `getFindingAudio` | teacher/admin/ops playback | Direct injected store, dual consent check, complete-body validation, audit attempted→served |
| Node `createPrivacyJob`/`eraseMlAudio` | learner/admin/ops privacy API | Inventory audio on export; erase storage first; keep DB unchanged on storage failure |
| `createApplication`/`main.mjs`/shutdown | every Node route and child-process test | Inject/configure store, readiness and bounded close; explicit compatibility fallback |
| Rust `index_audio_chunk`; gateway `handle_audio_socket` | parity oracle and current realtime path | Match derived-key rule; stop forwarding authoritative `objectKey` |
| `repair-audio-index.mjs` | package command, operations profile, teacher-audio E2E | Storage-neutral reconciliation; legacy filesystem support; dry-run/apply and inverse orphans |
| OpenAPI/internal contracts | route completeness, parity, gateway | `objectKey` no longer required/authoritative; response shape unchanged |
| Docker/Compose/backup/data docs | local stack, images, operators | Explicit driver/config, private S3 production contract, filesystem local/test boundary |
| Canonical verification | `scripts/verify.sh`, invocation guard | Register lifecycle test exactly once and keep live DB skip explicit |

No canonical Quran bundle, learner-feedback gate, login posture, public role list, or RLS bypass is
changed. A new runtime dependency and storage implementation note are required by ADR-0050.
