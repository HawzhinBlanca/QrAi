import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { leafKeys } from "./lib/keys.mjs";

/**
 * K2 — the rules every locale file must satisfy before its strings can reach a learner.
 * specs/kurdish-i18n/plan.md
 *
 * Most of this file asserts the checks REJECT. A parity gate that has never rejected anything is
 * decoration — the same discipline as Phase 5's differ and Phase 6's teeth check.
 *
 * Hermetic: JSON only.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const en = JSON.parse(readFileSync(join(root, "apps/web/src/locales/en.json"), "utf8"));

const get = (obj, path) => path.split(".").reduce((a, k) => a?.[k], obj);
const vars = (s) => (typeof s === "string" ? [...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort() : []);

/**
 * The four rules. Exported so the failure cases below can exercise them on synthetic input rather
 * than requiring a broken file to be committed.
 */
export function localeProblems(english, locale) {
  const problems = [];
  const englishKeys = new Set(leafKeys(english));

  for (const key of leafKeys(locale)) {
    // 1. An orphan key is a typo that renders nothing and fails nowhere.
    if (!englishKeys.has(key)) {
      problems.push(`${key}: not present in en.json`);
      continue;
    }
    const source = get(english, key);
    const target = get(locale, key);

    // 2. A dropped {{variable}} renders a sentence with a hole in it, and no type system sees it.
    const a = vars(source);
    const b = vars(target);
    if (a.join() !== b.join()) {
      problems.push(`${key}: interpolation differs — en has [${a}], locale has [${b}]`);
    }

    // 3. A value identical to the English is an UNTRANSLATED string masquerading as a translated
    //    one. That is worse than absence: fallbackLng would have rendered English honestly, and a
    //    coverage count would not have claimed it.
    if (typeof target === "string" && typeof source === "string" && target.trim() === source.trim()) {
      problems.push(`${key}: identical to the English — absent is honest, this is not`);
    }
    if (typeof target === "string" && target.trim() === "") {
      problems.push(`${key}: empty string — omit the key instead so the fallback renders English`);
    }
  }

  // 4. i18next needs both plural forms or it picks the wrong one silently.
  for (const key of leafKeys(locale)) {
    const m = /^(.*)_one$/.exec(key);
    if (m && !leafKeys(locale).includes(`${m[1]}_other`)) {
      problems.push(`${key}: has _one but no _other`);
    }
  }
  return problems;
}

// --- the real locale, whatever state it is in ---

test("the shipped ckb locale satisfies every rule", () => {
  const path = join(root, "apps/web/src/locales/ckb.json");
  if (!existsSync(path)) return; // not created yet — K5 creates it
  const problems = localeProblems(en, JSON.parse(readFileSync(path, "utf8")));
  assert.deepEqual(problems, [], `apps/web/src/locales/ckb.json:\n  ${problems.join("\n  ")}`);
});

// --- THE failure cases: this gate is only worth running if it rejects ---

test("REJECTS a key that does not exist in English", () => {
  const p = localeProblems({ a: "A" }, { a: "ئا", typoKey: "شت" });
  assert.match(p.join(), /typoKey: not present/);
});

test("REJECTS a dropped interpolation variable", () => {
  // The realistic failure: a translator renders the sentence naturally and loses {{nextReview}}.
  const p = localeProblems(
    { done: "Next review on {{nextReview}}." },
    { done: "پێداچوونەوەی داهاتوو." },
  );
  assert.match(p.join(), /interpolation differs/);
});

test("REJECTS a RENAMED interpolation variable, not just a missing one", () => {
  const p = localeProblems({ x: "{{count}} left" }, { x: "{{number}} ماوە" });
  assert.match(p.join(), /interpolation differs/);
});

test("REJECTS a value identical to the English", () => {
  // The silent one. It looks translated to a coverage count and renders English to a learner —
  // whereas simply omitting the key renders the same English and claims nothing.
  const p = localeProblems({ save: "Save" }, { save: "Save" });
  assert.match(p.join(), /identical to the English/);
});

test("REJECTS an empty string", () => {
  const p = localeProblems({ save: "Save" }, { save: "   " });
  assert.match(p.join(), /empty string/);
});

test("REJECTS a plural with _one but no _other", () => {
  const p = localeProblems({ n_one: "one", n_other: "many" }, { n_one: "یەک" });
  assert.match(p.join(), /has _one but no _other/);
});

test("ACCEPTS a partial locale — a half-translated app is the designed state", () => {
  // fallbackLng: "en" renders English for anything absent, so a locale containing 3 of 381 strings
  // is a partially Kurdish app, never a broken one. If this ever failed, reviewers would be pushed
  // to bulk-approve, which is the exact behaviour the review gate exists to prevent.
  const problems = localeProblems(
    { a: "A", b: "B", c: "C", greet: "Hello {{name}}" },
    { a: "ئا", greet: "سڵاو {{name}}" },
  );
  assert.deepEqual(problems, []);
});
