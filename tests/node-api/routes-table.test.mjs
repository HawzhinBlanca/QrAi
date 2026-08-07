/**
 * N7 — the route table, and the two things about it that can fail silently.
 * specs/migration-completion/plan.md §2
 *
 * 1. `PORTABLE` is a hand-maintained literal (it has to be — `cutover-readiness.mjs` reads this file
 *    as text). Hand-maintained lists drift. These tests make drift a failure instead of a surprise.
 * 2. `checkTrafficShare` parses that literal with a REGEX. A refactor that keeps the code working
 *    perfectly can still break the parse, and the check would then report "0 portable" — an
 *    understatement that reads as caution and exits 0. That is the failure mode CU2 was written
 *    for, reproduced one level down.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkTrafficShare } from "../../scripts/cutover-readiness.mjs";
import { PORTABLE } from "../../server/src/main.mjs";
import { ROUTES, fastifyPath } from "../../server/src/routes/index.mjs";

const SERVER_SRC = readFileSync("server/src/main.mjs", "utf8");

test("PORTABLE and ROUTES describe the same set of routes", () => {
  assert.deepEqual(
    [...PORTABLE].sort(),
    ROUTES.map((r) => r.key).sort(),
    "the allowlist and the handler table disagree — one of them was updated and the other was not",
  );
});

test("every ROUTES entry is internally consistent", () => {
  for (const route of ROUTES) {
    const [method, path] = route.key.split(" ");
    assert.equal(route.method, method.toLowerCase(), `${route.key}: method disagrees with key`);
    assert.equal(route.path, path, `${route.key}: path disagrees with key`);
    assert.equal(typeof route.handler, "function", `${route.key}: handler is not a function`);
  }
});

test("no duplicate route keys", () => {
  const keys = ROUTES.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, "a duplicate key means one handler is unreachable");
});

test("fastifyPath converts axum {param} to fastify :param", () => {
  assert.equal(fastifyPath("/v1/recitation-sessions/{id}"), "/v1/recitation-sessions/:id");
  assert.equal(
    fastifyPath("/v1/quran/ayahs/{surah_number}/{ayah_number}"),
    "/v1/quran/ayahs/:surah_number/:ayah_number",
  );
  // A LITERAL colon must be ESCAPED, not passed through. find-my-way reads `:name` as a parameter,
  // so `/v1/ml/alignments:predict` registered verbatim also matches `/v1/ml/alignmentsXYZ` — the
  // real handler serving a path the contract never mentions. `::` is the escape.
  assert.equal(fastifyPath("/v1/ml/alignments:predict"), "/v1/ml/alignments::predict");
  assert.equal(fastifyPath("/v1/ml/tajweed-findings:predict"), "/v1/ml/tajweed-findings::predict");
  // …and a path that has BOTH a parameter and a literal colon keeps them distinct.
  assert.equal(fastifyPath("/v1/x/{id}/y:go"), "/v1/x/:id/y::go");
});

test("cutover-readiness can still PARSE the PORTABLE literal out of server.mjs", () => {
  const result = checkTrafficShare(SERVER_SRC, 38);
  const parsed = result.detail.match(/\((\d+) portable\)/);
  assert.ok(parsed, `traffic-share detail did not report a portable count: ${result.detail}`);
  assert.equal(
    Number(parsed[1]),
    PORTABLE.length,
    "the regex in cutover-readiness.mjs no longer sees the real PORTABLE list — the check would " +
      "under-report and still exit 0",
  );
});

test("traffic-share stays UNMET while the default route set is empty", () => {
  assert.equal(checkTrafficShare(SERVER_SRC, 38).state, "UNMET");
  assert.match(checkTrafficShare(SERVER_SRC, 38).detail, /serves 0 of 38/);
});

test("the parse would FAIL on a computed PORTABLE — this is why it is a literal", () => {
  // The refactor that looks obviously correct and breaks the gate.
  const computed = SERVER_SRC.replace(
    /export const PORTABLE = \[[^\]]*\]/s,
    "export const PORTABLE = ROUTES.map((r) => r.key)",
  );
  assert.notEqual(computed, SERVER_SRC, "the replacement did not apply; this test proves nothing");
  const result = checkTrafficShare(computed, 38);
  assert.match(
    result.detail,
    /\(0 portable\)/,
    "a computed PORTABLE must be shown to under-report, or this test is not demonstrating the risk",
  );
});
