/**
 * N9 — the canonical Quran corpus. Port of services/platform-api/src/handlers/quran.rs.
 *
 * ── No actor, and no tenant transaction. Both are deliberate ────────────────────────────────────
 * The Rust handlers take `_headers: HeaderMap` and ignore it: canonical scripture is public. And
 * they query `&state.pool` DIRECTLY rather than through `begin_tenant_tx`, because
 * `canonical_ayahs` / `canonical_surahs` / `canonical_words` are global reference tables with no
 * `tenant_id` column. Wrapping them in `withTenant` would not be "safer" — it would set a GUC no
 * policy on these tables reads, and would imply a tenant scoping that does not exist.
 *
 * ── Canonical text is never touched ─────────────────────────────────────────────────────────────
 * The text goes from the driver to the response with no `.trim()`, no `.normalize()`, no
 * `replace`. Ayah 1:1 in this corpus begins with U+FEFF and the corpus is NFC-unstable, so both of
 * those would be real, silent mutations of scripture. `tests/api-parity/quran-parity.test.mjs`
 * compares the served bytes against the row in Postgres for exactly this reason.
 */
import { NotFound, RejectionError } from "../lib/authz.mjs";

/**
 * Port of axum's `Path<i32>` extraction, INCLUDING its rejection.
 *
 * Axum parses the segment before the handler runs, so a bad value is a 400 in `text/plain` — not
 * the JSON `{"error": ...}` every other failure uses, and emphatically not a 404. A client that
 * distinguishes "no such surah" from "that is not a number" branches on exactly this.
 *
 * Matches `i32::from_str`: an optional sign, then digits, then in-range. `"1.5"`, `" "` and
 * `"99999999999999999999"` are all rejected — the last one has only digits and still overflows.
 */
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

function parseI32(raw) {
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < I32_MIN || n > I32_MAX) return null;
  return n;
}

/**
 * Axum's two rejection messages. They differ by EXTRACTOR, not by position: `Path<i32>` names the
 * value; `Path<(i32, i32)>` names the index as well. Transcribed from real 400 responses.
 */
function invalidPath(raw, index = null) {
  const message =
    index === null
      ? `Invalid URL: Cannot parse \`${raw}\` to a \`i32\``
      : `Invalid URL: Cannot parse value at index ${index} with value \`${raw}\` to a \`i32\``;
  return new RejectionError(message, 400);
}

/** GET /v1/quran/surahs — quran.rs:21 */
export async function listSurahs(_req, reply, ctx) {
  const rows = await ctx.db.sql`
    SELECT a.surah_number,
           COUNT(*) AS ayah_count,
           s.english_name,
           s.name_arabic,
           s.english_translation,
           s.revelation_type
    FROM canonical_ayahs a
    LEFT JOIN canonical_surahs s ON s.surah_number = a.surah_number
    GROUP BY a.surah_number, s.english_name, s.name_arabic, s.english_translation, s.revelation_type
    ORDER BY a.surah_number`;

  // `SurahInfo` is a `#[derive(Serialize)]` STRUCT, so serde emits its fields in DECLARATION order
  // — not alphabetically like the `json!` responses below. Two different orders from the same file.
  // The key order here is that declaration order and is wire contract.
  const surahs = rows.map((r) => {
    const number = r.surah_number ?? 0;
    return {
      surahNumber: number,
      // COUNT(*) is int8; the driver hands it back as a string. Rust reads it as i64 and casts.
      ayahCount: Number(r.ayah_count ?? 0),
      // `.filter(|n| !n.is_empty())` — an EMPTY english_name falls back to the placeholder too, not
      // just a NULL one. The three fields below have no such filter: empty stays empty.
      name: r.english_name ? r.english_name : `Surah ${number}`,
      arabicName: r.name_arabic ?? "",
      translation: r.english_translation ?? "",
      revelationType: r.revelation_type ?? "",
    };
  });

  return reply.send(surahs);
}

/** GET /v1/quran/surahs/{surah_number} — quran.rs:80 */
export async function getSurah(req, reply, ctx) {
  const surahNumber = parseI32(req.params.surah_number);
  if (surahNumber === null) throw invalidPath(req.params.surah_number);

  const rows = await ctx.db.sql`
    SELECT id, surah_number, ayah_number, text_uthmani, source_checksum
    FROM canonical_ayahs WHERE surah_number = ${surahNumber} ORDER BY ayah_number`;

  if (rows.length === 0) throw NotFound();

  // `json!` keys, alphabetical: serde_json without `preserve_order` is BTreeMap-backed.
  return reply.send({
    ayahs: rows.map((r) => ({
      ayahNumber: r.ayah_number ?? 0,
      id: r.id ?? "",
      sourceChecksum: r.source_checksum ?? "",
      surahNumber: r.surah_number ?? 0,
      text: r.text_uthmani ?? "",
    })),
    surahNumber,
  });
}

/** GET /v1/quran/ayahs/{surah_number}/{ayah_number} — quran.rs:116 */
export async function getAyah(req, reply, ctx) {
  // `Path<(i32, i32)>`: the tuple extractor reports the INDEX of the segment that failed, and it
  // fails on the first bad one, left to right.
  const surahNumber = parseI32(req.params.surah_number);
  if (surahNumber === null) throw invalidPath(req.params.surah_number, 0);
  const ayahNumber = parseI32(req.params.ayah_number);
  if (ayahNumber === null) throw invalidPath(req.params.ayah_number, 1);

  const [row] = await ctx.db.sql`
    SELECT id, surah_number, ayah_number, text_uthmani, source_checksum
    FROM canonical_ayahs
    WHERE surah_number = ${surahNumber} AND ayah_number = ${ayahNumber}`;
  if (!row) throw NotFound();

  const words = await ctx.db.sql`
    SELECT id, word_index, text_uthmani, source_checksum
    FROM canonical_words WHERE ayah_id = ${row.id} ORDER BY word_index`;

  return reply.send({
    ayahNumber: row.ayah_number ?? 0,
    id: row.id,
    sourceChecksum: row.source_checksum ?? "",
    surahNumber: row.surah_number ?? 0,
    text: row.text_uthmani ?? "",
    words: words.map((w) => ({
      id: w.id ?? "",
      sourceChecksum: w.source_checksum ?? "",
      text: w.text_uthmani ?? "",
      wordIndex: w.word_index ?? 0,
    })),
  });
}
