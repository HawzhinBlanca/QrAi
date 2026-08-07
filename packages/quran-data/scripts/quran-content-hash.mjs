// Regenerate the immutable legacy checksum and the provenance-v2 length-delimited hashes.
//
// Run this DELIBERATELY (and review the resulting diff) only when a new reviewed corpus bundle is
// introduced. This script reads the source JSON independently of src/full-quran.ts and never writes
// canonical data.
//
//   node packages/quran-data/scripts/quran-content-hash.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "full-quran");
const lengthPrefixBytes = 8;

function lengthDelimitedUtf8(value) {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(lengthPrefixBytes);
  prefix.writeBigUInt64BE(BigInt(bytes.byteLength));
  return Buffer.concat([prefix, bytes]);
}

function updateLengthDelimitedRecord(hash, fields) {
  const payload = Buffer.concat(fields.map((field) => lengthDelimitedUtf8(field)));
  const prefix = Buffer.alloc(lengthPrefixBytes);
  prefix.writeBigUInt64BE(BigInt(payload.byteLength));
  hash.update(prefix);
  hash.update(payload);
}

const legacyHash = createHash("sha256");
const ayahHash = createHash("sha256");
const wordTokenHash = createHash("sha256");
ayahHash.update(lengthDelimitedUtf8("qrai.full-quran.ayahs.v1"));
wordTokenHash.update(lengthDelimitedUtf8("qrai.full-quran.word-tokens.v1"));

let ayahs = 0;
let wordTokens = 0;
for (let surahNumber = 1; surahNumber <= 114; surahNumber++) {
  const file = join(dataDir, `surah-${String(surahNumber).padStart(3, "0")}.json`);
  const surah = JSON.parse(readFileSync(file, "utf8"));
  for (const ayah of surah.ayahs) {
    legacyHash.update(`${ayah.surahNumber}:${ayah.ayahNumber}:${ayah.text}\n`);
    updateLengthDelimitedRecord(ayahHash, [
      String(ayah.surahNumber),
      String(ayah.ayahNumber),
      ayah.text,
    ]);
    ayahs += 1;

    ayah.words.forEach((word, wordOffset) => {
      updateLengthDelimitedRecord(wordTokenHash, [
        String(ayah.surahNumber),
        String(ayah.ayahNumber),
        String(wordOffset + 1),
        word,
      ]);
      wordTokens += 1;
    });
  }
}

console.log(`ayahs hashed: ${ayahs}`);
console.log(`word tokens hashed: ${wordTokens}`);
console.log(`FULL_QURAN_CONTENT_SHA256 = "${legacyHash.digest("hex")}"`);
console.log(`FULL_QURAN_AYAH_SHA256 = "${ayahHash.digest("hex")}"`);
console.log(`FULL_QURAN_WORD_TOKEN_SHA256 = "${wordTokenHash.digest("hex")}"`);
