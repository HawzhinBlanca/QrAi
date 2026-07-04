// Regenerate the pinned FULL_QURAN_CONTENT_SHA256 in src/full-quran.ts.
//
// Run this DELIBERATELY (and review the resulting diff) only when the source Quran edition
// intentionally changes — a change to this hash means the bundled text changed, which for a Quran
// platform must be a reviewed, intentional act, never a silent drift.
//
//   node packages/quran-data/scripts/quran-content-hash.mjs
//
// The serialization MUST stay identical to computeFullQuranContentHash() in src/full-quran.ts:
// `${surahNumber}:${ayahNumber}:${text}\n` for every ayah, surah 1..114 in order.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "full-quran");
const hash = createHash("sha256");
let ayahs = 0;
for (let surahNumber = 1; surahNumber <= 114; surahNumber++) {
  const file = join(dataDir, `surah-${String(surahNumber).padStart(3, "0")}.json`);
  const surah = JSON.parse(readFileSync(file, "utf8"));
  for (const ayah of surah.ayahs) {
    hash.update(`${ayah.surahNumber}:${ayah.ayahNumber}:${ayah.text}\n`);
    ayahs++;
  }
}
console.log(`ayahs hashed: ${ayahs}`);
console.log(`FULL_QURAN_CONTENT_SHA256 = "${hash.digest("hex")}"`);
