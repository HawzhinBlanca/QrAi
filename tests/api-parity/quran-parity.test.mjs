/**
 * N9 — the three canonical-Quran routes: the Node shell against Rust.
 * specs/migration-completion/plan.md §2
 *
 *   node --test tests/api-parity/quran-parity.test.mjs
 *   NODE_API_PORTED="GET /v1/quran/surahs,GET /v1/quran/surahs/{surah_number},GET /v1/quran/ayahs/{surah_number}/{ayah_number}" \
 *     node --test tests/api-parity/quran-parity.test.mjs
 *
 * ── Why these routes get a byte comparison and no leniency at all ───────────────────────────────
 * They serve canonical Quran text. `assertAB` compares BYTES, which is the only comparison that can
 * detect a normalization: `String.prototype.normalize()`, a `trim()`, or a JSON round-trip through
 * something that "cleans" the text would all produce a string that LOOKS right and hashes
 * differently. Ayah 1:1 in this corpus begins with U+FEFF, so a well-meaning trim is not a
 * hypothetical — it is the first byte of the first ayah.
 *
 * A byte comparison between the two implementations proves they AGREE; it cannot prove they are
 * both right. So one test reads `text_uthmani` straight out of Postgres — an oracle that went
 * through neither implementation.
 *
 * ── The three routes serialize DIFFERENTLY, and the difference is invisible in the Rust ─────────
 * `list_surahs` returns `Json<Vec<SurahInfo>>` — a `#[derive(Serialize)]` struct, so its fields are
 * emitted in DECLARATION order. `get_surah` and `get_ayah` return `Json<serde_json::Value>` built
 * with `json!`, and serde_json without `preserve_order` is backed by a BTreeMap, so those keys are
 * emitted ALPHABETICALLY. Same file, same `Json` wrapper, two different orders. Measured from real
 * responses, not deduced.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, before } from "node:test";

import { assertAB } from "./lib/ab.mjs";
import { queryJson, request, startApi, startShell } from "./lib/harness.mjs";

let api;
let shell;
/**
 * The RUST url, which is not `rustUrl`.
 *
 * Under `PARITY_THROUGH_SHELL=1` — the configuration in which this file's A/B is the only thing that
 * proves anything about the port — `startApi` puts a Node shell in front of the binary and returns
 * the SHELL as `baseUrl`, exposing Rust as `upstreamUrl`. Wiring `startShell({ upstream:
 * rustUrl })` and differing against `rustUrl` therefore put Node on BOTH sides of every
 * `assertAB`: a shell in front of a shell, compared with that inner shell. Identical code cannot
 * disagree with itself, so the probes passed by construction.
 *
 * Measured before this was fixed: a `NODE_ONLY_FIELD` added to Node's `listSurahs` response — a
 * divergence a byte comparison cannot miss — left `assertAB` GREEN in both verify.sh passes. What
 * caught it was a literal key-list assertion beside the probe, which is not a comparison at all.
 */
let rustUrl;

before(async () => {
  api = await startApi({});
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl });
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

const pub = { tenant: null };

test("GET /v1/quran/surahs — 114 surahs, declaration-order keys, identical bytes", async () => {
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, { path: "/v1/quran/surahs", ...pub });
  assert.equal(s.status, 200);
  assert.equal(s.body.length, 114, "the seeded corpus is the whole Quran");
  assert.deepEqual(
    Object.keys(s.body[0]),
    ["surahNumber", "ayahCount", "name", "arabicName", "translation", "revelationType"],
    "derive(Serialize) emits DECLARATION order — alphabetical here would be a real wire change",
  );
});

test("GET /v1/quran/surahs/{n} — identical bytes, alphabetical keys", async () => {
  for (const n of [1, 2, 114]) {
    const { shell: s } = await assertAB(shell.baseUrl, rustUrl, { path: `/v1/quran/surahs/${n}`, ...pub });
    assert.equal(s.status, 200);
    assert.deepEqual(Object.keys(s.body), ["ayahs", "surahNumber"], "json! is BTreeMap-backed");
    assert.deepEqual(Object.keys(s.body.ayahs[0]), [
      "ayahNumber",
      "id",
      "sourceChecksum",
      "surahNumber",
      "text",
    ]);
  }
});

test("GET /v1/quran/ayahs/{s}/{a} — identical bytes, words included", async () => {
  for (const [s_, a] of [[1, 1], [2, 255], [114, 6]]) {
    const { shell: s } = await assertAB(shell.baseUrl, rustUrl, { path: `/v1/quran/ayahs/${s_}/${a}`, ...pub });
    assert.equal(s.status, 200);
    assert.deepEqual(Object.keys(s.body), [
      "ayahNumber",
      "id",
      "sourceChecksum",
      "surahNumber",
      "text",
      "words",
    ]);
    assert.ok(s.body.words.length > 0);
    assert.deepEqual(Object.keys(s.body.words[0]), ["id", "sourceChecksum", "text", "wordIndex"]);
  }
});

/**
 * The canonical-text guard, independent of BOTH implementations.
 *
 * The byte comparison above proves the shell and Rust agree; it cannot prove they are both right.
 * This reads `text_uthmani` straight out of Postgres and compares digests, so a transformation
 * applied by the shell, by Rust, or by anything between them is caught by something that never went
 * through either.
 *
 * NOTE: `sourceChecksum` is deliberately NOT recomputed here. It digests a COMPOSED payload
 * (id + quranRef.display + text + …, see packages/contracts `canonicalAyahPayload`), not the text
 * alone — an assumption this test made in its first draft, which failed while still PROXIED and so
 * was corrected before anything was ported. That is what writing the oracle first is for.
 */
test("served canonical text is byte-identical to the row in Postgres", async () => {
  const res = await request(shell.baseUrl, "/v1/quran/ayahs/1/1", pub);
  const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

  const [row] = await queryJson(
    "SELECT text_uthmani FROM canonical_ayahs WHERE surah_number = 1 AND ayah_number = 1",
  );
  assert.equal(sha(res.body.text), sha(row.text_uthmani), "the served ayah text differs from the stored bytes");

  const words = await queryJson(
    `SELECT w.word_index, w.text_uthmani FROM canonical_words w
     WHERE w.ayah_id = $1 ORDER BY w.word_index`,
    ["1:1"],
  );
  assert.equal(res.body.words.length, words.length);
  for (const [i, w] of res.body.words.entries()) {
    assert.equal(sha(w.text), sha(words[i].text_uthmani), `word ${w.id} text was altered in transit`);
  }
});

test("the corpus is NFC-UNSTABLE, so a normalize() would be detectable — and is not happening", async () => {
  const res = await request(shell.baseUrl, "/v1/quran/ayahs/1/1", pub);
  // If the stored text already equalled its own NFC form, this guard would be vacuous: normalizing
  // would be a no-op and the test would pass whether or not anyone normalized. Assert the premise.
  const [row] = await queryJson(
    "SELECT text_uthmani FROM canonical_ayahs WHERE surah_number = 1 AND ayah_number = 1",
  );
  const stored = row.text_uthmani;
  assert.notEqual(
    stored,
    stored.normalize("NFC"),
    "premise broken: this ayah is NFC-stable, so this test can no longer detect a normalization",
  );
  assert.equal(res.body.text, stored, "served text was normalized somewhere in the chain");
});

test("ayah 1:1 still begins with U+FEFF — the byte a trim() would silently eat", async () => {
  const res = await request(shell.baseUrl, "/v1/quran/ayahs/1/1", pub);
  assert.equal(
    res.body.text.codePointAt(0),
    0xfeff,
    "this corpus stores 1:1 with a leading U+FEFF; losing it is a canonical-text mutation",
  );
});

test("a missing surah or ayah is 404 with the shared error body", async () => {
  for (const path of ["/v1/quran/surahs/999", "/v1/quran/surahs/0", "/v1/quran/surahs/-1", "/v1/quran/ayahs/1/999"]) {
    const { shell: s } = await assertAB(shell.baseUrl, rustUrl, { path, ...pub });
    assert.equal(s.status, 404);
    assert.deepEqual(s.body, { error: "record not found" });
  }
});

/**
 * Path-parameter rejection. Axum parses `{surah_number}` into an `i32` BEFORE the handler runs, so
 * a bad value is a 400 in `text/plain` — not the JSON error body every other failure uses, and not
 * a 404. Clients branch on status, and a shell that answered 404 here would look correct in a
 * browser and be wrong in a client that distinguishes "no such surah" from "that is not a number".
 *
 * The two messages differ by extractor: `Path<i32>` names the value, `Path<(i32, i32)>` names the
 * index too. Measured, not guessed.
 */
test("a non-integer path parameter is a 400 in text/plain, byte-identical", async () => {
  for (const path of [
    "/v1/quran/surahs/abc",
    "/v1/quran/surahs/1.5",
    "/v1/quran/surahs/%20",
    "/v1/quran/surahs/99999999999999999999", // valid digits, overflows i32
    "/v1/quran/ayahs/1/abc",
    "/v1/quran/ayahs/abc/1",
  ]) {
    const { shell: s } = await assertAB(shell.baseUrl, rustUrl, { path, ...pub });
    assert.equal(s.status, 400, `${path} must be 400, not 404`);
    assert.match(s.headers.get("content-type") ?? "", /^text\/plain/);
    assert.match(s.text, /^Invalid URL: Cannot parse/);
  }
});

/**
 * A RECORDED GAP, made explicit rather than left silent.
 *
 * `list_surahs` falls back to `Surah {n}` when `english_name` is NULL **or empty**
 * (`.filter(|n| !n.is_empty())`, quran.rs:56). Replacing the port's truthiness check with `??` —
 * which catches null but not `""` — changes nothing in the A/B, because no row in this corpus has
 * an empty name. The mutation runs green, so that branch has no teeth here.
 *
 * Rather than claim coverage this suite does not have, assert the PREMISE. If the corpus ever gains
 * an empty name the branch becomes live, and this test says so instead of the A/B quietly starting
 * to matter.
 */
test("the empty-name fallback branch is unreachable with this corpus — stated, not assumed", async () => {
  const rows = await queryJson(
    "SELECT COUNT(*)::int AS n FROM canonical_surahs WHERE english_name = ''",
  );
  assert.equal(
    rows[0].n,
    0,
    "a surah now has an EMPTY english_name: the `Surah {n}` fallback is live and the A/B above " +
      "does not cover it. Add a case that pins the fallback before relying on this suite.",
  );
});

test("these routes take no actor — a request with no identity headers still succeeds", async () => {
  const res = await request(shell.baseUrl, "/v1/quran/surahs", { tenant: null });
  assert.equal(res.status, 200, "canonical text is public; adding auth here would be a behaviour change");
});
