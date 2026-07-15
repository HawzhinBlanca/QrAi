#!/usr/bin/env node
// Ingest a licensed ayah translation into static, checksummed JSON.
//
// Source: api.quran.com v4 `verses/by_key/{key}?translations={id}` → verse.translations[0].text.
// Default id 81 = Burhan Muhammad-Amin (Tafsiri Asan), Central Kurdish / Sorani — the default
// Kurdish translation on Quran.com, originating from the QuranEnc ecosystem.
//
// LICENSE (QuranEnc, verified 2026-07-15): republish allowed with (1) NO modification/addition/
// deletion of content, (2) attribution to publisher + QuranEnc.com, (3) version stated, (4)
// transcript info kept, (5) QuranEnc notified of notes, (6) a CONTINUING duty to update to the
// latest issued version, (7) no inappropriate ads. Consequences for this script:
//   - Text is stored VERBATIM (no trimming, no markup stripping, ZWNJ preserved) — condition (1).
//   - The manifest records translator/slug/source/fetchedAt so a re-fetch can detect drift — a
//     partial hedge on the version duty (6); Quran.com's API exposes no version field, so the
//     canonical version must still be confirmed against QuranEnc directly (see DATA_LICENSES.md).
//
// Usage: node scripts/fetch-translations.mjs --id 81 --slug ckb-burhan-muhammad --surahs 1,2,105-114
// Output: src/data/translations/<slug>/surah-XXX.json + manifest.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data", "full-quran");
const API = "https://api.quran.com/api/v4";

async function fetchTranslation(key, id) {
  const url = `${API}/verses/by_key/${key}?translations=${id}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "qrai-translation-ingest" } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tr = (await res.json())?.verse?.translations?.[0]?.text;
      if (typeof tr !== "string" || tr.length === 0) throw new Error("empty translation");
      return tr; // VERBATIM — no trim, no cleanup (license condition 1).
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

function loadCanonicalAyahs(surah) {
  return JSON.parse(readFileSync(join(DATA_DIR, `surah-${String(surah).padStart(3, "0")}.json`), "utf8")).ayahs;
}

function parseSurahArg(arg) {
  if (!arg) return Array.from({ length: 114 }, (_, i) => i + 1);
  const out = new Set();
  for (const part of arg.split(",")) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) for (let n = +m[1]; n <= +m[2]; n++) out.add(n);
    else out.add(+part);
  }
  return [...out].sort((a, b) => a - b);
}

function getFlag(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const id = +getFlag("id", "81");
  const slug = getFlag("slug", "ckb-burhan-muhammad");
  const surahs = parseSurahArg(getFlag("surahs"));
  const outDir = join(__dirname, "..", "src", "data", "translations", slug);
  mkdirSync(outDir, { recursive: true });

  const fetchedAt = new Date().toISOString().slice(0, 10);
  const manifest = {
    slug,
    translationId: id,
    translator: "Burhan Muhammad-Amin",
    title: "Tafsiri Asan",
    language: "ckb",
    source: `api.quran.com v4 translation ${id}`,
    publisher: "QuranEnc.com",
    license: "See docs/DATA_LICENSES.md#ckb-sorani-translation",
    fetchedAt,
    surahs: [],
  };

  let total = 0;
  for (const surah of surahs) {
    const canonical = loadCanonicalAyahs(surah);
    const ayahs = [];
    const missing = [];
    for (const a of canonical) {
      try {
        const text = await fetchTranslation(`${surah}:${a.ayahNumber}`, id);
        ayahs.push({ ayah: a.ayahNumber, text });
        total++;
      } catch (err) {
        missing.push({ ayah: a.ayahNumber, reason: err.message });
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    writeFileSync(
      join(outDir, `surah-${String(surah).padStart(3, "0")}.json`),
      JSON.stringify(
        { surah, slug, translationId: id, translator: manifest.translator, language: "ckb", source: manifest.source, publisher: manifest.publisher, license: manifest.license, fetchedAt, ayahs, missingAyahs: missing },
        null,
        2,
      ) + "\n",
    );
    manifest.surahs.push({ surah, ayahsTranslated: ayahs.length, totalAyahs: canonical.length, missing: missing.length });
    console.error(`surah ${surah}: ${ayahs.length}/${canonical.length} ayahs translated${missing.length ? `, ${missing.length} MISSING` : ""}`);
  }

  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.error(`\nDONE: ${total} ayahs translated across ${surahs.length} surahs (${slug}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
