# External data & model licenses

Every external dataset, audio source, translation, or model checkpoint that ships in this repo (or
is required to build/serve it) is registered here BEFORE use, per `docs/ROAD_TO_1_TASKS.md` rule 5.
Each entry records: source, license, the attribution string we must display, date fetched, and how
integrity is checked. Religious content is never AI-generated; it is licensed or measured.

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
