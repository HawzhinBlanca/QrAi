// Prints full-Quran canonical_ayahs/canonical_words INSERT SQL for all 114 surahs to stdout, using
// buildFullQuranSurahBundle + toCanonicalSqlSeed — the same checksum functions (createCanonicalChecksum/
// createCanonicalAyahChecksum) that @quran-ai/contracts's verifyCanonicalWord/verifyCanonicalAyah
// validate against. Not written to a committed file (unlike infra/sql/0002_seed_fatihah.sql): at ~12MB
// for 6236 ayahs/77000+ words it is a regenerable build artifact, not a migration; see
// scripts/seed-full-quran-to-db.sh, which pipes this output straight into psql.
import { buildFullQuranSurahBundle, toCanonicalSqlSeed } from "../src/index.ts";
import { FULL_QURAN_IMPORT_VERSION, listAllSurahs, getSurah } from "../src/full-quran.ts";

for (const entry of listAllSurahs()) {
  const surah = getSurah(entry.surahNumber);
  const bundle = buildFullQuranSurahBundle(surah, "tanzil", FULL_QURAN_IMPORT_VERSION);
  process.stdout.write(toCanonicalSqlSeed(bundle));
  process.stdout.write("\n\n");
  if (entry.surahNumber % 10 === 0 || entry.surahNumber === 114) {
    process.stderr.write(`  Processed surah ${entry.surahNumber}/114: ${entry.englishName}\n`);
  }
}
