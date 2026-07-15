// Shared helpers for the data-ingest scripts (fetch-word-timings, fetch-translations): CLI flag
// parsing, surah-range parsing, canonical-ayah loading, and a retrying JSON fetch. Extracted so the
// two scripts don't each re-implement them.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "full-quran");

export function getFlag(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

/** "1,78-114" -> sorted unique [1, 78, …, 114]; empty -> all 114. */
export function parseSurahArg(arg) {
  if (!arg) return Array.from({ length: 114 }, (_, i) => i + 1);
  const out = new Set();
  for (const part of arg.split(",")) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) for (let n = +m[1]; n <= +m[2]; n++) out.add(n);
    else out.add(+part);
  }
  return [...out].sort((a, b) => a - b);
}

export function loadCanonicalAyahs(surah) {
  return JSON.parse(readFileSync(join(DATA_DIR, `surah-${String(surah).padStart(3, "0")}.json`), "utf8")).ayahs;
}

/** Fetch JSON with bounded retry/backoff on 429/5xx; returns parsed JSON or throws after 4 tries. */
export async function fetchJsonWithRetry(url, userAgent) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": userAgent } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}
