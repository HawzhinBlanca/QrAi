import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A test that imports TypeScript must be RUN with type stripping.
 *
 * ── The bug this is the fix for ─────────────────────────────────────────────────────────────────
 * `tests/contract/tajweed-gate-parity.test.mjs` imports `packages/contracts/src/index.ts` directly,
 * on purpose: it executes the real learner gate instead of parsing it out of source. Node enables
 * type stripping BY DEFAULT from v22.18, so on a current runtime that import just works — and
 * `verify.sh` was written on a current runtime and did not pass the flag.
 *
 * `package.json` declares `"node": ">=22.13"`. On 22.13 the same line throws
 * ERR_UNKNOWN_FILE_EXTENSION and the whole `test: node services` gate is red. CI pins
 * `node-version: "22"`, which resolves to the NEWEST 22 — so the runtime that would have caught it
 * was the one runtime never tested. A gate that is red on a supported minimum and green on CI is
 * worse than a missing gate: it reports safety it does not have on the machine that runs it.
 *
 * ── Why a repo invariant and not a CI matrix entry ──────────────────────────────────────────────
 * A second CI runtime would catch this specific file on the next push. This catches the CLASS, on
 * every machine, in the same second — including on the developer's own newer Node, where the real
 * failure is invisible by construction. The two are complementary; this is the cheap half.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const VERIFY = readFileSync(join(repo, "scripts", "verify.sh"), "utf8");

const STRIP_FLAG = "--experimental-strip-types";

/** Every `node ... --test <files>` invocation in verify.sh, with the files it runs. */
function testInvocations(source) {
  return source
    .split("\n")
    .filter((line) => line.includes("--test ") && !line.trimStart().startsWith("#"))
    .map((line) => ({
      line,
      strips: line.includes(STRIP_FLAG),
      files: [...line.matchAll(/[\w./-]+\.test\.(?:mjs|ts)/g)].map((m) => m[0]),
    }))
    .filter((inv) => inv.files.length > 0);
}

/** Does this test file import a `.ts` module? */
function importsTypeScript(file) {
  const path = join(repo, file);
  if (!existsSync(path)) {
    return false;
  }
  return /(?:from|import)\s*\(?\s*["'][^"']+\.ts["']/.test(readFileSync(path, "utf8"));
}

const INVOCATIONS = testInvocations(VERIFY);

test("verify.sh's test invocations are still parseable", () => {
  // If this extraction silently matched nothing, every assertion below would pass vacuously.
  assert.ok(
    INVOCATIONS.length >= 2,
    `found ${INVOCATIONS.length} node --test invocations in verify.sh; the extraction has broken ` +
      "and the check below is no longer checking anything",
  );
  assert.ok(
    INVOCATIONS.some((inv) => inv.files.length > 10),
    "the bulk node-services invocation is gone or was reformatted across lines",
  );
});

test("every test that imports TypeScript is run with type stripping", () => {
  const unflagged = [];
  for (const inv of INVOCATIONS) {
    if (inv.strips) {
      continue;
    }
    for (const file of inv.files) {
      if (importsTypeScript(file)) {
        unflagged.push(file);
      }
    }
  }

  assert.deepEqual(
    unflagged,
    [],
    `${JSON.stringify(unflagged)} import a .ts module but verify.sh runs them without ` +
      `\`${STRIP_FLAG}\`. That passes on Node >=22.18, where stripping is the default, and throws ` +
      "ERR_UNKNOWN_FILE_EXTENSION on the minimum this repo supports. Add the flag to that " +
      "invocation, or import compiled JavaScript.",
  );
});

test("the flag is actually load-bearing somewhere", () => {
  // Guards the guard: if nothing imports TypeScript any more, the test above passes for a reason
  // that has nothing to do with the flag, and the flag can be deleted without turning anything red.
  const covered = INVOCATIONS.filter((inv) => inv.strips).flatMap((inv) =>
    inv.files.filter((f) => importsTypeScript(f) || f.endsWith(".ts")),
  );
  assert.ok(
    covered.length > 0,
    `no test behind ${STRIP_FLAG} imports TypeScript any more — either the flag is now dead and ` +
      "should be removed, or this check has stopped seeing the files it is meant to protect",
  );
});
