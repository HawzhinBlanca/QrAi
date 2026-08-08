/**
 * The web-bundle secret guard can actually find a secret. (P4.x)
 *
 *   node --test scripts/check-web-bundle-secrets.test.mjs
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * `scripts/check-web-bundle-secrets.mjs` runs on every gate as "guard: web production bundle
 * secrets" and reports how many files it scanned. It had no test of any kind. It has never, in the
 * life of this repository, been observed to fail — so "it passed" carried no information: a guard
 * whose detection has never been demonstrated is indistinguishable from one that greps for nothing.
 *
 * It could not even be exercised by hand. The scanned directory was hard-coded to
 * `apps/web/dist`, and AGENTS.md forbids writing under any `dist/` path — enforced by the PreToolUse
 * guard, which blocked an attempt to build a fixture bundle while writing this file. So the one
 * check standing between a dev bypass password and a production JavaScript bundle was, structurally,
 * unfalsifiable. The scanner now accepts an explicit directory argument for that reason.
 *
 * Fixtures deliberately live in directories NOT named `dist`, both to respect that boundary and
 * because the guard should not care what the folder is called.
 *
 * The planted values are obvious non-secrets (`TESTONLYNOTREAL`) that match the shapes the scanner
 * looks for. Nothing here is or resembles a real credential.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = join(repo, "scripts", "check-web-bundle-secrets.mjs");

/** Build a throwaway bundle directory containing the given files. */
function bundle(files) {
  const root = mkdtempSync(join(tmpdir(), "bundle-scan-"));
  const assets = join(root, "assets");
  mkdirSync(assets, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(assets, name), contents, "utf8");
  }
  return root;
}

function scan(directory) {
  try {
    return { code: 0, output: execFileSync("node", [SCANNER, directory], { encoding: "utf8" }) };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

// Every pattern the scanner claims to catch, with a value that is plainly not a credential.
const PLANTED = [
  ["dev auto-login password", `const p = "dev-bypass-TESTONLYNOTREAL";`],
  ["dev auto-login email/domain", `const u = "someone@bypass.local";`],
  ["default JWT secret", `const s = "quran-ai-dev-secret";`],
  ["default realtime ticket secret", `const t = "smoke-secret";`],
];

test("a clean bundle passes and says what it examined", () => {
  const result = scan(bundle({ "app.js": "const ok = 1;\n", "style.css": ".a{color:red}\n" }));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /scan passed \(2 files\)/);
});

test("every forbidden pattern is actually detected", () => {
  // One at a time: a scanner that only ever checked its first pattern would pass a single-case test.
  for (const [label, contents] of PLANTED) {
    const result = scan(bundle({ "app.js": "const ok = 1;\n", "leak.js": contents }));
    assert.equal(result.code, 1, `${label} was not detected: ${result.output}`);
    assert.match(result.output, /web bundle secret scan failed/);
    assert.match(result.output, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.output, /leak\.js/, "the failure must name the offending file");
  }
});

test("a secret is found wherever it hides in the tree, not only at the top", () => {
  const root = bundle({ "app.js": "const ok = 1;\n" });
  const deep = join(root, "assets", "chunks", "vendor");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "buried.js"), `const p = "dev-bypass-TESTONLYNOTREAL";`, "utf8");

  const result = scan(root);
  assert.equal(result.code, 1, "a nested chunk was not scanned");
  assert.match(result.output, /buried\.js/);
});

test("a scan that examined nothing is a failure, not a pass", () => {
  // The vacuous pass. An empty-but-present bundle directory used to print
  // "scan passed (0 files)" and exit 0, so a cleaned tree or a build that failed after creating the
  // folder made the gate report a secret scan it never performed.
  const empty = mkdtempSync(join(tmpdir(), "bundle-empty-"));
  const result = scan(empty);
  assert.equal(result.code, 1, `an empty bundle reported success: ${result.output}`);
  assert.match(result.output, /no scannable files/);
});

test("a missing bundle directory fails closed", () => {
  const result = scan(join(tmpdir(), "bundle-that-does-not-exist-TESTONLY"));
  assert.equal(result.code, 1, `a missing bundle reported success: ${result.output}`);
});

test("files the bundle does not serve as code are still scanned", () => {
  // Source maps and JSON ship alongside the bundle and leak just as effectively as .js.
  for (const name of ["app.js.map", "config.json", "notes.txt", "icon.svg"]) {
    const result = scan(bundle({ "app.js": "const ok = 1;\n", [name]: `"quran-ai-dev-secret"` }));
    assert.equal(result.code, 1, `${name} was not scanned: ${result.output}`);
  }
});
