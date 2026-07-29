#!/usr/bin/env node
// Ingest word-level audio-segment timings for a reciter into static, checksummed JSON.
//
// Source: api.quran.com v4 `verses/by_key/{key}?audio={reciterId}` → verse.audio.segments,
// each `[segIndex, wordNumber, startMs, endMs]`. The audio URL in the same response is
// Quran.com's own master (served from https://verses.quran.com/), so the timings and the audio
// we will play are matched by construction — no cross-master drift.
//
// The hard part is that our canonical word segmentation (packages/quran-data full-quran) does NOT
// match Quran.com's for two DETERMINISTIC reasons, verified 2026-07-15:
//   (1) our ayah 1 of a basmala-bearing surah PREPENDS the 4 basmala words (Quran.com keeps the
//       basmala separate and its per-ayah audio excludes it);
//   (2) our text tokenizes standalone waqf/pause marks (e.g. ۛ U+06DB) as their own "words";
//       Quran.com attaches them to the preceding word.
// Neither is randomness, so we normalize BOTH away deterministically and then REQUIRE exact
// count parity before mapping. Any ayah that still doesn't match is EXCLUDED and logged — never
// truncated, stretched, or guessed. Basmala/waqf tokens receive no timing (they carry no separate
// segment in Quran.com's audio), which is honest: the reader simply won't highlight them.
//
// Usage:
//   node scripts/fetch-word-timings.mjs --reciter 7 --slug alafasy --surahs 1,78-114
//   node scripts/fetch-word-timings.mjs --verify 2:2   # print the alignment for one ayah
//
// Output: src/data/word-timings/<slug>/surah-XXX.json  +  src/data/word-timings/<slug>/manifest.json

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getFlag, parseSurahArg, loadCanonicalAyahs, fetchJsonWithRetry } from "./_ingest-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = "https://api.quran.com/api/v4";
const AUDIO_BASE = "https://verses.quran.com/";

// The 4 canonical basmala words, diacritics-insensitive skeleton (see normalizeSkeleton).
const BASMALA_SKELETON = ["بسم", "الله", "الرحمن", "الرحيم"];

// A token is a pure waqf/pause/sajdah mark (not a recited word) when every character is a
// combining Arabic small-high sign in U+06D6..U+06ED (the Quran annotation block) — no base letter.
function isWaqfToken(tok) {
  const t = tok.replace(/[​-‏﻿]/g, ""); // strip zero-width / BOM
  if (!t) return true;
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (!(c >= 0x06d6 && c <= 0x06ed)) return false;
  }
  return true;
}

// Diacritic/tatweel/BOM-stripped consonant skeleton, for basmala detection only (never shipped).
function normalizeSkeleton(word) {
  return word
    .replace(/[​-‏﻿ـ]/g, "")
    .replace(/[ً-ٰٟۖ-ۭ࣓-ࣿ]/g, "")
    .replace(/ٱ/g, "ا") // alef wasla → alef
    .replace(/[آأإ]/g, "ا"); // alef variants → alef
}

async function fetchSegments(key, reciterId) {
  const json = await fetchJsonWithRetry(
    `${API}/verses/by_key/${key}?audio=${reciterId}`,
    "qrai-word-timings-ingest",
  );
  const audio = json?.verse?.audio;
  if (!audio?.segments) throw new Error("no segments in response");
  return audio;
}

// Map Quran.com segments onto our canonical word ids. Returns {words, reason?} — reason set means
// the ayah is excluded. `words` is [{wordId, startMs, endMs}] for the aligned recited words only.
function alignAyah(surah, ayahNumber, canonicalWords, audio) {
  // Original 1-based index preserved so timings attach to the true canonical word id.
  const indexed = canonicalWords.map((text, i) => ({ id: `${surah}:${ayahNumber}:${i + 1}`, text }));

  // (2) drop standalone waqf tokens.
  let recited = indexed.filter((w) => !isWaqfToken(w.text));

  // (1) drop a leading basmala on ayah 1 of a basmala surah (i.e. when the ayah is MORE than the
  // bare basmala — Al-Fatihah 1:1 IS exactly the basmala, count 4, and must be kept).
  if (ayahNumber === 1 && recited.length > 4) {
    const head = recited.slice(0, 4).map((w) => normalizeSkeleton(w.text));
    if (head.every((s, i) => s === BASMALA_SKELETON[i])) recited = recited.slice(4);
  }

  const segments = audio.segments;
  if (recited.length !== segments.length) {
    return {
      reason: `count mismatch: ${canonicalWords.length} canonical words (${recited.length} recited after normalization) vs ${segments.length} segments`,
    };
  }

  const words = recited.map((w, k) => {
    const seg = segments[k]; // [segIndex, wordNumber, startMs, endMs] — start/end are the last two.
    const startMs = seg[seg.length - 2];
    const endMs = seg[seg.length - 1];
    return { wordId: w.id, startMs, endMs };
  });

  // Timings must be well-formed: positive duration and monotonic. Quran.com's source occasionally
  // has a zero- or negative-duration segment (observed at 2:164:22, 2:249:52) — exclude the whole
  // ayah loudly rather than ship a degenerate word the highlighter can never land on.
  for (let k = 0; k < words.length; k++) {
    if (words[k].endMs <= words[k].startMs) {
      return { reason: `degenerate segment (end<=start) at word ${words[k].wordId}` };
    }
    if (k > 0 && words[k].startMs < words[k - 1].startMs) {
      return { reason: `non-monotonic segment start at word ${words[k].wordId}` };
    }
  }
  return { words, audioUrl: audio.url };
}

async function main() {
  const verifyKey = getFlag("verify");
  const reciterId = +getFlag("reciter", "7");
  const slug = getFlag("slug", "alafasy");

  if (verifyKey) {
    const [s, a] = verifyKey.split(":").map(Number);
    const audio = await fetchSegments(verifyKey, reciterId);
    const canonical = loadCanonicalAyahs(s).find((x) => x.ayahNumber === a).words;
    const res = alignAyah(s, a, canonical, audio);
    console.log(JSON.stringify({ key: verifyKey, canonical, ...res }, null, 2));
    return;
  }

  const surahs = parseSurahArg(getFlag("surahs"));
  const outDir = join(__dirname, "..", "src", "data", "word-timings", slug);
  mkdirSync(outDir, { recursive: true });

  let totalAyahs = 0;
  let shippedAyahs = 0;
  const manifest = { reciter: slug, reciterId, source: `api.quran.com v4 recitation ${reciterId}`, audioBase: AUDIO_BASE, surahs: [] };

  for (const surah of surahs) {
    const canonical = loadCanonicalAyahs(surah);
    const ayahs = [];
    const excluded = [];
    for (const a of canonical) {
      totalAyahs++;
      let audio;
      try {
        audio = await fetchSegments(`${surah}:${a.ayahNumber}`, reciterId);
      } catch (err) {
        excluded.push({ ayah: a.ayahNumber, reason: `fetch failed: ${err.message}` });
        continue;
      }
      const res = alignAyah(surah, a.ayahNumber, a.words, audio);
      if (res.reason) {
        excluded.push({ ayah: a.ayahNumber, reason: res.reason });
      } else {
        ayahs.push({ ayah: a.ayahNumber, audioUrl: res.audioUrl, words: res.words });
        shippedAyahs++;
      }
      await new Promise((r) => setTimeout(r, 25)); // be polite to the public API
    }
    const surahOut = {
      surah,
      reciter: slug,
      reciterName: "Mishary Rashid al-Afasy",
      source: manifest.source,
      audioBase: AUDIO_BASE,
      license: "See docs/DATA_LICENSES.md#quran-com-word-segments-audio",
      ayahs,
      excludedAyahs: excluded,
    };
    writeFileSync(join(outDir, `surah-${String(surah).padStart(3, "0")}.json`), JSON.stringify(surahOut, null, 2) + "\n");
    manifest.surahs.push({ surah, ayahsWithTimings: ayahs.length, ayahsExcluded: excluded.length, totalAyahs: canonical.length });
    console.error(`surah ${surah}: ${ayahs.length}/${canonical.length} ayahs timed, ${excluded.length} excluded`);
  }

  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.error(`\nDONE: ${shippedAyahs}/${totalAyahs} ayahs shipped with word timings across ${surahs.length} surahs.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
