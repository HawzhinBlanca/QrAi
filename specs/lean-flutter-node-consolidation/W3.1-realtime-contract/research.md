# W3.1 research — language-neutral realtime protocol and security decision

**Status:** implementation complete locally; required remote CI repair in progress<br>
**Method:** Serena is unavailable in this session, so symbol/reference mapping used read-only `rg`
and exact source inspection. **Target:** W3.1 / RT-1 / approved W0–W7 consolidation plan.

## Real symbols and current behavior

- `server/src/lib/ticket.mjs::{ticketPayload,signTicketPayload,issueRealtimeTicket,
  verifyRealtimeTicket,validateRealtimeTicket,newNonce}` is the Node issuer/validator. Its wire is
  `rt_v2` plus seven dot-delimited payload fields and lowercase HMAC-SHA256; expiry is a `BigInt`
  because Rust accepts the full unsigned-64-bit range.
- Pre-implementation red testing found that the Node issuer accepted negative and above-`u64`
  `BigInt` expiries, minting signed tickets the Rust validator can never parse. RTC-2 therefore
  requires a mint-time domain guard while preserving every valid wire byte and oracle vector.
- `services/shared-ticket/src/lib.rs::{TICKET_VERSION,RealtimeTicketClaims,TicketError,
  issue_realtime_ticket,validate_realtime_ticket}` is the Rust oracle used by both Rust services.
  `services/shared-ticket/tests/regenerate_vectors.rs` is the Rust-only fixture generator.
- `specs/node-backend-port/fixtures/ticket-vectors.json` has six Rust-generated vectors and is read
  directly by `tests/node-api/ticket-vectors.test.mjs` and Rust's `ticket_vectors` test module.
  Its location and N1 wording are transitional rather than language-neutral final ownership.
- `services/realtime-gateway/src/lib.rs::{validate_origin,check_ticket,audio_ws,
  handle_audio_socket,AudioIngressAck,serialize_ack}` owns upgrade admission and the JSON ack.
  Admission verifies signature/session/expiry/max lifetime/tenant, then consumes the ticket.
- `GatewayServerState.consumed_tickets` is a per-process raw-ticket map. `RealtimeGateway::
  redis_mark_ticket` adds cross-instance SHA-256-keyed Redis `SET NX EX`; configured Redis can fail
  closed, while absent Redis deliberately leaves only per-process replay protection.
- `AudioIngressAck` emits exact snake-case keys `kind,session_id,chunk_id,sequence,accepted,
  trace_id,message`. Sequence advances only after an accepted bounded-channel send.

## Consumers and data flow

- `server/src/routes/recitation.mjs::createRealtimeTicket` reads stored tenant/session/learner,
  consent/retention and mints the opaque token returned by the strict OpenAPI ticket response.
- Web: `fetchRealtimeTicket` → `startGatewayAudioUpload`; reconnects mint a fresh token, buffer
  oldest-first, and `parseGatewayAudioAck` validates all ack fields except optional `trace_id`.
- Flutter: `PracticeScreen` → `StreamingRecorder`; it constructs one ticketed socket before opening
  the microphone and streams PCM unchanged, but does not parse acknowledgments or re-ticket yet.
- Scripts and tests consuming the boundary include gateway smoke/hostile/retention/index-failure,
  teacher-audio E2E, API parity, Flutter recorder tests, and Web live-recitation tests.
- Canonical gate runs Node ticket vectors, Rust shared-ticket tests, and a real hostile WebSocket
  process. Existing fixtures do not yet pin ack serialization cross-runtime.

## Risks and planning constraints

- Never generate protocol truth from the new Node consumer; preserve the Rust-generated ticket
  oracle until both implementations pass one shared fixture, then retain the fixture after Rust.
- Moving the fixture must update both hard-coded readers and generator output atomically; copying it
  would create two authorities. Only declared test tickets/secrets belong in fixtures; production
  raw tickets/secrets must never enter a fixture, database, log, or replay record.
- Ack `message` currently embeds Rust error display strings and is not a safe permanent semantic
  enum. Freeze accepted/backpressure protocol semantics without making incidental prose authority.
- Flutter's test uses an opaque `rt_v1.token`; it does not exercise wire parsing and can hide stale
  examples. Flutter ack/reconnect work belongs to W4.11, not this contract-only task.
- W3.1 may accept the ADR and freeze fixtures only. Node process, Postgres replay table, upgrade
  handling, backpressure, and traffic movement belong to W3.2–W3.9 and need their own red tests.
- The original coarse master-plan W3.1 paragraph assigned entrypoint, admission, and replay work to
  this slice, while the approved ledger decomposes those into W3.2–W3.4. The master plan now records
  that superseding allocation instead of leaving two active scopes.

## Post-push required-CI evidence

- Required CI for candidate `c503e712df27989d12c36937c3331b762d0cbe1b` exposed two
  repository-wide prerequisites after local `VERIFY OK`; neither changes the W3.1 wire contract.
- `ci/node-min` ran the canonical Node file list on the current `ubuntu-latest` image and failed the
  existing Muaalem byte-reproduction test because `ffmpeg` was absent. `ci/verify` runs the same
  test through `scripts/verify.sh`, so both jobs are direct consumers. Skipping or weakening the
  byte assertion would remove evidence; the jobs must provision the declared tool before testing.
- `ci/verify` failed earlier at the unsuppressed `pnpm audit` gate on
  `GHSA-2v37-7h3g-55p8` / `CVE-2026-67213`. The only installed path is
  `vite -> postcss@8.5.24 -> nanoid@3.3.16`; the reviewed advisory marks `<3.3.17` vulnerable and
  `3.3.17` patched. The smallest correction is an exact same-major workspace override plus a
  regenerated frozen lockfile, not an audit ignore or an unrelated Vite upgrade.

## Second required-CI finding: the acoustic derivation was not portable

- Candidate `cdaa05e9438c7dc98d874d862f2a508ace3201c2` provisioned `ffmpeg`, so the
  missing-executable test passed. The same `ci/node-min` job then proved that installing an
  unpinned platform encoder was not sufficient: the Ubuntu output SHA-256 was
  `645066218a7aa5e60ae22c7a89d41f21054c514c1a215b1417a0a396ba4eb809`, while the committed
  macOS ffmpeg 8.1 expectation was
  `fed0dc7bf5910d0e328f7aedc140061299fa159f525f73ddb0d28de5d960660c`.
- Byte inspection found two independent sources of drift. ffmpeg writes its `Lavf` version into a
  WAV `LIST/INFO` chunk, and decoder/resampler builds differ by a few PCM bytes. A controlled
  Ubuntu 24.04 ffmpeg 6.1 run differed from the macOS PCM at four bytes. Therefore neither the
  hosted image nor an installed executable/version string can be the fixture authority.
- `tests/fixtures/audio/AlFatihatulKitab.manifest.json` already binds a tracked mono 16 kHz PCM
  derivative by size and SHA-256. The portable derivation can slice those immutable bytes at exact
  integer sample boundaries, apply the declared mute at exact integer sample boundaries, and wrap
  both payloads in a fixed 44-byte PCM WAV header using Node core only. This removes the external
  test prerequisite and makes the byte assertion stronger, not looser.
- The audit also found that ffmpeg's timeline-enabled volume filter did not apply the declared
  `0.500–1.240 s` mute. It muted complete internal frames from sample 8,192 through 20,479
  (`0.512–1.280 s`). The portable implementation must use the declared half-open interval, samples
  8,000 through 19,839, and refresh the structural exact-image observation rather than relabel the
  old model output.
- The exact pinned image was rerun locally against the proposed canonical WAVs without a source
  mount. The correct vector retained predicted-phoneme digest
  `5020dd2aadcea264201d6a937c41b8413d00b49b3bb5f312fc336fd4571cc555`; the corrected altered
  vector produced 27 phonemes and digest
  `1cce8531d8141b8f0cb292e92a331f436f831aa7dede5a1d4b3dbb7485932750`. Both remained
  uncalibrated, withheld all numeric sifat scores, and emitted no learner finding or confidence.

## Third required-CI finding: nginx syntax proof lacked its declared DNS peer

- Candidate `276b386fd4e7be0da3ed61006365660986ad02dc` made `ci/node-min` green, then
  `docker-build/build` failed after all images, non-root checks, and the clean Node image smoke had
  passed. The failing command was `docker compose run --rm --no-deps web nginx -t`.
- The rendered configuration correctly selected the allowlisted `platform-api:8080`, but
  `--no-deps` deliberately started no `platform-api` container. Docker Compose service names are
  DNS aliases of running network endpoints, not static declarations, so nginx rejected the config
  with `host not found in upstream "platform-api"`. This is a test-harness topology defect, not an
  application config failure and not evidence that the allowlist should be weakened.
- The smallest truthful proof is ephemeral no-dependency `platform-api` and `realtime-gateway`
  one-off containers with `--use-aliases`, kept alive only while the web config is checked and
  removed by one trap. They give nginx both exact production service DNS names without booting
  either binary, the database, migrations, or workers. The following hostile selector probe must
  still fail before nginx starts.

## Fourth required-CI finding: complete Flutter evidence and Python test prerequisites

- Candidate `276b386fd4e7be0da3ed61006365660986ad02dc` also reached the Flutter and Python
  portions of the canonical gate. Flutter analysis found one pre-existing single-line `for` in
  `tajweed_gate_test.dart`, which is an error under the repository's `--fatal-infos` policy.
- Six Flutter tests then failed for one shared reason rather than six runtime defects. W1.12 made
  `TajweedFinding.isLearnerVisible` require a complete, release-trusted acoustic evidence chain,
  but the `tajweed_panel_test.dart` and `practice_screen_test.dart` builders still create the older
  minimal finding shape. Their approved findings are therefore correctly withheld. The shared
  corpus test has the evidence fields but passes its deliberately gate-only `base` directly to the
  full Dart wire parser without the required presentation fields (`wordId`, `rule`, `severity`, and
  `explanation`), so its two visible vectors fail closed before the predicate runs.
- The repair is test-data-only: make those declared fixtures complete acoustic evidence and merge
  the gate corpus into a valid wire envelope before evaluating it. Production parsing and the
  learner gate remain unchanged; no fabricated output is presented as a model result.
- The Python stage invokes `python3 -m pytest` for the attribution and acoustic suites, while CI
  installs only NumPy. The exact remote failure is `No module named pytest`. CI must install the
  test runner it directly invokes. Pinning the current Python-3.11-compatible NumPy and pytest
  releases makes that prerequisite reproducible without adding either package to a runtime image.
