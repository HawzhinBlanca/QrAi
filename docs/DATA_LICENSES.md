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

## quran-com-audio (playback, pre-existing)

- **What:** Per-ayah reference recitation MP3s currently used by the web player.
- **Source (legacy):** `https://cdn.islamic.network/quran/audio/128/ar.alafasy/<ayah>.mp3`.
- **Note:** For word-level highlight this repo migrates playback to the Quran.com master
  (`https://verses.quran.com/`) so audio and word timings share one master — see
  `quran-com-word-segments-audio` above and ADR-0015. The islamic.network CDN remains an acceptable
  ayah-level fallback where no word timings exist.
