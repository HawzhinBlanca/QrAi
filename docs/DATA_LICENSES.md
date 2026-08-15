# External data & model licenses

Every external dataset, audio source, translation, or model checkpoint that ships in this repo (or
is required to build or serve it) must be registered in this document **before first use**. Each
entry must record its source, licence, required attribution, date fetched, and integrity check.
Religious content is never AI-generated; it is licensed or measured.

---

## muaalem-v3.2-shadow

- **What:** Optional internal acoustic Tajweed shadow candidate. The ordinary runtime image does not
  contain it; the explicit `acoustic-candidate` Docker target bundles the implementation, QPS
  package, and 2.4 GB checkpoint. It cannot produce learner-facing findings.
- **Model source:** `obadx/muaalem-model-v3_2`, immutable Hub revision
  `01a1ef9fbe40d144ef845101e89ff924aed3fef5`. The Hub metadata declares MIT and links dataset
  `obadx/muaalem-annotated-v3`, but the generated card leaves training, evaluation, risks, and
  developer fields unresolved. **Independent model/training-data licence review remains required.**
- **Implementation source:** `obadx/quran-muaalem` commit
  `2e444e040516781ecef72fe9bbc513bb34dedad4`, MIT, copyright 2025 Abdullah.
- **QPS source:** `obadx/quran-transcript` commit
  `fb64a1a8b0d7f5c38ffe26de0c69cc4a2b840950`, MIT for software. Its bundled Tanzil Uthmani v1.1
  text is CC BY 3.0, verbatim/no-changes, with source-link and notice obligations. The candidate
  image carries `ACOUSTIC_THIRD_PARTY_NOTICES.txt`. Runtime never uses that bundled text as
  authority: QPS receives the server canonical bytes directly and performs no normalization.
- **Date reviewed/fetched:** 2026-08-07.
- **Integrity:** model safetensors 2,423,124,012 bytes, SHA-256
  `6b6a2e85303d17ff0f3af5e1fc79ac83daecee409c756ddf27f0ced59393bb41`; all six configuration/
  tokenizer files are separately pinned in `acoustic-candidates.json`. Source archives are pinned
  by commit and SHA-256 in `requirements.acoustic.lock.txt`.
- **Release posture:** `shadow-only`, `releaseEligible=false`. Blocked on independent licence
  review, scholar profile approval, consented/adjudicated Kurdish-L1 held-out evaluation,
  calibration, latency/memory proof, and candidate-bound approval.

---

## wikimedia-alfatihatulkitab-cc0-v1

- **What:** A 92.72-second real Al-Fatihah recitation used only to prove ASR word-span transport,
  bounded-window composition, and fail-closed integration behavior. The audio and its manifest live
  under `tests/fixtures/audio/`; it is never eligible as a model benchmark or accuracy claim.
- **Source:** Wikimedia Commons, `File:AlFātihatulKitāb.ogg`, own work by `Ibrahimmusa4`, dated
  2024-11-08. Permanent metadata revision:
  <https://commons.wikimedia.org/w/index.php?title=File:AlF%C4%81tihatulKit%C4%81b.ogg&oldid=1218177366>.
- **License:** CC0 1.0 Universal Public Domain Dedication. No attribution is required; the source and
  author remain recorded for auditability.
- **Date fetched:** 2026-08-07.
- **Integrity:** 809,597 bytes; source SHA-1
  `671b6e324988d3752318d2e8be1fb9cc7db30e58`; repository SHA-256
  `59a4eef339d3e42aeaf9b77a6423297a0f830e4872783fc0718a64862b02df32`.
- **Captured proof:** the pinned operational Whisper `base` artifact produced the adjacent declared
  response fixture on 2026-08-07. Its positive spans prove plumbing only. Its transcript is not
  reviewed Quran text, not learner feedback, not W1.5 benchmark evidence, and cannot clear a release
  accuracy gate.

---

## alquran-cloud-quran-uthmani

- **What:** Complete canonical Uthmani Arabic Quran text: 114 Surahs and 6,236 ayahs, shipped under
  `packages/quran-data/src/data/full-quran/`. The authoritative reviewed record is the append-only
  `provenance-v1.json`; the adjacent `manifest.json` remains the historical import record.
- **Direct source:** Al Quran Cloud, edition `quran-uthmani`, acquired through
  `https://api.alquran.cloud/v1/surah`. API documentation: <https://alquran.cloud/api>.
- **Terms/license posture:** Al Quran Cloud terms, last updated 2026-06-14 and checked 2026-08-06:
  <https://alquran.cloud/terms-and-conditions>. They allow reproduction, storage, and display,
  request source acknowledgement, and require the Uthmani orthography and diacritics to be
  faithfully preserved. The terms name multiple historical/current upstream sources but do not
  map this edition to one exact upstream artifact. The corpus is therefore not labeled as a
  verified Tanzil release. If exact Tanzil provenance is later proven, its CC BY 3.0 obligations
  also apply: <https://tanzil.net/docs/Text_License>.
- **Required attribution:** "Quran text via Al Quran Cloud (quran-uthmani)."
- **Date acquired:** 2026-06-26. **Provenance reviewed:** 2026-08-06.
- **Integrity:** all 6,236 shipped ayah strings matched Al Quran Cloud's current
  `quran-uthmani` response byte-for-byte on the review date. The repository pins SHA-256
  `7d47065915b6dc645f6f975cb0eb1ec3d8f121869e911de97c69700c3fb6df5f` and checks source
  metadata, byte invariance, and the migration decision in `corpus-provenance.test.ts`.
- **Source id:** `alquran-cloud`. The older full-corpus seed label `tanzil` was incorrect metadata;
  reseeding regenerates source-bound checksums but must not alter Arabic bytes.

---

## quran-com-word-segments-audio

- **What:** Word-level audio-segment timings for reference recitations (`startMs`/`endMs` per word),
  plus the reference audio they are matched to. Shipped under
  `packages/quran-data/src/data/word-timings/<reciter>/`.
- **Source:** api.quran.com v4, `GET /verses/by_key/{key}?audio={reciterId}` →
  `verse.audio.segments` and `verse.audio.url`. Audio master served from `https://verses.quran.com/`.
  Reciter 7 = Mishary Rashid al-Afasy.
- **License:** Quran.com / Quran Foundation content. Licensing is **per-resource** (QUL FAQ:
  "you can use QUL data in commercial projects … review the licensing terms for each resource. Some
  data may have restrictions or require attribution, while others are freely available for
  commercial use"). The Al-Afasy recitation is a widely-redistributed community recitation; the
  segment data originates from the QUL/Quran.com ecosystem. **Attribution is provided in-app.**
  Before a production/commercial launch, confirm the specific reciter+segments resource's terms on
  QUL (qul.tarteel.ai) and record the exact license id here.
- **Attribution string (must be shown wherever the audio plays):**
  "Recitation: Mishary Rashid al-Afasy. Audio & word timings via Quran.com (Quran Foundation)."
- **Date fetched:** 2026-07-15.
- **Integrity:** Every timing is mapped to a canonical word id (`surah:ayah:index`) and verified
  against `packages/quran-data` canonical text by `tests/word-timings-integrity.test.ts`
  (real-word reference, time-ordering, honest exclusions). Audio↔timing match is confirmed by
  `scripts/fetch-word-timings.mjs` (deterministic normalization + strict count parity) and a
  duration cross-check (last word `endMs` ≈ real MP3 duration).
- **Regeneration:** `node packages/quran-data/scripts/fetch-word-timings.mjs --reciter 7 --slug alafasy --surahs <list>`.

---

## ckb-sorani-translation

- **What:** Central Kurdish (Sorani) ayah translation, shipped under
  `packages/quran-data/src/data/translations/ckb-burhan-muhammad/`.
  Its authoritative current provenance record is
  `packages/quran-data/src/translation-bundles.ts`:
  `2026-07-19-provenance-v2`. The older adjacent `manifest.json` is retained
  as historical import material and is not an authority for counts or release
  claims; it was generated before later source files were added.
- **Source:** api.quran.com v4, `GET /verses/by_key/{key}?translations=81`. Translation id 81 =
  **Burhan Muhammad-Amin** ("Tafsiri Asan"), the default Kurdish translation on Quran.com,
  originating from the QuranEnc.com ecosystem.
- **License (QuranEnc, verified 2026-07-15 at quranenc.com/en/home/about — all 7 conditions):**
  republish allowed with (1) **no modification/addition/deletion** of content, (2) attribution to
  **publisher + QuranEnc.com**, (3) **version stated**, (4) transcript info kept in the document,
  (5) QuranEnc notified of any notes, (6) a **continuing duty to update to the latest issued
  version**, (7) no inappropriate advertisements.
- **Compliance in this repo:**
  - (1) Text stored and rendered **verbatim** (`fetch-translations.mjs` does no trimming/cleanup;
    the reader renders it unaltered). ZWNJ and all script formatting preserved.
  - (2) Attribution shown in-app whenever translations are visible ("Translation: Burhan
    Muhammad-Amin (Tafsiri Asan) — via QuranEnc.com").
  - (3)/(6) ⚠️ **Version gap:** Quran.com's v4 API exposes no version field. The manifest records
    `fetchedAt` (2026-07-15) as a drift anchor, but the canonical QuranEnc version string must be
    confirmed directly at QuranEnc and recorded here before a production launch, and a periodic
    re-fetch scheduled to satisfy the update duty.
- **Attribution string:** "Translation: Burhan Muhammad-Amin (Tafsiri Asan) — via QuranEnc.com"
- **Date fetched:** 2026-07-15.
- **Integrity:** every ayah is translated or recorded in `missingAyahs` with a reason (108:3 has no
  entry in resource 81 — Quran.com 404s the join — shown as no-translation, never invented);
  grounded against canonical text by `tests/translations-integrity.test.ts`.
- **Regeneration:** `node packages/quran-data/scripts/fetch-translations.mjs --id 81 --slug ckb-burhan-muhammad --version <new-version> --surahs <list>`.
  Imports are append-only: the script refuses to overwrite a version directory.
- **Follow-up:** a second verified Sorani source exists (2025 Data in Brief scholar corpus,
  PMC12032946) for cross-checking; Bamoki (id 143) and Salahuddin are alternate QuranEnc Sorani
  translations if a different scholarly reading is preferred.

---

## quran-com-audio (playback, pre-existing)

- **What:** Per-ayah reference recitation MP3s currently used by the web player.
- **Source (legacy):** `https://cdn.islamic.network/quran/audio/128/ar.alafasy/<ayah>.mp3`.
- **Note:** For word-level highlight this repo migrates playback to the Quran.com master
  (`https://verses.quran.com/`) so audio and word timings share one master — see
  `quran-com-word-segments-audio` above and ADR-0015. The islamic.network CDN remains an acceptable
  ayah-level fallback where no word timings exist.
