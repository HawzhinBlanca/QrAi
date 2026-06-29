# Quran AI — 10/10 True Implementation Plan

**Goal:** Transform from text-processing demo (4.2/10) to real recitation intelligence platform (10/10).

**Principle:** Zero stubs. Zero fake data. Zero mock imports. Everything real, everything proven.

---

## Phase 0: Restore Green Baseline (Day 1)

Fix all 4 broken smoke tests. No new features — just make `pnpm smoke:all` pass again.

### 0.1 Fix smoke:ml — datasetVersion mismatch
- **Root cause:** ML health returns `manifest.importVersion` from full-quran manifest, but smoke expects fixture's `datasetVersion` = `"fatihah-juz-amma-smoke-v1"`.
- **Fix:** ML health endpoint must expose `goldenCases` and `datasetVersion` from the fixture file, not just the Quran manifest.

### 0.2 Fix smoke:privacy — missing `externalAsr.called` field
- **Root cause:** ML `predictAlignment` doesn't return `externalAsr` object. Privacy smoke expects `denied.externalAsr.called === false`.
- **Fix:** ML server must implement consent-gated external ASR logic: check `consent.externalAsrProcessing && consent.guardianApproved`, return `externalAsr: { called: bool, reason: string }`.

### 0.3 Fix smoke:api — teacher queue returns empty
- **Root cause:** Teacher review POST fails (FK: `finding-smoke` doesn't exist in `tajweed_findings`). Queue is empty. Smoke asserts `queue.body.length < 1` → fails.
- **Fix:** Seed a real tajweed finding via SQL before the teacher review test, or adjust smoke to accept empty queue when no findings seeded.

### 0.4 Fix smoke:browser — mobile-home report missing
- **Root cause:** Chrome headless `--dump-dom` doesn't find `#browser-smoke-report` in the mobile-home case. Likely a timing issue with `--virtual-time-budget`.
- **Fix:** Increase virtual time budget or add `--run-all-compositor-stages-before-draw` flag.

**Proof gate:** `pnpm smoke:all` passes all 8 steps with zero failures.

---

## Phase 1: Kill All Mock Data (Day 2-3)

Replace every static import with real API calls. No more `data/platform.ts` mock objects in the learner path.

### 1.1 Replace `data/quran.ts` with real API calls
- `quranVerses` → `fetchSurah(1)` from `/v1/quran/surahs/1`
- `recitationEvents` → derived from real alignment results
- `similarVerses` → new `/v1/quran/mutashabihat` endpoint (or compute from data)
- `weeklyProgress` → new `/v1/learner/progress` GET endpoint

### 1.2 Replace `data/platform.ts` with real API calls
- `activeSession` → from recitation session API
- `memorizationPlan` → from `/v1/learner/progress` GET

### 1.3 Remove silent catch in `runAlignmentAndTajweed`
- Replace `} catch { // API unreachable — keep practicing with mock data }` with real error state in UI
- Show connection error to learner, not fake success

### 1.4 Wire mastery ring and progress to real SM-2 data
- Hardcoded `78%` mastery → real `/v1/learner/progress` response
- Hardcoded `32 correct, 3 mistakes` → real session alignment results

**Proof gate:** Browser DevTools Network tab shows only real API calls. Zero `data/platform.ts` or `data/quran.ts` imports in the learner path. Screenshot proof.

---

## Phase 2: Real Audio Pipeline (Day 4-5)

The gateway currently forwards metadata only. ML stores metadata only. Fix this end-to-end.

### 2.1 Gateway: forward real audio bytes to ML
- `handle_audio_socket` currently sends JSON metadata only (`serde_json::json!({"tenantId":..., "chunkId":...})`)
- Add `bytes` field with base64-encoded audio data from `AudioChunk.bytes`
- Add `sampleRate` field (already exists but unused by ML)

### 2.2 ML service: store real audio bytes
- `storeAudioChunk` currently writes `.meta.json` only
- Write actual audio bytes to `{chunkId}.bin`
- Verify: read back the file, check size matches

### 2.3 ML service: accept audio bytes in alignment prediction
- `/v1/alignments:predict` currently expects `recognizedText` (text input)
- Add `audioBase64` field: if present, store audio and process it
- The audio is available for the ASR model (Phase 3)

### 2.4 Frontend: send real audio chunks via WebSocket
- Currently `App.tsx` uses Web Speech API for text → ML
- Add: capture audio with `MediaRecorder`, send binary frames to gateway
- Gateway already handles `Message::Binary` — just wire the frontend

**Proof gate:** Record audio in browser → gateway receives binary → ML stores `.bin` file → verify file size > 0. Screenshot of `ls -la audio-storage/`.

---

## Phase 3: Real Acoustic ASR (Week 2-4)

Replace Web Speech API with a real Quranic Arabic ASR model. This is the core moat.

### 3.1 Model Selection
- **Option A:** Fine-tune OpenAI Whisper (medium/large) on Quranic Arabic recitation data
- **Option B:** Use a pre-trained Quranic ASR model (e.g., from Hugging Face: `facebook/mms-1b-all`, `jonatasgrosman/wav2vec2-lv-60-espeak-cv-ft`)
- **Option C:** Use a CTC-based acoustic model with Quranic phoneme inventory
- **Recommended:** Option A — Whisper fine-tune, because it handles variable audio quality, has built-in alignment, and can be fine-tuned with Quran data

### 3.2 Training Data
- Source: EveryAyah audio (https://everyayah.com/data/) — 6236 ayahs × multiple reciters
- Format: MP3 per ayah, paired with canonical Uthmani text
- Augment: speed variation (0.9x-1.1x), noise injection, pitch shift
- Target: 10,000+ aligned audio-text pairs for fine-tuning

### 3.3 Inference Service
- Python/FastAPI service wrapping the fine-tuned model
- Accept audio bytes → return recognized text + word-level timestamps
- Use `whisper` library's `transcribe()` with `word_timestamps=True`
- Deploy as `services/asr-inference/` (new Python service)

### 3.4 ML Pipeline Integration
- ML inference service calls ASR service: audio bytes → text + timestamps
- Alignment engine receives ASR text + timestamps
- Alignment compares ASR text vs canonical text using existing Levenshtein
- Word-level timestamps enable per-word timing analysis

**Proof gate:** Upload a real Al-Fatihah recitation audio → ASR returns recognized Arabic text → alignment produces word-by-word match/miss/error with timestamps. Screenshot of API response.

---

## Phase 4: Real Force Alignment (Week 4-5)

Audio-to-text alignment with timestamps, not just text comparison.

### 4.1 Implement CTC-based force alignment
- Use `torchaudio`'s CTC forced alignment: `torchaudio.functional.forced_align()`
- Input: audio mel-spectrogram + canonical text tokens
- Output: frame-level alignment → word-level timestamps

### 4.2 Quranic phoneme tokenizer
- Map Uthmani Arabic text → IPA phoneme sequence
- Handle tajweed-specific phonemes (ghunnah duration, madd length, qalqalah)
- 38 phonemes covering all Quranic Arabic sounds

### 4.3 Per-word timing extraction
- Force alignment produces frame-level token timestamps
- Aggregate frames → word-level start/end times
- Feed timestamps to tajweed analysis (Phase 5)

**Proof gate:** Input audio + canonical text → output JSON with per-word `{word, startMs, endMs, confidence}`. Compare timestamps against human-labeled ground truth on 10 ayahs.

---

## Phase 5: Real Tajweed Analysis on Audio (Week 5-7)

Detect tajweed errors from audio features, not text regex.

### 5.1 Audio feature extraction
- Extract per-word audio segments using force alignment timestamps
- Features: pitch (F0), duration, formants (F1-F3), energy, spectral centroid
- Compare learner audio vs reference reciter audio

### 5.2 Rule-based audio tajweed checker
- **Madd:** Measure vowel duration vs reference (should be 2 counts)
- **Ghunnah:** Measure nasal resonance duration and intensity
- **Qalqalah:** Detect bounce/echo pattern on ق ط ب ج د
- **Tafkhim:** Measure F1/F2 ratio (heavy vs light pronunciation)

### 5.3 ML-based tajweed classifier (stretch)
- Train a classifier on labeled tajweed error data
- Input: audio features per word
- Output: {rule, severity, confidence} per word
- Requires labeled training data from certified teachers

**Proof gate:** Submit a real recitation with a deliberate madd error → system detects the error with >80% accuracy on 20 test cases.

---

## Phase 6: Production Infrastructure (Week 7-8)

### 6.1 Object storage (MinIO or S3)
- Replace local filesystem audio storage with MinIO/S3
- Tenant-scoped buckets with lifecycle policies
- Audio retention enforcement: discard mode deletes immediately

### 6.2 NATS JetStream event bus
- Replace in-memory audit events with NATS
- Event subjects from contracts: `recitation.alignment.partial`, `ml.tajweed.predicted`, etc.
- At-least-once delivery, durable subscriptions

### 6.3 Production auth provider
- Replace dev header fallback with OAuth2/OIDC
- Support email/password, Google, Apple sign-in
- JWT refresh tokens, not just 24h access tokens

### 6.4 Redis for session state
- Replace in-memory gateway sessions with Redis
- Enables horizontal scaling of gateway instances

### 6.5 Docker Compose for full stack
- Postgres + pgvector, MinIO, NATS, Redis, API, Gateway, ML, ASR, Web
- `docker-compose up` runs everything

**Proof gate:** `docker-compose up` → all services healthy → full smoke:all passes against containerized stack.

---

## Phase 7: Mobile App (Week 8-10)

### 7.1 Expo/React Native app
- Share contracts and API client with web
- Native audio recording with proper permissions
- Offline Quran text cache
- Push notifications for spaced repetition reviews

### 7.2 Offline ASR
- On-device Whisper tiny model for basic feedback
- Full ASR when online

**Proof gate:** Install on physical device → recite Al-Fatihah → receive word-by-word feedback.

---

## Phase 8: Live RLS Proof + Pilot (Week 10-12)

### 8.1 Live Postgres RLS proof
- `SQL_SMOKE_REQUIRE_LIVE=true pnpm smoke:sql` passes
- Two tenants in live Postgres, verify cross-tenant isolation

### 8.2 Pilot with real learners
- 5-10 learners from `hikmah-pilot-erbil`
- Collect: alignment F1, tajweed accuracy, teacher agreement, latency, retention
- Publish pilot report

**Proof gate:** Pilot report with real metrics from real learners.

---

## Phase 9: Full E2E 10/10 Verification (Week 12)

### 9.1 Complete proof checklist
- [ ] `pnpm smoke:all` passes all 8 steps, 0 failures
- [ ] Browser: learner can recite → see real word-by-word feedback
- [ ] API: all 17 routes work against live Postgres
- [ ] Gateway: real audio bytes flow through WebSocket → ML
- [ ] ML: real ASR model transcribes audio → real alignment → real tajweed
- [ ] Privacy: audio deletion removes real files from object storage
- [ ] RLS: two tenants cannot read each other's data in live Postgres
- [ ] Mobile: app installs and works on physical device
- [ ] No mock data imports in learner path
- [ ] No silent error catches hiding failures

### 9.2 Final audit
- Re-run the deep audit from scratch
- Score must be 9/10 or higher
- Every "Tier 1: Does Not Exist" item must be checked off

---

## Timeline Summary

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 0 | Day 1 | All smoke tests pass |
| 1 | Day 2-3 | Frontend uses real API data |
| 2 | Day 4-5 | Real audio bytes flow end-to-end |
| 3 | Week 2-4 | Real ASR model transcribes Quranic audio |
| 4 | Week 4-5 | Force alignment with timestamps |
| 5 | Week 5-7 | Tajweed analysis on audio features |
| 6 | Week 7-8 | Production infrastructure |
| 7 | Week 8-10 | Mobile app |
| 8 | Week 10-12 | Live RLS proof + pilot |
| 9 | Week 12 | Full 10/10 verification |

**Total: ~12 weeks for true 10/10.**

Phases 0-2 are achievable now. Starting immediately.
