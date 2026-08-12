import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `services/node-api` is frozen. It may be fixed; it may not grow. (ADR-0044)
 *
 * Two Node backends exist: this one, and `server/` on PR #388 — which is the same codebase at a
 * later age (same route modules file by file, same `NODE_API_PORTED` control, same A/B parity
 * harness, same Rust oracle) plus the consolidation this one lacks: durable jobs, the audio object
 * store, the realtime boundary, local inference, a canary route.
 *
 * ADR-0044 makes `server/` the one being built. This guard is the half of that decision a document
 * cannot enforce: without it, "frozen" is a sentence in a file nobody runs, and the natural thing —
 * adding a route where the existing routes are — silently forks the two trees further apart. Every
 * capability added here would have to be implemented twice and could only be proven once.
 *
 * ── This is a pin, deliberately ─────────────────────────────────────────────────────────────────
 * Normally an oracle pinned to numbers produced by the thing it guards is an antipattern: it
 * measures nothing and fails only when someone edits the pin. Here the pin IS the decision. The
 * whole content of a freeze is "this set does not grow", so a count is the honest encoding of it,
 * and the failure message names `server/` so the next person is told where the code goes instead of
 * just being blocked.
 *
 * ── What is allowed ─────────────────────────────────────────────────────────────────────────────
 * Fixes, tests and security corrections to existing modules — a freeze that forbade repair would
 * push people to work around it. And SHRINKING: removing a module is retirement, which is the
 * direction of travel, so the assertions below are one-sided.
 *
 * Hermetic: reads a directory listing and one source file.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NODE_API = join(root, "services/node-api");

/** The inventory at the moment of the freeze, 2026-08-12. */
const FROZEN = { routes: 14, libs: 9, portableKeys: 37 };

const WHERE_INSTEAD =
  "ADR-0044 froze services/node-api: `server/` (PR #388) is the Node backend being built, and it " +
  "already contains this one's routes plus jobs, storage, realtime and inference. Add the " +
  "capability there. Fixes to existing modules are fine; growth is not.";

function portableKeys() {
  const src = readFileSync(join(NODE_API, "server.mjs"), "utf8");
  const m = /export const PORTABLE = \[([^\]]*)\]/s.exec(src);
  assert.ok(m, "PORTABLE is gone from services/node-api/server.mjs — has the shell been restructured?");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test("the frozen tree is still there to be measured", () => {
  // Non-vacuity. If the directory moves or empties, every assertion below would pass over nothing
  // and report a healthy freeze of a tree that no longer exists.
  const routes = readdirSync(join(NODE_API, "routes"));
  const libs = readdirSync(join(NODE_API, "lib"));
  assert.ok(routes.length > 0, "services/node-api/routes is empty");
  assert.ok(libs.length > 0, "services/node-api/lib is empty");
  assert.ok(
    portableKeys().length > 0,
    "PORTABLE parsed to zero keys — the parser is broken, or the shell serves nothing at all",
  );
});

test("no new route module has been added to the frozen backend", () => {
  const routes = readdirSync(join(NODE_API, "routes")).sort();
  assert.ok(
    routes.length <= FROZEN.routes,
    `services/node-api/routes has ${routes.length} modules; it was frozen at ${FROZEN.routes}.\n` +
      `  ${routes.join("\n  ")}\n${WHERE_INSTEAD}`,
  );
});

test("no new lib module has been added to the frozen backend", () => {
  const libs = readdirSync(join(NODE_API, "lib")).sort();
  assert.ok(
    libs.length <= FROZEN.libs,
    `services/node-api/lib has ${libs.length} modules; it was frozen at ${FROZEN.libs}.\n` +
      `  ${libs.join("\n  ")}\n${WHERE_INSTEAD}`,
  );
});

test("no new route key has been added to PORTABLE", () => {
  // The one that matters most. PORTABLE is the allowlist of what this shell MAY serve, so growing it
  // is how a frozen backend quietly acquires new production surface — the freeze's whole point.
  const keys = portableKeys();
  assert.ok(
    keys.length <= FROZEN.portableKeys,
    `PORTABLE names ${keys.length} route keys; it was frozen at ${FROZEN.portableKeys}. ` +
      `A route added here becomes servable in production from a backend that is being retired.\n` +
      `${WHERE_INSTEAD}`,
  );
});

test("the freeze is recorded where a human will read it, not only here", () => {
  // A guard whose reason lives only in the guard is a rule nobody can argue with. If ADR-0044 is
  // ever superseded, this fails and forces the decision to be re-recorded rather than silently
  // outlived by its enforcement.
  const adrs = readFileSync(join(root, "docs/DECISIONS.md"), "utf8");
  assert.match(adrs, /## ADR-0044 —/, "ADR-0044 is gone, so this freeze has no recorded reason");
  assert.match(
    adrs.slice(adrs.indexOf("## ADR-0044 —")),
    /\*\*Status:\*\* Accepted/,
    "ADR-0044 is no longer Accepted — if the decision changed, this guard should change with it",
  );
});
