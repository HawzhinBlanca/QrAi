import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * AGENTS.md: "Arabic regex character classes must use `\u` escapes, never literal combining marks."
 *
 * A combining mark inside a pattern renders on top of the neighbouring character — often on the
 * `[` itself — so a human reviewer cannot see what the class contains. In PR #258 a literal class
 * in `forced_align.py` merged two ranges, deleted every Arabic letter, and passed review. It has
 * since been broken twice more, independently: `services/asr-inference/server.py` (ghunnah) and
 * `services/ml-inference/tajweed.js` (five patterns, including a literal RANGE — the #258 shape).
 *
 * Three instances in two languages is not a series of accidents, it is a missing gate. This is the
 * gate, and it is repo-wide rather than per-file so the fourth instance fails in CI instead of in
 * a learner's feedback.
 *
 * ── Scope, honestly ──────────────────────────────────────────────────────────────────────────
 * It inspects the BODY of detected regex constructs only, never comments or ordinary strings —
 * Arabic examples in prose are fine and this file would be useless if they tripped it. Detection
 * covers the four forms that exist in this repo today (Python `re.*`, JS/TS literals and
 * `new RegExp`, Dart `RegExp`). A regex assembled at runtime from string concatenation is out of
 * reach of any static check, here or elsewhere.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/**
 * Arabic combining marks: harakat and tanween (U+064B–U+065F), superscript alef (U+0670), and the
 * Qur'anic annotation marks (U+06D6–U+06ED). Base LETTERS are deliberately not included — they are
 * visible in an editor, and banning them would be noise rather than safety.
 */
const COMBINING = /[ً-ٰٟۖ-ۭ]/;

/** Regex-construct matchers per language. Group 1 is always the pattern body. */
const PATTERNS = {
  ".py": [/\bre\.\w+\(\s*[rbf]{0,2}("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g],
  ".js": [/\/((?:[^/\n\\]|\\.)+)\/[a-z]*/g, /new RegExp\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g],
  ".dart": [/RegExp\(\s*r?("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g],
};
PATTERNS[".mjs"] = PATTERNS[".js"];
PATTERNS[".ts"] = PATTERNS[".js"];
PATTERNS[".tsx"] = PATTERNS[".js"];

/** Tracked source files only — never node_modules, never build output. */
function existingSources(files, base = root) {
  return files.filter((file) => existsSync(join(base, file)));
}

function trackedSources() {
  const files = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 << 20,
  }).split("\n");

  return existingSources(files)
    .filter((f) => Object.keys(PATTERNS).some((ext) => f.endsWith(ext)))
    // This file names the codepoints it bans, and the two suites that prove the fixes quote the
    // patterns they assert on. Excluding the checker from its own check is standard; excluding
    // anything else is not, so the list is exactly two files and they are both tests.
    .filter(
      (f) =>
        ![
          "tests/security/arabic-regex-escapes.test.mjs",
          "services/asr-inference/test_ghunnah_escapes.py",
        ].includes(f),
    );
}

/**
 * Is the `/` at `index` opening a regex literal, or is it prose?
 *
 * The standard JS disambiguation: a regex literal may only appear where an expression may start.
 * Without this, `// - tafkhim: ٱلصِّرَٰطَ has ص` matched as a "regex" from the second slash onward and
 * two comments were reported as violations — the first run of this gate found exactly that.
 * Comment-stripping would also work but can swallow a real regex that follows a `//` inside a
 * string, and a false negative in a security gate is the worse direction.
 */
function opensExpression(source, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 0) return true; // start of file / line
  return "=(,:[!&|?{;+*%^~<>".includes(source[i]) && source[i] !== "*";
}

export function offendersIn(source, ext) {
  const found = [];
  for (const matcher of PATTERNS[ext] ?? []) {
    for (const m of source.matchAll(new RegExp(matcher.source, matcher.flags))) {
      if (m[0].startsWith("/") && !opensExpression(source, m.index)) continue;
      const body = m[1] ?? "";
      if (COMBINING.test(body)) {
        const codepoints = [...body]
          .filter((c) => COMBINING.test(c))
          .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
        found.push({ construct: m[0].slice(0, 60), codepoints: [...new Set(codepoints)] });
      }
    }
  }
  return found;
}

test("no regex in the repo contains a literal Arabic combining mark", () => {
  const violations = [];
  for (const file of trackedSources()) {
    const ext = "." + file.split(".").pop();
    for (const o of offendersIn(readFileSync(join(root, file), "utf8"), ext)) {
      violations.push(`${file}: ${o.construct}  [${o.codepoints.join(" ")}]`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "these regexes carry literal Arabic combining marks — use \\uXXXX escapes " +
      `(AGENTS.md hard boundary):\n  ${violations.join("\n  ")}`,
  );
});


test("source inventory ignores index entries deleted from the working tree", () => {
  assert.deepEqual(
    existingSources([
      "tests/security/arabic-regex-escapes.test.mjs",
      "services/definitely-retired-component.py",
    ]),
    ["tests/security/arabic-regex-escapes.test.mjs"],
  );
});

test("the scanner detects each language's regex form", () => {
  // The failure that makes a repo-wide gate worthless: matching nothing and reporting clean. Each
  // case is a real construct from this repo's history, with the mark restored.
  const SUKUN = "ْ";
  const TANWEEN = "ًٌٍ";
  const WAQF = "ۖ-ۭ";

  assert.equal(offendersIn(`re.search("[نم][${SUKUN}]", w)`, ".py").length, 1);
  assert.equal(offendersIn(`if (/ن${SUKUN}/.test(word)) {`, ".js").length, 1);
  assert.equal(offendersIn(`text.replace(/[${WAQF}]+$/u, "")`, ".js").length, 1);
  assert.equal(offendersIn(`new RegExp("[${TANWEEN}]")`, ".ts").length, 1);
  assert.equal(offendersIn(`RegExp(r'[${TANWEEN}]')`, ".dart").length, 1);
});

test("the scanner does NOT flag escapes, comments, or plain Arabic strings", () => {
  // All three appear throughout the repo. Any of them tripping the gate would get it deleted.
  assert.deepEqual(offendersIn('re.search("[\\u064B\\u064C\\u064D]", w)', ".py"), []);
  assert.deepEqual(offendersIn("// tanween fath (ً) sits on the letter before the alef", ".js"), []);
  assert.deepEqual(offendersIn('const name = "غنة";', ".js"), []);
  // A base letter with no combining mark is visible in an editor and is not the hazard.
  assert.deepEqual(offendersIn("if (/ن$/.test(word)) {", ".js"), []);
});
