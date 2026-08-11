import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOpenapi, routePairsFromRust } from "./lib/openapi.mjs";

/**
 * Every API path a TypeScript client REQUESTS must be one the contract describes.
 *
 * `coverage.test.mjs` asserts the other direction — every route the server registers is contracted —
 * and that direction has been guarded since F1. This one never was, and it is the one that broke:
 * `TeacherSurface` fetched `/v1/recitation-sessions/{id}/audio`, which platform-api has never
 * registered. It 404'd on every session, the catch rendered "No audio available for this session",
 * and teachers reviewed recitations they had never heard — indistinguishable, to them, from a
 * learner having asked for the recording to be destroyed. Nothing failed, because nothing looked.
 *
 * A client is entitled to ignore fields the server sends (flutter-contract.test.mjs says so about
 * KEYS, and is right). It is not entitled to invent a URL: there is no server that answers it.
 *
 * ── What this cannot see ──────────────────────────────────────────────────────────────────────
 * A path assembled from fragments (`` `${base}/${resource}/audio` ``) is invisible to a source
 * scan. That is a real limit, not a hidden one — the test below asserts the scanner still finds a
 * healthy number of paths, so a refactor that hid them all from it fails rather than passing empty.
 *
 * Hermetic: source text and the spec. No database, no service, no network.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const spec = loadOpenapi(join(repoRoot, "specs/flutter-client/openapi.yaml"));

/** The TS clients. Dart is covered by flutter-contract.test.mjs, which compares keys, not paths. */
const ROOTS = ["apps/web/src", "apps/mobile"];

/**
 * The browser talks to TWO services, and only one of them has a contract.
 *
 * `specs/flutter-client/openapi.yaml` describes platform-api. The realtime gateway is a separate
 * process on a separate port, reached over WebSocket, and its routes are registered in its own
 * lib.rs — so its paths are read from there rather than exempted. An exemption list would let a
 * client call a gateway path the gateway does not serve; this way that still fails.
 *
 * This distinction is the whole shape of the bug that prompted the file.
 * `/v1/recitation-sessions/{id}/audio` is a REAL route — the gateway's WebSocket upgrade, lib.rs:682.
 * TeacherSurface pointed a plain `fetch` at it using the PLATFORM-API base URL. Not an invented
 * path: the right path against the wrong service, over the wrong protocol. That is a far easier
 * mistake to make than a typo, and it is why this check compares against both route sets rather
 * than asking whether a string "looks like" an API path.
 */
const GATEWAY_PAIRS = routePairsFromRust(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "services/realtime-gateway/src/lib.rs"), "utf8"),
);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".expo") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * Drop comment-only lines before scanning.
 *
 * Not cosmetic. The prose in this repo quotes routes constantly — `platform.ts` explains the bug
 * above by NAMING the dead route — and a scanner that cannot tell a citation from a call reports
 * the explanation of a fix as the fix's absence. (It did, on the first run of this scan: four
 * "ghosts", all of them comments.) Only whole comment lines are dropped: truncating a code line at
 * a `//` could hide a real call, and a scanner that silently sees less is the failure this guards.
 */
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Every versioned API path literal in a source file, with `${…}` reduced to a path parameter. */
function requestedPaths(src) {
  const paths = new Map();
  for (const line of src.split("\n")) {
    if (isCommentLine(line)) continue;
    // The optional `\$\{…\}` prefix is the form the clients actually use —
    // `` `${API_BASE}/v1/tajweed-findings/${id}/audio` `` — and requiring the path to start
    // immediately after the quote missed every one of them. Caught by the prose fixture below,
    // whose third line is exactly that shape.
    for (const m of line.matchAll(/["'`](?:\$\{[^}]*\})?(\/(?:v1|health|ready|metrics)[^"'`\s]*)["'`]/g)) {
      const path = m[1].replace(/\$\{[^}]*\}/g, "{}").split("?")[0].replace(/\/+$/, "") || "/";
      if (!paths.has(path)) paths.set(path, line.trim().slice(0, 120));
    }
  }
  return paths;
}

/**
 * Does a concrete or parameterised path match any contracted template?
 *
 * Segment-wise, so a template parameter absorbs both `{}` (an interpolation) and a literal id a
 * test writes out (`/v1/quran/surahs/1`). Method is not compared: a source scan cannot see the verb
 * reliably, and "this path exists" is the claim that failed.
 */
function matchesContract(path) {
  const segs = path.split("/");
  const templates = [...Object.keys(spec.paths), ...GATEWAY_PAIRS.map((p) => p.path)];
  return templates.some((template) => {
    const t = template.split("/");
    if (t.length !== segs.length) return false;
    return t.every((s, i) => (s.startsWith("{") && s.endsWith("}")) || s === segs[i]);
  });
}

const scanned = new Map();
for (const root of ROOTS) {
  for (const file of walk(join(repoRoot, root))) {
    for (const [path, line] of requestedPaths(readFileSync(file, "utf8"))) {
      if (!scanned.has(path)) scanned.set(path, []);
      scanned.get(path).push({ file: file.slice(repoRoot.length + 1), line });
    }
  }
}

test("the gateway's routes are actually parsed, so the second service is really covered", () => {
  // `routePairsFromRust` returned ZERO for the gateway until 2026-08-11: it required
  // `axum::routing::get(` or `.get(`, and the gateway imports its verbs and writes `get(handler)`.
  // A caller got an empty list and no error. If that regresses, every gateway path silently becomes
  // a "ghost" and the check below starts failing for the wrong reason — or, worse, a real ghost
  // gets excused. Pinned by CONTENT, not just count, so a parser that finds three of something else
  // does not satisfy it.
  assert.ok(
    GATEWAY_PAIRS.some((p) => p.path === "/v1/recitation-sessions/{session_id}/audio"),
    `the gateway's audio upgrade was not parsed out of its lib.rs (found ${GATEWAY_PAIRS.length} routes)`,
  );
});

test("the scan actually finds the clients' API calls", () => {
  // Guards every assertion below against passing on an empty set. If a refactor moves path
  // construction somewhere this cannot see, that must fail HERE — loudly — rather than turn the
  // ghost-route check into a no-op that reports success.
  assert.ok(
    scanned.size >= 15,
    `only ${scanned.size} API paths found across ${ROOTS.join(", ")} — the scanner has stopped ` +
      `seeing the clients' calls, so the check below proves nothing`,
  );
});

test("every path the TypeScript clients request exists in the contract", () => {
  const ghosts = [...scanned.entries()]
    .filter(([path]) => !matchesContract(path))
    .map(([path, sites]) => `${path}\n      ${sites.map((s) => `${s.file}: ${s.line}`).join("\n      ")}`);

  assert.deepEqual(
    ghosts,
    [],
    `these paths are requested by a client and described by no contracted route, so no server ` +
      `answers them:\n  ${ghosts.join("\n  ")}\n` +
      `Either the route is missing from specs/flutter-client/openapi.yaml, or the client is ` +
      `calling a URL that does not exist — as TeacherSurface did with ` +
      `/v1/recitation-sessions/{id}/audio.`,
  );
});

test("a ghost route WOULD be caught", () => {
  // The negative control, kept in the file rather than run once by hand: the check above passes
  // today, and a check that has never rejected anything is indistinguishable from one that cannot.
  assert.equal(matchesContract("/v1/not-a-route"), false);
  assert.equal(matchesContract("/v1/recitation-sessions/{}/transcript"), false);
  // NOT a ghost, and this is the correction: it is the GATEWAY's WebSocket upgrade (its lib.rs:682).
  // TeacherSurface's bug was calling it against the platform-api base over HTTP, which no set-based
  // check can see — only the base URL tells them apart. The value here is the paths that match
  // NEITHER service.
  assert.equal(matchesContract("/v1/recitation-sessions/{}/audio"), true, "the gateway serves this");
  assert.equal(matchesContract("/v1/tajweed-findings/{}/audio"), true, "the route that replaced it");
  // A literal id must still resolve to its template, or every concrete path in a test reads as a ghost.
  assert.equal(matchesContract("/v1/quran/surahs/1"), true);
});

test("a citation in prose is not mistaken for a call", () => {
  // The scanner's first run reported four ghosts, every one of them a route NAMED IN A COMMENT —
  // including the comment that explains the dead route this test exists because of.
  const src = [
    " * NOT `/v1/recitation-sessions/{id}/audio` — that route has never existed.",
    "  // fetched `/v1/ghost/route` on every selection",
    "  const real = `${API_BASE}/v1/tajweed-findings/${id}/audio`;",
  ].join("\n");
  assert.deepEqual([...requestedPaths(src).keys()], ["/v1/tajweed-findings/{}/audio"]);
});
