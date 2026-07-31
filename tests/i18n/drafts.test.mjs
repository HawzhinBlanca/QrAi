import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getPath, leafKeys } from "./lib/keys.mjs";

/**
 * K3 — the drafts are gated, and the religious boundary is enforced rather than promised.
 * specs/kurdish-i18n/plan.md §5
 *
 * Hermetic: JSON plus one grep.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const en = JSON.parse(readFileSync(join(root, "apps/web/src/locales/en.json"), "utf8"));
const registers = JSON.parse(readFileSync(join(root, "specs/kurdish-i18n/registers.json"), "utf8"));
const drafts = JSON.parse(readFileSync(join(root, "specs/kurdish-i18n/drafts/ckb.draft.json"), "utf8"));

// --- THE boundary ---

test("NO religious or brand string is drafted", () => {
  // The line the whole plan turns on. A wrong word in the religious register does not read
  // awkwardly — it teaches a learner something false about recitation.
  const violations = Object.keys(drafts.entries).filter((k) =>
    ["religious", "brand"].includes(registers.keys[k]?.register),
  );
  assert.deepEqual(
    violations,
    [],
    `these are religious/brand and must never be AI-drafted:\n  ${violations.join("\n  ")}`,
  );
});

test("the drafts file is NOT imported anywhere under apps/", () => {
  // Drafts reaching a learner without promotion would defeat the entire mechanism. Checked against
  // the source tree, not asserted about it.
  //
  // Matches an IMPORT, not a mention. The first version grepped for the bare filename and flagged
  // i18n/index.ts, whose comment explains where drafts live and why they are not loaded — precisely
  // the comment that file should carry. A guard that punishes accurate documentation gets the
  // documentation deleted.
  //
  // `.*` and NOT `[^\n]*`: in POSIX ERE a bracket expression is literal, so `[^\n]` means "not a
  // backslash and not the letter n" — and the path contains `kurdish-i18n`, so the pattern could
  // not span it. That version silently matched nothing, and this test passed while guarding
  // nothing until a real import was injected to check.
  const hits = execSync(
    `grep -rlE "(import|require|from).*ckb\\.draft" ${join(root, "apps")} 2>/dev/null || true`,
    { encoding: "utf8" },
  ).trim();
  assert.equal(hits, "", `apps/ must not IMPORT the draft file:\n${hits}`);
});

// --- integrity of what IS drafted ---

test("every drafted key is a real English key", () => {
  const real = new Set(leafKeys(en));
  const bogus = Object.keys(drafts.entries).filter((k) => !real.has(k));
  assert.deepEqual(bogus, [], `drafted keys that do not exist:\n  ${bogus.join("\n  ")}`);
});

test("every entry is ai-suggested — nothing here may claim review", () => {
  for (const [key, entry] of Object.entries(drafts.entries)) {
    assert.equal(entry.status, "ai-suggested", `${key}: status must be ai-suggested`);
    assert.ok(typeof entry.value === "string" && entry.value.trim() !== "", `${key}: empty draft`);
  }
});

test("every draft records the English it was translated FROM", () => {
  // So a reviewer sees drift when the English changes under a draft — otherwise they would approve a
  // translation of a sentence that no longer exists.
  for (const [key, entry] of Object.entries(drafts.entries)) {
    assert.equal(
      entry.english,
      getPath(en, key),
      `${key}: the English has changed since this was drafted — re-draft before review`,
    );
  }
});

test("interpolation variables survive every draft", () => {
  // Same rule K2 applies to the shipped locale, applied one step earlier so a reviewer never sees a
  // broken draft in the first place.
  const vars = (s) => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort().join();
  for (const [key, entry] of Object.entries(drafts.entries)) {
    assert.equal(vars(entry.value), vars(entry.english), `${key}: interpolation differs from the English`);
  }
});

test("no draft is just the English string", () => {
  for (const [key, entry] of Object.entries(drafts.entries)) {
    assert.notEqual(entry.value.trim(), String(entry.english).trim(), `${key}: not translated`);
  }
});

test("the drafts are Perso-Arabic script, as Sorani requires", () => {
  // A Latin-script entry would mean something went wrong — a placeholder, or the wrong language.
  const arabic = /[؀-ۿݐ-ݿ]/;
  for (const [key, entry] of Object.entries(drafts.entries)) {
    assert.ok(arabic.test(entry.value), `${key}: no Perso-Arabic characters — is this Sorani?`);
  }
});

// --- honesty of the counters ---

test("the recorded totals match reality, so coverage cannot be overstated", () => {
  const draftable = Object.values(registers.keys).filter((v) =>
    ["ui", "product"].includes(v.register),
  ).length;
  assert.equal(drafts.totals.allStrings, leafKeys(en).length);
  assert.equal(drafts.totals.draftableRegisters, draftable);
  assert.equal(drafts.totals.drafted, Object.keys(drafts.entries).length);
  assert.ok(
    drafts.totals.drafted < drafts.totals.allStrings,
    "if everything were drafted, the religious boundary would have been crossed",
  );
});

test("the file tells a reviewer that rejecting is expected", () => {
  // A reviewer who feels they are rubber-stamping will rubber-stamp. The instruction to reject has
  // to be in the file they open, not only in a document beside it.
  assert.match(drafts.$comment, /REJECTING A DRAFT IS THE EXPECTED OUTCOME/);
  assert.match(drafts.$comment, /no way to verify its Sorani is idiomatic/);
});
