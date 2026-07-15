# ROAD TO #1 — Agent Task Backlog

**Strategy of record** (from the July 2026 architecture audit + market research): QrAi will not beat
Tarteel head-on in consumer hifz. It wins two empty categories: **(1) the Quran-learning platform
for Kurdish speakers** and **(2) the AI-feedback + teacher-in-the-loop madrasa platform**. Every
task below serves one of those, or removes a platform blocker the audit found.

## Progress (updated 2026-07-15)

| Task | Status | Ref |
|------|--------|-----|
| T1 — QUL/Quran.com word-timing ingest | ✅ **DONE** | #202 |
| T2 — real-time follow-along word highlight (the Tarteel-signature feature) | ✅ **DONE** | #203 |
| T4 — Sorani (Kurdish) ayah translations | ✅ **DONE** | #204 |
| T10 — server-authoritative consent on the ML proxy | ✅ **DONE** | #205 |
| T3, T6, T7, T8 | ⏸ code-doable but heavy-ML (model downloads / GPU) — confirm infra before starting | — |
| T12, T13, T15, T16, T18 | ⏳ straightforward-code, not started | — |
| T0, T5, T7/T8 licenses, T11, on-device tests, scholar | 🔒 owner/human-gated | — |

The two features that DEFINE the #1 strategy (follow-along word highlight + Kurdish translations) are
live and merged. Each shipped change was verified live, uses only licensed/measured data (no
fabrication), and every external source has a `docs/DATA_LICENSES.md` entry + ADR (0015, 0016).

## How to execute a task (rules for any agent picking one up)

1. **Ground first.** Read every file the task names before editing. If the code no longer matches
   the task's "Current state", update the task in the PR — do not implement against a stale premise.
2. **One task = one branch = one PR.** Branch off `main`, PR title prefixed with the task ID.
3. **Proofs are mandatory.** A task is *done* only when every item in its **Required proofs** block
   is produced and pasted/linked in the PR description. No proof, no merge. "It should work" is not
   a proof.
4. **Baseline proofs for every task** (in addition to per-task proofs):
   - `bash scripts/verify.sh` exit 0 (paste the `VERIFY OK` tail). verify.sh manages its own
     Postgres PATH; DB integration tests need the quran-ai-staging compose Postgres up at
     127.0.0.1:5433 (`scripts/stack.env` exports the working DATABASE_URL) — confirm the run says
     DB tests executed, not skipped. Node via nvm v22.13.1.
   - CI green on the PR (`test` + `verify`, plus `docker-build` if docker-compose.yml changed).
   - For anything user-visible: live browser verification in the preview (screenshot or DOM/network
     evidence), not just unit tests.
5. **Licensing is a deliverable.** Any external data or model enters the repo only with an entry in
   `docs/DATA_LICENSES.md` (create it in T1): source URL, license name, license text link, exact
   attribution string we must display, date fetched, and content checksum. New runtime dependency
   or data source ⇒ ADR in `docs/DECISIONS.md` (repo rule).
6. **Never fabricate religious content.** Canonical text, translations, tajweed rules, and word
   timings come ONLY from licensed sources or measured signal. If a task cannot proceed without
   inventing content, stop and report BLOCKED with the exact missing input.
7. **The ci.yml wall.** The wall is enforced by ci.yml itself: it hard-codes the migration apply
   list AND asserts the `infra/sql/*.sql` file count matches it, so any PR adding a migration fails
   CI until ci.yml is edited. Editing ci.yml is owner-gated **by convention** (the Codystem-harness
   sentinel process — QrAi's own hooks do not block it, so agents must self-enforce). Until T0
   lands, **no task may add a SQL migration**. Reference data (timings, translations) ships as
   static, checksummed assets in `packages/quran-data` instead — a deliberate route-around, not a
   shortcut. (Plain SQL *seeds* run manually against dev/staging DBs are fine; only files in
   `infra/sql/` trip the wall.)
8. **Honest state or no state.** Every new UI surface follows the codebase rule: loading state,
   error state, and empty state — no invented numbers, no success claims before backend confirmation.

---

## T0 (OWNER — human, ~30 min): Unblock the migration wall

**Goal.** Owner performs the human-audited edit of `.github/workflows/ci.yml` (via the
`.codystem-allow-self-edit` sentinel process) so the migration list can grow past its current
hard-coded set, and merges/closes the long-open PR #123 (agent_runs erasure gap).
**Why.** T10 (migration runner), and every future DB-backed feature (word timings in Postgres,
translations tables, bookmarks) is blocked on this. Everything else below routes around it.
**Required proofs.** ci.yml diff merged on main; PR #123 closed (merged or superseded); a scratch
migration `9999_ci_wall_test.sql` applied by CI on a throwaway branch, then reverted.

---

# Workstream 1 — Follow-along recitation (Tarteel's signature, now unblocked)

## T1: Ingest QUL word-level audio segments + license registry

**Goal.** Bring word-level timing data for at least one reciter (Mishari al-Afasy) into
`packages/quran-data` as static, checksummed JSON, with full provenance.
**Why.** Real-time word-by-word follow-along is the category-defining feature. QUL
(https://qul.tarteel.ai) publishes segment timings for 59 reciters as JSON/SQLite. This was the
blocker for word highlight; it is now open data.
**Current state.** No timing data exists anywhere in the repo. `apps/web/src/lib/api.ts`
`persistSessionAlignments` hardcodes `startMs: 0, endMs: 0`. Reference playback in
`apps/web/src/App.tsx` uses per-ayah mp3s from `cdn.islamic.network` (Al-Afasy 128kbps) with
verse-level highlight only (`playingAyah`).
**Approach.**
- Download the Al-Afasy segments dataset from QUL; record its per-resource license BEFORE use.
- **Timing and audio must come from the same master.** Either (a) also adopt QUL/quran.foundation's
  Al-Afasy audio URLs as the playback source, or (b) keep cdn.islamic.network audio and PROVE
  offset compatibility empirically (see proofs). Do not assume different encodes share offsets.
- Store as `packages/quran-data/src/data/word-timings/alafasy/<surah>.json`:
  `{ surah, reciter, source, license, audioBase, ayahs: [{ ayah, audioUrl, words: [{ key: "s:a:w", startMs, endMs }] }] }`.
- Word keys must match the platform's existing word IDs (`"1:1:1"` format from
  `GET /v1/quran/ayahs/{s}/{a}`). Verify count parity per ayah (basmala handling is the classic
  off-by-one) — a mismatched surah is excluded and logged, never fudged.
- Add a generation script under `packages/quran-data/scripts/` (mirror `fetch-full-quran.mjs`
  conventions) + a checksum-integrity test (mirror `full-quran-checksum-integrity.test.ts`).
- Create `docs/DATA_LICENSES.md` with entries for: QUL segments (per-resource license), the audio
  source, and (if used as fallback) cpfair/quran-align (CC-BY 4.0). ADR for the new data source.
**Acceptance (EARS).**
- WHEN the timing JSON for surah S is loaded, THE package SHALL provide start/end ms for every word
  key that exists in the canonical text of S, or exclude S entirely with a logged reason.
- WHEN word counts differ between QUL segmentation and canonical words for an ayah, THE ingest
  script SHALL fail that ayah loudly (no silent truncation/stretching).
**Required proofs.**
1. License evidence: `docs/DATA_LICENSES.md` entry with QUL resource URL + license text link +
   attribution string; ADR merged.
2. Parity report printed by the ingest script: for ≥ 5 surahs (incl. 1, 2, 112), words-per-ayah
   count from QUL == count from `/v1/quran/ayahs` for 100% of included ayahs.
3. **Sync proof:** for 3 probe words spread across surah 1 (first word, middle word, last word),
   manually measured audio position (audible word onset) vs stored `startMs` differs by
   ≤ 150 ms, using THE audio URL the app will actually play. Paste the three measurements.
4. Checksum test green in `pnpm run test` output.

## T2: Real-time follow-along word highlight (web)

**Goal.** During reference-audio playback, the currently-recited word is highlighted in
`QuranReader`, advancing word-by-word in sync.
**Why.** Tarteel's signature UX; the single most visible gap. Depends on T1.
**Current state.** `apps/web/src/components/QuranReader.tsx` highlights the playing verse
(`playingVerseNumber` → `.is-playing`, scrollIntoView). `App.tsx` `togglePlay` creates
`new Audio(...)` per ayah and tracks `playingAyah` only.
**Approach.**
- On `timeupdate` of the playing `Audio`, compute the active word: binary search the ayah's word
  timings for `startMs ≤ t < endMs`; drive an `activePlaybackWordKey` prop into `QuranReader`
  (distinct from the existing selection/`activeWordId` semantics — do not conflate).
- `timeupdate` fires ~4 Hz; if visibly laggy, upgrade to `requestAnimationFrame` while playing.
  Keep it dumb first.
- Surahs without timing data degrade gracefully to the existing verse-level highlight (feature
  detection, no error).
- Visible attribution for the timing/audio source where the player renders (license requirement).
- Extend the smoke tests: simulate `timeupdate` at known t values → assert the right word carries
  the highlight class; assert graceful degradation when timings are absent.
**Acceptance (EARS).**
- WHEN reference audio plays at time t within ayah A, THE reader SHALL mark exactly the word whose
  [startMs, endMs) contains t, and no other word.
- WHEN no timing data exists for the selected surah, THE reader SHALL fall back to verse-level
  highlight with no console errors.
**Required proofs.**
1. Screen recording or ≥ 3 timed screenshots during live playback of surah 1 showing the highlight
   on different words mid-ayah (not just ayah boundaries).
2. DOM evidence via preview at two probe timestamps: paste the active-word element's text (use
   whatever NEW class this task introduces, e.g. `.is-reciting` — the existing `.is-playing` is the
   verse-level class and stays) and `audio.currentTime`, showing they correspond within one word.
3. Smoke tests: new assertions listed, full suite count green.
4. Fallback proof: select a surah excluded by T1 → screenshot shows verse-level behavior, zero
   console errors.

## T3: Word timestamps on the live learner path (forced alignment)

**Goal.** The learner's OWN recitation gets real per-word timestamps: replace the dead
`/v1/force-align` and the hardcoded `startMs: 0` with a working CTC forced-alignment path.
**Why.** Prerequisite for live follow-along of the learner (not just reference audio), madd-duration
measurement, and per-word audio evidence. Audit scored the ML layer 3.5/10 largely for this.
**Current state.** `services/asr-inference/server.py` `/v1/force-align` is documented dead ("no
caller exists") and is Whisper-`initial_prompt` biasing, NOT constrained alignment.
`services/ml-inference/server.mjs` `alignWords` is text-Levenshtein; all timing is dropped.
`apps/web/src/lib/api.ts` `persistSessionAlignments` (~line 254) sends `startMs: 0, endMs: 0`.
**Approach.**
- Add a true forced aligner in asr-inference via `torchaudio.functional.forced_align` driving an
  **Apache-2.0 CTC checkpoint** — e.g. `jonatasgrosman/wav2vec2-large-xlsr-53-arabic` (model card:
  apache-2.0). ⚠️ LICENSE TRAP verified 2026-07-15: `torchaudio.pipelines.MMS_FA` AND
  `MahmoudAshraf97/ctc-forced-aligner`'s default model are BOTH CC-BY-NC 4.0 (non-commercial) —
  do NOT ship either; they are acceptable only as offline accuracy baselines in eval. ADR records
  the chosen checkpoint + license.
- Rewire: ASR transcribe → alignment (text) → forced-align (timing) → `persistSessionAlignments`
  sends REAL `startMs/endMs`. Delete the dead `/v1/force-align` docstring-lie or make this its
  implementation.
- Keep it off the hot path if latency demands: timing may arrive as a fast follow-up to the text
  feedback (progressive enhancement), but it must land in `word_alignments`.
- Tests: a committed short WAV fixture (public-domain or self-recorded) with hand-labeled word
  onsets; aligner output within tolerance.
**Acceptance (EARS).**
- WHEN a recitation session completes analysis, THE persisted word_alignments SHALL contain
  non-zero, monotonically increasing startMs/endMs for ≥ 90% of matched words.
- WHEN alignment confidence for a word is below threshold, THE system SHALL store null timing for
  that word rather than an invented value.
**Required proofs.**
1. Fixture eval: table of word → labeled onset vs aligner onset for the committed fixture; median
   absolute error ≤ 120 ms.
2. Live proof: one real mic session in the preview; paste the persisted rows
   (`SELECT word_id, start_ms, end_ms FROM word_alignments ... LIMIT 10`) showing real, increasing
   timings.
3. Latency measurement: added wall-clock per request (before/after timing stage) on the dev
   machine, stated honestly in the PR.
4. License evidence for the aligner model in `docs/DATA_LICENSES.md` + ADR.

---

# Workstream 2 — Kurdish content (the empty category)

## T4: Sorani ayah translations, licensed, end-to-end

**Goal.** Every ayah the app shows can display a real Kurdish Sorani translation with attribution.
**Why.** Zero competitors serve Kurdish learners; the audit found the app has NO translation data
at all. Verified sources exist: Burhan Muhammad-Amin "Tafsiri Asan" (id 81 on live
api.quran.com/api/v4/resources/translations) and Bamoki/Salahuddin via QUL/QuranEnc.
QuranEnc license (all 7 conditions, verified at quranenc.com/en/home/about): republish allowed with
(1) NO modification/addition/deletion, (2) attribution to publisher + QuranEnc.com, (3) version
number stated, (4) transcript information kept inside the document, (5) QuranEnc notified of any
notes on the translation, (6) **a continuing duty to update to the latest issued version** —
build a version-check into the ingest script — and (7) no inappropriate advertisements.
**Approach.**
- Fetch the full Tafsiri Asan translation (QUL JSON dump preferred; else api.quran.com v4 per-ayah).
- Ship as static checksummed JSON in `packages/quran-data` (ci.yml wall — NO new DB table until
  T0/T10): `translations/ckb-tafsiri-asan/<surah>.json` with `{ key: "s:a", text }` + a manifest
  carrying source, translator, version, license, attribution string.
- Serve through the existing quran endpoints IF trivial without a migration (platform-api reads
  seeds from packages? verify) — otherwise the web app loads the static JSON directly (lazy, per
  surah). Do NOT block on backend plumbing.
- Reader UI: translation line renders under the Arabic (toggle in settings; default ON when app
  language is ckb). Arabic remains visually primary. Attribution visible (footer of reader or
  per-surah header). Translation text is NEVER machine-altered (license term): render verbatim.
- Verify integrity: spot-check n≥10 ayahs against the QuranEnc/Quran.com rendering character-for-
  character.
**Acceptance (EARS).**
- WHEN the reader shows ayah A with translations enabled, THE app SHALL render the licensed Sorani
  text for A verbatim with attribution reachable in one interaction.
- WHEN translation data is missing for A, THE app SHALL show nothing for A (no placeholder text,
  no machine translation).
**Required proofs.**
1. License entry + ADR (source URL, version, attribution string, "no modification" noted).
2. Integrity: paste the 10-ayah character-for-character comparison result (all equal).
3. Live screenshots: surah 1 with Sorani lines under Arabic, RTL correct, attribution visible;
   settings toggle off → translations gone.
4. Payload discipline: initial bundle size delta reported; per-surah JSON lazy-loaded (network tab
   evidence: fatiha JSON loads only when surah 1 opened).

## T5: Kurdish (ckb) UI strings — translation workflow + native-speaker gate

**Goal.** The 349 English UI keys get real Sorani values through a reviewable workflow — not
AI-guessed strings silently shipped.
**Why.** The default language (`lng: "ckb"`) currently renders 100% English fallback. The empty
bundle was a deliberate honesty decision (see `apps/web/src/i18n/index.ts`); the fix must preserve
its spirit: no unreviewed machine translation reaches learners.
**Approach.**
- Generate a translator packet: `locales/ckb.todo.json` (every key + English source + UI context
  comment + screenshot refs for ambiguous keys).
- Draft translations MAY be machine-assisted, but land in a `ckb.draft.json` clearly marked
  `"reviewStatus": "draft-unreviewed"` and are NOT loaded by the app.
- App loads `ckb.json` ONLY when a `reviewedBy` field names a human reviewer (native speaker —
  OWNER supplies; this is the task's single human dependency).
- Wire a CI check: `ckb.json` present ⇒ must contain `reviewedBy` + 100% key coverage or the keys
  fall back (i18next already falls back per-key; verify no raw-key rendering).
**Acceptance (EARS).**
- WHEN ckb.json lacks human review metadata, THE app SHALL keep serving English fallback.
- WHEN a reviewed ckb.json ships, THE app SHALL render Sorani for every reviewed key and English
  fallback for any missing key (never the raw key name).
**Required proofs.**
1. The packet exists and covers all keys (count == i18n key count, script-verified).
2. Gate proof: with a draft-only file, live app still renders English (screenshot).
3. After owner-supplied review (may be a later PR): live screenshot of the app in Sorani; missing-
   key fallback demonstrated by deleting one key in a test.
4. BLOCKED is acceptable at step 3 — the deliverables of THIS task are the packet + the gate.

---

# Workstream 3 — AI catch-up (close the 3.5/10)

## T6: Streaming recognition v1 (kill stop-then-batch)

**Goal.** Feedback begins while the learner is still reciting: partial transcripts land in the UI
within ~2 s of speech, not after Stop.
**Why.** Every 2026 SOTA app does live follow-along; our stop→batch flow is the biggest experienced
latency gap. The realtime-gateway (chunked audio WS) already exists and forwards to ML.
**Current state.** Web `serverAsr.ts` records fully, then POSTs one WAV. Gateway
(`services/realtime-gateway`) accepts chunked audio with tickets/backpressure but the learner
practice flow doesn't use it for live text.
**Approach.**
- v1 = chunked incremental decoding: gateway (or asr-inference) transcribes rolling windows
  (e.g. 5 s window, 1 s hop, VAD-gated) and emits partial word hypotheses over the existing WS;
  web renders "heard so far" against the ayah words (client-side matching of the growing prefix).
- Explicitly out of scope: true streaming CTC decoder — do not build custom model serving in v1.
- Measure and report: end-of-word → hypothesis-visible latency; MPS/CPU load with 3 concurrent
  sessions (the classroom question).
- Honest gating carries over: partials are marked provisional in the UI (styling, not a claim).
**Acceptance (EARS).**
- WHEN the learner is reciting with the live path enabled, THE UI SHALL show a first partial
  hypothesis within 3 s of first speech (dev hardware) and update at ≤ 2 s cadence.
- WHEN the WS drops mid-session, THE UI SHALL say so and fall back to batch analysis of the local
  recording (no silent loss — pairs with T13).
**Required proofs.**
1. Timestamped log/video of a live session: speech onset → first partial (measured ms), plus 3
   subsequent update latencies.
2. Concurrency: 3 simultaneous synthetic sessions; report p50/p95 hypothesis latency + CPU/GPU.
3. Fallback proof: kill the WS mid-session → UI messaging + batch result still lands.

## T7: Acoustic tajweed v1 — real audio evidence for 3 rules

**Goal.** Tajweed findings for madd, ghunnah, ikhfa come from the learner's AUDIO (classifier on
word segments), replacing text-rule annotation presented as recitation feedback.
**Why.** The audit's core indictment: current "findings" annotate canonical text, not the learner's
performance. QDAT + EfficientNet-B0(+SE) reaches 95–99% on exactly these 3 rules (arXiv 2503.23470).
**Approach.**
- ⚠️ LICENSE GATE (verified 2026-07-15): QDAT has **no authoritative license** — the original
  Kaggle upload reports "Unknown", the paper states none, and the HF mirror's "MIT" tag is a
  third-party re-uploader's claim, not the authors'. FIRST deliverable of this task is an owner
  action: email the QDAT authors (paper: ijasat.com #86) for written permission covering
  commercial training use. Until permission exists, training on QDAT is limited to internal
  research/eval and NOTHING trained on it ships to users. Record outcome in DATA_LICENSES.md + ADR.
- With permission: train/fine-tune the published mel-spectrogram + EfficientNet-B0 recipe. Without
  it: collect our OWN rule-labeled segments from consented pilot recordings (T9's corpus) — slower
  but unencumbered.
- Inference path: T3's word timings cut the learner audio into word segments → rule-site words
  (the rule sites ARE derivable from canonical text — that part of the existing rule engine is
  reusable and correct) → classifier scores the SITE from audio → finding carries
  `evidence: "acoustic"`, confidence from the model, and the existing review gating
  (`ai-suggested`, learner-facing only per the contracts gate).
- The old text-only annotations must either disappear from the per-recitation findings surface or
  be relabeled explicitly as "rule locations" (teaching aid), never as performance feedback.
- Eval: held-out QDAT split; report per-rule precision/recall in-repo (committed eval script, not
  hand-typed numbers — the audit specifically flagged hand-committed constants).
**Acceptance (EARS).**
- WHEN a tajweed finding reaches any user surface, THE finding SHALL be backed by an acoustic
  classification of that learner's audio segment, or be visually labeled as a canonical rule
  location (not feedback).
- WHEN classifier confidence < threshold, THE system SHALL emit no finding for that site.
**Required proofs.**
1. Reproducible eval: `python eval_qdat.py` output committed as artifact — per-rule P/R on held-out
   split; numbers within 5 points of the published baseline or an honest analysis of why not.
2. License entries (QDAT, model weights) + ADR.
3. Live end-to-end: one real recitation with a deliberately exaggerated madd → screenshot of the
   acoustic finding incl. its evidence label; one clean recitation → no false finding at the same
   site (paste both).
4. Proof the old text-annotation path no longer masquerades as feedback (diff + screenshot).

## T8: Phoneme-level pronunciation assessment (Iqra'Eval stack)

**Goal.** Word-level "misread" upgrades to phoneme-level mispronunciation detection: which sound,
where, with acoustic evidence — the makharij feedback a human teacher gives.
**Why.** The 2025–26 open stack exists: Iqra'Eval (ArabicNLP 2025) 68-phoneme inventory + corpora
(Iqra_train, Iqra_TTS, and the human-annotated benchmark — published as **IqraEval/QuranMB.v2** on
HF; "v1" was only the 2025 shared-task name) and IQRA-2026 Interspeech recipes (CTC-based SSL,
two-stage fine-tuning). Nobody in-market ships this openly; it's the leapfrog.
**Approach.**
- ⚠️ LICENSE GATE (verified 2026-07-15): Iqra_train, Iqra_TTS, and QuranMB.v2 carry **no declared
  license on their HF dataset cards** (empty license metadata). FIRST deliverable: contact the
  organizers (ArabicSpeech / IqraEval) for usage terms. Until terms exist: harness-building and
  internal eval only; nothing trained on these corpora ships. Record in DATA_LICENSES.md.
- Stage 1 (this task): reproduce a mid-table IQRA-2026 recipe — fine-tune an SSL encoder
  (w2v-BERT 2.0 or wav2vec2-XLSR-53) for phoneme recognition on Iqra_train; score learner phoneme
  sequence vs canonical (fully vowelized) reference; emit per-phoneme substitutions/deletions.
- Evaluate on QuranMB.v2; report F1 vs the published leaderboard.
- Wire behind a feature flag into the findings pipeline with the same gates as T7. UI shows
  phoneme-level detail ONLY on teacher/scholar surfaces until eval quality is proven on pilot data
  (learner surface stays word-level).
- Licenses for all datasets/checkpoints; ADR; GPU cost/time reported honestly (if dev hardware
  can't train, produce the full training script + config and mark the training run BLOCKED on
  compute — scripts + eval harness are still the deliverable).
**Required proofs.**
1. Eval harness runs end-to-end on QuranMB.v2 with a public baseline checkpoint: committed metrics
   artifact (F1, per-phoneme confusion top-10).
2. If trained: our F1 vs published leaderboard table. If BLOCKED on compute: the exact command +
   config that a GPU box would run, and the harness proof from (1).
3. One worked example end-to-end: audio fixture → phoneme diff output (paste JSON) → gated
   teacher-surface rendering (screenshot).
4. License entries + ADR.

## T9: Honest evaluation program (make quality measurable)

**Goal.** Every model claim in the product traces to a committed, re-runnable eval: ASR WER,
alignment timing error, tajweed P/R — plus a labeled pilot-recordings corpus with consent.
**Why.** Audit: "2 golden cases and asserted numbers" gate releases; teacher-agreement metric never
computed. #1 products are eval-driven; this is also the scholar-trust story for the madrasa market.
**Approach.**
- `eval/` at repo root: datasets manifest (license-checked), runners for (a) WER on EveryAyah test
  split for our served ASR model, (b) alignment MAE vs hand-labeled fixtures (extends T3), (c)
  tajweed P/R (T7), (d) phoneme F1 (T8). Each writes a JSON artifact with model version + dataset
  checksum + date.
- CI job: a NEW workflow file (e.g. `.github/workflows/eval.yml`) is verified allowed — QrAi's own
  hooks don't block `.github/` and only ci.yml's migration list is walled; the push token needs
  GitHub `workflow` scope. It runs the cheap evals on PR; heavy ones on demand.
- Pilot corpus protocol (consented, per existing consent architecture): export path for
  teacher-labeled sessions into eval format. This creates OUR flywheel — the thing Tarteel has and
  we don't.
**Required proofs.**
1. `make eval-fast` (or equivalent) runs on the dev machine: paste all artifacts.
2. WER of the CURRENT production model (tarteel whisper-base-ar-quran) measured by OUR harness on a
   held-out set, stated in the README (expect ≈ 5–8%; whatever it IS, print it).
3. The release gate references artifacts, not constants (diff of the gate).
4. One real consented session exported to eval format end-to-end (paste redacted record).

## T10: Server-side consent enforcement

**Goal.** ASR/ML proxies verify consent against STORED records for the authenticated learner;
request-body booleans stop being trusted.
**Why.** Audit red flag: child-profile protection currently trusts client-supplied consent. For a
madrasa product (minors!), this is the trust-critical fix.
**Current state.** `services/ml-inference/server.mjs` reads consent booleans from the request body
(~line 406); the platform-api proxy (`handlers/ml_proxy.rs`) contains NO consent logic at all — it
overwrites tenantId, allowlists modelVersion, and forwards the client body (including client-claimed
consent) untouched. recitation_sessions DO store consent snapshots (contracts `ConsentSnapshot`) —
they are simply never consulted on this path.
**Approach.** Platform-api proxy layer loads the session's stored consent (and child-profile /
guardian approval state) inside the tenant tx and refuses upstream forwarding on mismatch (403 with
a clean error the UI already knows how to render). ml-inference double-checks via an internal
header signed by platform-api (defense in depth) — or at minimum only accepts requests through the
authenticated proxy (verify ML_API_KEY path is already mandatory).
**Required proofs.**
1. Integration tests: (a) session without stored consent → 403 from proxy even when body claims
   consent; (b) child profile without guardian approval → 403; (c) valid consent → 200. All three
   pasted from the live test run.
2. Curl demonstration against the running dev stack (all three cases).
3. No client regression: live practice flow still works (browser proof).

---

# Workstream 4 — Platform hardening (the 7→9 backend)

## T11: Real migration runner (after T0)

**Goal.** `sqlx::migrate!` (embedded migrations, `_sqlx_migrations` table) becomes the single
schema-application path for dev, CI, and prod; compose initdb mounts become bootstrap-only or are
removed.
**Why.** Audit: "a production DB cannot be safely evolved" — no runner, compose already drifted
(0019/0020 unmounted), numbering gaps (0014/0018).
**Approach.** Renumber/normalize `infra/sql` into `services/platform-api/migrations/` in sqlx
format (document the mapping); runner executes on service start (gated by env for prod safety);
fix compose; document the drift story in an ADR; CI applies via the runner (needs T0's ci.yml edit).
**Required proofs.**
1. Fresh empty DB → service boot → `SELECT * FROM _sqlx_migrations` lists every migration; app
   integration tests green.
2. EXISTING dev DB (already migrated by hand) → runner adopts baseline without re-applying (paste
   the baseline strategy + output).
3. Drift test: delete two migrations' effects from a scratch DB → runner restores → verify.sh green.
4. docker-compose fresh boot parity: schema diff vs runner-produced schema is empty (paste diff).

## T12: TLS + secure WS end-to-end

**Goal.** nginx (or caddy) terminates TLS for web, API, and gateway (wss://); HTTP-only deploys
stop being possible by default.
**Why.** Audit: `getUserMedia` is dead over plain HTTP off-host — the pilot literally cannot record
without this. Existing nginx config/security headers exist in the deploy hardening from July 4.
**Required proofs.**
1. Local TLS stack: install mkcert first (`brew install mkcert` — NOT currently installed) or use an
   openssl self-signed CA; wire via compose `profiles:` entries or a `docker-compose.override.yml`
   (the compose file has NO profiles today — adding them is part of this task). Then: browser loads
   `https://…`, mic permission prompt appears (screenshot), recording works, WS shows `wss://` in
   the network tab.
2. curl: 301/upgrade from http; HSTS + existing security headers present on https responses.
3. Compose docs updated; `docker-build` CI check green.

## T13: Realtime resilience — WS reconnect + buffering

**Goal.** The live session survives network blips: exponential-backoff reconnect, chunk buffering
during the gap, resume or clean degrade to batch.
**Why.** Audit: no client reconnect; classroom Wi-Fi is the target environment. This was previously
deferred for lack of fault-injection — build the fault-injection first, then the fix.
**Approach.** Add a dev-only chaos hook to the gateway (env-gated: drop connections after N chunks /
on command). Client (`apps/web/src/lib/liveRecitation.ts` / `serverAsr.ts`): buffer while
disconnected (bounded, drop-oldest with UI notice), reconnect with jittered backoff, re-ticket via
the existing single-use-ticket flow, resume session or finalize as batch.
**Required proofs.**
1. Scripted chaos run: transcript of a session with 2 forced drops that still completes; log lines
   showing backoff sequence and re-ticket.
2. UI honesty: screenshot of the "reconnecting…" state and of the degraded-to-batch notice.
3. Bounded-buffer proof: forced 60 s outage → memory stays bounded, oldest-drop notice shown.
4. Unit tests for the reconnect state machine (list them; suite green).

## T14: API contract + pagination + JWT lifecycle

**Goal.** (a) OpenAPI generated from the Rust handlers (utoipa) with `packages/contracts` checked
against it in CI; (b) cursor pagination on every list endpoint (audit-events first); (c) JWT: short
TTL + refresh, `kid` rotation support.
**Why.** Audit: hand-mirrored contracts already silently dropped fields once; LIMIT 200 makes old
audit events unreachable (compliance risk); single eternal HS256 secret.
**Required proofs.**
1. `/openapi.json` served (dev); CI step diffs generated schema vs contracts (paste a deliberately
   broken-field run failing, then green).
2. Pagination: seed 250 audit events → walk 3 pages via curl (paste); old events reachable.
3. JWT: token with old kid still verifies during rotation window; refresh flow curl transcript;
   revocation of a refresh token proven.
4. verify.sh + full integration suite green (61+ tests).

## T15: Observability + load reality check

**Goal.** Prometheus-format metrics on platform-api + ml-inference + gateway, one Grafana
dashboard, and a measured answer to "what breaks first at classroom load".
**Why.** Audit: API observability is logs-only. NOTE (verified): the gateway's existing `/metrics`
returns ad-hoc JSON, NOT Prometheus exposition format — Prometheus cannot scrape it; it is also
publicly exposed (compose maps 8081 to 0.0.0.0). Per-IP rate limiter will 429 a NAT'd classroom;
nobody has measured the ASR tier's real concurrency ceiling.
**Approach.** axum-prometheus (or hand-rolled exposition format) on platform-api; re-encode the
gateway's existing GatewayMetrics counters as Prometheus text format and protect the endpoint;
ml-inference counters; compose adds prometheus+grafana via `profiles:`/override (no profiles exist
today); fix rate limiting to per-user/per-session where authenticated; k6 IS installed and
`scripts/load-test.js` already exists — extend it to: 30 concurrent learners (1 classroom) mixed
read + 5 concurrent ASR analyses.
**Required proofs.**
1. `/metrics` behind auth/localhost on all three services (curl proof of both exposure and
   protection).
2. Dashboard screenshot under load showing p95 latency + DB pool + ASR queue.
3. Load report committed to `docs/`: the measured ceiling, first bottleneck (expected: ASR CPU),
   429 behavior for a NAT'd classroom BEFORE vs AFTER the rate-limit fix (paste both).

---

# Workstream 5 — Mobile & offline (where Kurdistan lives)

## T16: Mobile app to product grade

**Goal.** apps/mobile stops being a single-file demo: expo-router navigation, i18n (same honest ckb
gate as web), RTL, expo-audio migration (expo-av is removed in SDK 54), safe-area, error/loading
states, component tests, and the T2 follow-along reader.
**Why.** Audit scored mobile as demo-grade; the pilot audience is phones.
**Approach.** Incremental PRs (structure → audio migration → reader+timings → i18n/RTL → tests).
Asset sharing (VERIFIED constraint): apps/mobile is NOT a pnpm workspace member (npm-managed, no
dependency on @quran-ai/quran-data, no metro.config.js) — Metro cannot resolve
`../../packages/quran-data` today, and Metro's static-require model means "lazy per-surah JSON
import" does not port. Choose: (a) add metro.config.js with watchFolders + extraNodeModules (or a
`file:../../packages/quran-data` dep), accepting bundle-size cost, or (b) a copy step with checksum
guard + expo-asset per-surah loading. Decide in the PR with bundle-size numbers. The
`globalThis.__recording` hack dies with the expo-audio migration.
**Required proofs.**
1. Per-PR: typecheck + tests green (count grows from 8), Expo web boot proof.
2. expo-audio: record→analyze works in Expo Go on ONE real device — owner assist for the physical
   tap-through is acceptable and requested in the PR (video or written confirmation).
3. Follow-along: web-target video of word highlight during playback on mobile UI.
4. i18n gate proof mirrors T5's.

## T17: On-device/offline recitation mode (the anti-Tarteel wedge)

**Goal.** Core loop works with no internet: on-device ASR (whisper.cpp running
tarteel-ai/whisper-base-ar-quran converted to GGML), local alignment, deferred sync.
**Why.** Tarteel is cloud-only ("requires a stable internet connection" — their own docs) and users
complain. Kurdistan connectivity makes offline a category-winning differentiator, not a nicety.
**Approach.**
- Phase A (this task): feasibility spike with proofs — convert the model to GGML (license VERIFIED
  2026-07-15: tarteel-ai/whisper-base-ar-quran is **Apache-2.0** on its HF card — commercial use
  clear; record in DATA_LICENSES.md), run whisper.cpp on the dev Mac (`brew install whisper-cpp` —
  NOT currently installed; install is step 1) and measure: model size, cold-start, per-ayah
  transcription latency, WER on 20 EveryAyah samples vs the server path. The Android-device half
  needs OWNER assist with a physical device (like T16 proof 2) — request it in the PR; the Mac
  numbers alone justify a preliminary go/no-go.
- Phase B (follow-up task, only if A's numbers hold): integrate into apps/mobile behind an
  offline flag with deferred upload/sync respecting consent.
**Required proofs (Phase A).**
1. GGML conversion command + checksum; license entry for the model.
2. Measurement table: device, model size MB, cold start s, per-ayah latency s, WER-vs-server delta
   on the 20-sample set.
3. Recommendation memo in `docs/` (go/no-go for Phase B with the numbers).

---

# Workstream 6 — The B2B madrasa product

## T18: Teacher cockpit v1 (assign → recite → review loop)

**Goal.** A teacher can: create a class (tenant-scoped), assign a surah/ayah range, see per-student
recitation results (accuracy, findings, audio where consented), and review/approve findings — the
existing review-gate machinery surfaced as a usable workflow.
**Why.** THE structural market gap: AI feedback + teacher workflow together. The hard parts
(multi-tenant RLS, teacher_reviews, scholar_approvals, consent, audit) already exist at 7/10;
what's missing is the product surface.
**Current state.** `PlatformCommand.tsx` is an ops console, not a teacher tool. TeacherSurface.tsx
is substantial (~464 lines: review queue, consented audio playback, alignments/findings display,
loading/empty states) but breaks the codebase's own conventions: it imports `useTranslation` and
never calls `t()` — every user-facing string is hardcoded English — and styles use inline physical
properties (breaks RTL).
**Approach.**
- Data: assignments need a table ⇒ depends on T0/T11. Until then, v0 MAY ship read-only: teacher
  sees real sessions/alignments/findings for their tenant's learners (endpoints exist) grouped by
  learner, with review actions wired to the existing teacher_reviews endpoint. Assignment creation
  lands with T11.
- Bring TeacherSurface up to codebase standards (i18n keys, logical CSS, loading/error/empty
  states, role-gated).
- Every learner-facing AI output shown to teachers carries its review status and confidence —
  the honest-gating story IS the sales pitch to madrasas.
**Required proofs.**
1. Live walkthrough as teacher-1: screenshots of (a) class list of real learners with real session
   stats — zero fabricated numbers (grep-level proof that every displayed number traces to an API
   field), (b) drill-down to one learner's findings with review status, (c) submitting a review →
   the learner-side gate state change (before/after API responses pasted).
2. RLS proof: teacher of tenant A cannot fetch tenant B data (curl 403/404/empty transcript).
   NOTE (verified): the dev DB has exactly ONE tenant and no institution-creation endpoint — seed
   tenant B + a teacher via direct SQL mirroring `infra/sql/0006_seed_internal.sql` (a manual seed,
   not a migration file — does not trip the ci.yml wall), or reuse the cross-tenant fixtures
   already in `tests/integration.rs`.
3. i18n/RTL parity: the surface passes the same checks as the learner flow (screenshots in ckb+RTL
   mode showing correct layout).
4. Smoke tests extended to the teacher journey (list + count).

---

## Sequencing & dependency graph

```
T0 (owner) ──► T11 ──► T18(assignments) ; T14(audit pagination migration if needed)
T1 ──► T2 ──► T16(reader)
T1 ──► T4 (shared static-asset pattern)
T3 ──► T7 ──► T8 ; T3 ──► T9(alignment eval)
T6 ──► T13 (both touch the live path; land T6 first)
T5, T10, T12, T15, T17-A : independent, start anytime
Recommended start order (max value, no blockers): T1 → T2 → T4 → T3 → T10 → T12 → T6 → T7 → T9 → …
```

**Definition of #1 (so we can measure it, not vibe it):** (a) feature-parity on follow-along +
mistake detection for the practice loop, (b) the only product with Sorani UI + translation +
teacher cockpit, (c) offline mode Tarteel doesn't have, (d) every AI claim backed by a committed
eval artifact — and (e) real madrasa pilots using it weekly. Tasks above map 1:1 onto those five.
