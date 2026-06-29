#!/usr/bin/env bash
set -euo pipefail

# Seed the Postgres database with the full Quran text.
# Uses psql directly — no Node dependencies needed.

PSQL="${PSQL:-/opt/homebrew/opt/postgresql@16/bin/psql}"
DB_HOST="${DB_HOST:-localhost}"
DB_USER="${DB_USER:-hawzhin}"
DB_NAME="${DB_NAME:-quran_ai}"
DATA_DIR="$(dirname "$0")/../src/data/full-quran"
MANIFEST="$DATA_DIR/manifest.json"

echo "=== Seeding full Quran to Postgres ==="
echo "Database: $DB_HOST/$DB_NAME"
echo ""

# Create seed institution and users
$PSQL -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" <<'SQL'
INSERT INTO institutions (id, name, region) VALUES
  ('hikmah-pilot-erbil', 'Hikmah Quran Academy', 'Erbil, Kurdistan')
ON CONFLICT (id) DO NOTHING;

INSERT INTO model_versions (id, kind, version, status) VALUES
  ('model-v0.3', 'alignment', '0.3', 'eval-passed'),
  ('tajweed-v0.1', 'tajweed', '0.1', 'eval-passed'),
  ('agent-v0.1', 'agent', '0.1', 'draft'),
  ('planner-v0.1', 'planner', '0.1', 'draft')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, tenant_id, display_name, role, language) VALUES
  ('teacher-1', 'hikmah-pilot-erbil', 'Ustadh Barzan', 'teacher', 'ar'),
  ('admin-1', 'hikmah-pilot-erbil', 'Admin', 'admin', 'en'),
  ('learner-1', 'hikmah-pilot-erbil', 'Soran Othman', 'learner', 'ckb')
ON CONFLICT (id) DO NOTHING;
SQL

echo "Seed institution, model versions, and users created."
echo ""

# Generate SQL from the full Quran JSON and pipe to psql
node -e "
const fs = require('fs');
const path = require('path');
const manifest = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
const importVersion = manifest.importVersion;

let sql = '';
let totalAyahs = 0;
let totalWords = 0;

for (const entry of manifest.surahs) {
  const fileName = 'surah-' + String(entry.surahNumber).padStart(3, '0') + '.json';
  const surah = JSON.parse(fs.readFileSync(path.join('$DATA_DIR', fileName), 'utf8'));

  // Build INSERT values for ayahs
  const ayahValues = surah.ayahs.map(a => {
    const ayahId = a.surahNumber + ':' + a.ayahNumber;
    const escaped = a.text.replace(/'/g, \"''\");
    const quranRef = JSON.stringify({surahNumber: a.surahNumber, ayahStart: a.ayahNumber, ayahEnd: a.ayahNumber, display: 'Surah ' + surah.englishName + ' ' + a.surahNumber + ':' + a.ayahNumber}).replace(/'/g, \"''\");
    const checksum = 'fnv1a32:' + fnv1a32(a.text);
    return '(' + [\"'\" + ayahId + \"'\", a.surahNumber, a.ayahNumber, \"'\" + escaped + \"'\", \"'tanzil'\", \"'uthmani'\", \"'uthmani'\", \"'\" + importVersion + \"'\", \"'\" + checksum + \"'\"].join(', ') + ')';
  }).join(',\\n  ');

  sql += 'INSERT INTO canonical_ayahs (id, surah_number, ayah_number, text_uthmani, source_id, edition, script_type, import_version, source_checksum) VALUES\\n  ' + ayahValues + '\\nON CONFLICT (id) DO NOTHING;\\n\\n';

  // Build INSERT values for words
  const wordValues = [];
  for (const ayah of surah.ayahs) {
    for (let i = 0; i < ayah.words.length; i++) {
      const wordIndex = i + 1;
      const wordId = ayah.surahNumber + ':' + ayah.ayahNumber + ':' + wordIndex;
      const escaped = ayah.words[i].replace(/'/g, \"''\");
      const checksum = 'fnv1a32:' + fnv1a32(ayah.words[i]);
      wordValues.push('(' + [\"'\" + wordId + \"'\", \"'\" + ayah.surahNumber + ':' + ayah.ayahNumber + \"'\", wordIndex, \"'\" + escaped + \"'\", \"'\" + checksum + \"'\"].join(', ') + ')');
      totalWords++;
    }
    totalAyahs++;
  }

  sql += 'INSERT INTO canonical_words (id, ayah_id, word_index, text_uthmani, source_checksum) VALUES\\n  ' + wordValues.join(',\\n  ') + '\\nON CONFLICT (id) DO NOTHING;\\n\\n';

  if (entry.surahNumber % 10 === 0 || entry.surahNumber === 114) {
    process.stderr.write('  Processed surah ' + entry.surahNumber + '/114: ' + entry.englishName + '\\n');
  }
}

process.stdout.write(sql);
process.stderr.write('\\nTotal ayahs: ' + totalAyahs + ', total words: ' + totalWords + '\\n');

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
" | $PSQL -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -q 2>&1 | grep -v "^INSERT" || true

echo ""
echo "=== Verifying counts ==="
$PSQL -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT count(*) as ayah_count FROM canonical_ayahs;" -c "SELECT count(*) as word_count FROM canonical_words;" -c "SELECT count(*) as surah_count FROM (SELECT DISTINCT surah_number FROM canonical_ayahs) s;"
