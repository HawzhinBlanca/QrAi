#!/usr/bin/env node
/**
 * Seeds the Postgres database with the full Quran text from the fetched JSON files.
 * Run: node scripts/seed-full-quran-to-db.mjs
 *
 * Requires DATABASE_URL or defaults to postgresql://hawzhin@localhost:5432/quran_ai
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data", "full-quran");

const DB_URL = process.env.DATABASE_URL || "postgresql://hawzhin@localhost:5432/quran_ai";

async function main() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  const manifest = JSON.parse(readFileSync(join(DATA_DIR, "manifest.json"), "utf8"));

  // Create a model version entry for the alignment model
  await client.query(`
    INSERT INTO model_versions (id, kind, version, status)
    VALUES ('model-v0.3', 'alignment', '0.3', 'eval-passed')
    ON CONFLICT (id) DO NOTHING
  `);

  // Create a seed institution
  await client.query(`
    INSERT INTO institutions (id, name, region)
    VALUES ('hikmah-pilot-erbil', 'Hikmah Quran Academy', 'Erbil, Kurdistan')
    ON CONFLICT (id) DO NOTHING
  `);

  // Create a seed teacher user
  await client.query(`
    INSERT INTO users (id, tenant_id, display_name, role, language)
    VALUES ('teacher-1', 'hikmah-pilot-erbil', 'Ustadh Barzan', 'teacher', 'ar')
    ON CONFLICT (id) DO NOTHING
  `);

  // Create a seed admin user
  await client.query(`
    INSERT INTO users (id, tenant_id, display_name, role, language)
    VALUES ('admin-1', 'hikmah-pilot-erbil', 'Admin', 'admin', 'en')
    ON CONFLICT (id) DO NOTHING
  `);

  // Create a seed learner user
  await client.query(`
    INSERT INTO users (id, tenant_id, display_name, role, language)
    VALUES ('learner-1', 'hikmah-pilot-erbil', 'Soran Othman', 'learner', 'ckb')
    ON CONFLICT (id) DO NOTHING
  `);

  // Insert canonical ayahs and words for all 114 surahs
  let totalAyahs = 0;
  let totalWords = 0;

  for (const entry of manifest.surahs) {
    const fileName = `surah-${String(entry.surahNumber).padStart(3, "0")}.json`;
    const surah = JSON.parse(readFileSync(join(DATA_DIR, fileName), "utf8"));

    // Insert ayahs
    for (const ayah of surah.ayahs) {
      const ayahId = `${ayah.surahNumber}:${ayah.ayahNumber}`;
      const sourceChecksum = `fnv1a32:${fnv1a32Hash(ayah.text)}`;
      const quranRef = JSON.stringify({
        surahNumber: ayah.surahNumber,
        ayahStart: ayah.ayahNumber,
        ayahEnd: ayah.ayahNumber,
        display: `Surah ${surah.englishName} ${ayah.surahNumber}:${ayah.ayahNumber}`,
      });

      await client.query(`
        INSERT INTO canonical_ayahs (id, surah_number, ayah_number, text_uthmani, source_id, edition, script_type, import_version, source_checksum)
        VALUES ($1, $2, $3, $4, 'tanzil', 'uthmani', 'uthmani', $5, $6)
        ON CONFLICT (id) DO NOTHING
      `, [ayahId, ayah.surahNumber, ayah.ayahNumber, ayah.text, manifest.importVersion, sourceChecksum]);

      totalAyahs++;

      // Insert words
      for (let i = 0; i < ayah.words.length; i++) {
        const wordIndex = i + 1;
        const wordId = `${ayah.surahNumber}:${ayah.ayahNumber}:${wordIndex}`;
        const wordText = ayah.words[i];
        const wordChecksum = `fnv1a32:${fnv1a32Hash(wordText)}`;

        await client.query(`
          INSERT INTO canonical_words (id, ayah_id, word_index, text_uthmani, source_checksum)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (id) DO NOTHING
        `, [wordId, ayahId, wordIndex, wordText, wordChecksum]);

        totalWords++;
      }
    }

    if (entry.surahNumber % 10 === 0 || entry.surahNumber === 114) {
      console.log(`  Processed surah ${entry.surahNumber}/${manifest.surahs.length}: ${entry.englishName}`);
    }
  }

  // Verify counts
  const ayahCount = await client.query("SELECT count(*) FROM canonical_ayahs");
  const wordCount = await client.query("SELECT count(*) FROM canonical_words");

  console.log("\n=== Database Seeding Complete ===");
  console.log(`Inserted ayahs: ${totalAyahs} (DB has: ${ayahCount.rows[0].count})`);
  console.log(`Inserted words: ${totalWords} (DB has: ${wordCount.rows[0].count})`);

  await client.end();
}

// FNV-1a32 hash (same as contracts)
function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

main().catch((error) => {
  console.error("Seeding failed:", error);
  process.exit(1);
});
