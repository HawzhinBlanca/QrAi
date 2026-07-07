#!/usr/bin/env node
/**
 * Fetches the complete Quran (114 surahs, 6236 ayahs) from alquran.cloud API.
 * Outputs JSON files per-surah and a combined manifest.
 *
 * API: https://api.alquran.cloud/v1/surah/{N}/quran-uthmani
 * Rate-limit: ~10 requests/second (we use 3 concurrent with delay)
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "src", "data", "full-quran");
const MANIFEST_PATH = join(OUTPUT_DIR, "manifest.json");

mkdirSync(OUTPUT_DIR, { recursive: true });

const API_BASE = "https://api.alquran.cloud/v1/surah";
const EDITION = "quran-uthmani";

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchWithRetry(url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchJson(url);
    } catch (error) {
      if (attempt === maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function fetchSurahList() {
  const data = await fetchWithRetry(`${API_BASE}`);
  return data.data;
}

async function fetchSurah(surahNumber) {
  const data = await fetchWithRetry(`${API_BASE}/${surahNumber}/${EDITION}`);
  return data.data;
}

// Split Arabic text into words by whitespace
function splitWords(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

async function processSurah(surahMeta) {
  const surah = await fetchSurah(surahMeta.number);
  const ayahs = surah.ayahs.map((ayah) => {
    const words = splitWords(ayah.text);
    return {
      surahNumber: surahMeta.number,
      ayahNumber: ayah.numberInSurah,
      text: ayah.text,
      words,
      wordCount: words.length,
    };
  });

  const totalWords = ayahs.reduce((sum, ayah) => sum + ayah.wordCount, 0);
  const surahId = `${surahMeta.number}`;

  // Write surah file
  const surahData = {
    id: surahId,
    surahNumber: surahMeta.number,
    name: surahMeta.name,
    englishName: surahMeta.englishName,
    englishNameTranslation: surahMeta.englishNameTranslation,
    revelationType: surahMeta.revelationType,
    numberOfAyahs: surahMeta.numberOfAyahs,
    totalWords,
    ayahs,
  };

  const surahPath = join(OUTPUT_DIR, `surah-${String(surahMeta.number).padStart(3, "0")}.json`);
  writeFileSync(surahPath, JSON.stringify(surahData, null, 2));

  return {
    surahNumber: surahMeta.number,
    name: surahMeta.name,
    englishName: surahMeta.englishName,
    ayahCount: ayahs.length,
    wordCount: totalWords,
    filePath: `surah-${String(surahMeta.number).padStart(3, "0")}.json`,
  };
}

async function main() {
  console.log("Fetching surah list from alquran.cloud...");
  const surahList = await fetchSurahList();
  console.log(`Found ${surahList.length} surahs.`);

  const manifest = [];
  let totalAyahs = 0;
  let totalWords = 0;

  // Process in batches of 5 to avoid rate limiting
  const BATCH_SIZE = 5;
  for (let i = 0; i < surahList.length; i += BATCH_SIZE) {
    const batch = surahList.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((s) => processSurah(s)));

    for (const result of results) {
      manifest.push(result);
      totalAyahs += result.ayahCount;
      totalWords += result.wordCount;
      console.log(
        `  Surah ${result.surahNumber}: ${result.englishName} - ${result.ayahCount} ayahs, ${result.wordCount} words`,
      );
    }
  }

  // Write manifest
  const manifestData = {
    source: "alquran.cloud",
    edition: "quran-uthmani",
    apiUrl: "https://api.alquran.cloud/v1/surah",
    importVersion: `full-quran-${new Date().toISOString().split("T")[0]}`,
    surahCount: manifest.length,
    totalAyahs,
    totalWords,
    surahs: manifest,
  };

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifestData, null, 2));

  console.log("\n=== Quran Ingestion Complete ===");
  console.log(`Surahs: ${manifest.length}`);
  console.log(`Total Ayahs: ${totalAyahs}`);
  console.log(`Total Words: ${totalWords}`);
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log(`Manifest: ${MANIFEST_PATH}`);
}

main().catch((error) => {
  console.error("Ingestion failed:", error);
  process.exit(1);
});
