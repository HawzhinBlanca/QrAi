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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// P2.2 — the locale capability manifest, held to the locale files themselves.
//
// The rules above check that every key IN a locale is well-formed. An EMPTY locale satisfies every
// one of them vacuously: no key can carry a dropped interpolation variable, or duplicate the
// English, or be blank, if there is no key. `ckb.json` is `{}` and the suite was green — not because
// the Kurdish translation is correct, but because there is none.
//
// `apps/web/src/locales/capability.json` states what each locale CLAIMS. These assert the claim
// against reality in BOTH directions, because a manifest that can drift from the thing it describes
// is decoration.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const capability = JSON.parse(
  readFileSync(join(root, "apps/web/src/locales/capability.json"), "utf8"),
);

function shippedLocale(code) {
  const path = join(root, `apps/web/src/locales/${code}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

test("every language the app offers has a row in the capability manifest", () => {
  // The registered set is the one `i18n/index.ts` builds its resources from, which is
  // SUPPORTED_LANGUAGE_CODES. A language selectable in the UI with no row here is a claim nobody
  // wrote down.
  const source = readFileSync(join(root, "packages/contracts/src/index.ts"), "utf8");
  const declared = /SUPPORTED_LANGUAGE_CODES = \[([^\]]*)\]/.exec(source);
  assert.ok(declared, "could not read SUPPORTED_LANGUAGE_CODES out of packages/contracts");
  const codes = [...declared[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 5, `parsed only ${codes.length} language codes; the regex is stale`);

  assert.deepEqual(
    codes.filter((c) => !(c in capability.locales)),
    [],
    "a language the app offers has no capability row — its claim is undeclared",
  );
  assert.deepEqual(
    Object.keys(capability.locales).filter((c) => !codes.includes(c)),
    [],
    "the manifest describes a language the app does not offer",
  );
});

test("the manifest's key counts are the REAL key counts, in both directions", () => {
  const reference = shippedLocale(capability.referenceLocale);
  const referenceKeys = leafKeys(reference).length;
  assert.ok(referenceKeys > 0, "the reference locale is empty; nothing can be measured against it");

  const wrong = [];
  for (const [code, row] of Object.entries(capability.locales)) {
    const actual = leafKeys(shippedLocale(code)).length;
    if (actual !== row.keys) wrong.push(`${code}: manifest says ${row.keys}, file has ${actual}`);
  }
  assert.deepEqual(
    wrong,
    [],
    `the capability manifest disagrees with the locale files:\n  ${wrong.join("\n  ")}\n` +
      "Both directions matter: a locale that gained strings without updating its row overstates " +
      "nothing but hides progress, and one that lost them overstates everything.",
  );
});

test("a locale's declared status matches how much of it actually exists", () => {
  const referenceKeys = leafKeys(shippedLocale(capability.referenceLocale)).length;
  const wrong = [];

  for (const [code, row] of Object.entries(capability.locales)) {
    const actual = leafKeys(shippedLocale(code)).length;
    if (row.status === "placeholder" && actual !== 0) {
      wrong.push(`${code}: declared placeholder but ships ${actual} strings`);
    }
    if (row.status === "complete" && actual < referenceKeys) {
      wrong.push(`${code}: declared complete but has ${actual} of ${referenceKeys} keys`);
    }
    if (row.status === "partial" && (actual === 0 || actual >= referenceKeys)) {
      wrong.push(`${code}: declared partial but has ${actual} of ${referenceKeys} keys`);
    }
    // A claim of `complete` or `partial` asserts somebody stands behind the strings. P2.4 is about
    // getting that person; this is about not being able to claim it without one.
    if (row.status !== "placeholder" && !row.reviewer) {
      wrong.push(`${code}: declared ${row.status} with no reviewer — nobody stands behind it`);
    }
  }

  assert.deepEqual(wrong, [], `declared status and reality disagree:\n  ${wrong.join("\n  ")}`);
});

test("the DEFAULT language's coverage is stated, not discovered", () => {
  // The one a user gets without choosing. `i18n/index.ts` sets `lng: "ckb"` and ckb ships zero
  // strings, so a Kurdish-first product presents an entirely English interface by default and
  // nothing anywhere said so.
  //
  // This does NOT fail on that being true — changing the default language is a product decision, not
  // a defect fix, and a permanently-red gate teaches people to ignore it. It fails if the default
  // ever stops matching what the manifest says about it, so the gap cannot quietly change shape.
  const source = readFileSync(join(root, "apps/web/src/i18n/index.ts"), "utf8");
  const configured = /\blng:\s*"([a-z-]+)"/.exec(source);
  assert.ok(configured, "could not read the configured default language out of i18n/index.ts");
  const [, defaultLocale] = configured;

  const row = capability.locales[defaultLocale];
  assert.ok(row, `the default language ${defaultLocale} has no capability row`);

  const actual = leafKeys(shippedLocale(defaultLocale)).length;
  assert.equal(
    actual,
    row.keys,
    `the default language ${defaultLocale} ships ${actual} strings; the manifest says ${row.keys}`,
  );

  if (row.status === "placeholder") {
    assert.equal(
      actual,
      0,
      `${defaultLocale} is the DEFAULT language and is declared a placeholder, yet ships ${actual} ` +
        "strings. Either it has become a real translation — update the manifest — or something is " +
        "half-done.",
    );
    // Stated rather than asserted away: this is the product's condition today, in one line, in the
    // gate's own output.
    console.log(
      `    note: the default language "${defaultLocale}" is a placeholder — every string a user ` +
        `sees is ${capability.referenceLocale} via fallback`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// P2.2, the two halves the manifest declared and nothing enforced.
//
// 1. EXPIRY. Every row carries `reviewExpires` and no code anywhere reads it — the only hit outside
//    the manifest itself is the ledger sentence promising it. A locale reviewed once would keep
//    claiming `complete` for the rest of the product's life, which is the failure mode the field
//    was added to prevent. `apps/web/src/data/platform.ts` already enforces the equivalent
//    `reviewExpiresAt` on the platform's own capability records (ADR, DECISIONS.md); the shipped
//    interface strings had no such rule.
//
// 2. NO FALLBACK. `i18n/index.ts` sets `fallbackLng: "en"`, so a missing key renders English and
//    nothing raises. The status check above compares COUNTS (`actual < referenceKeys`), and a count
//    cannot see identity: a locale carrying 389 keys of which some are orphans and an equal number
//    of English keys are absent passes it while rendering English to a learner who was told the
//    translation was complete. `complete` has to mean zero fallbacks, key by key.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What is wrong with one capability row's review claim, as of `now`.
 *
 * Pure, and separate from the manifest, for the same reason `localeProblems` is: today every row is
 * a `placeholder` with `reviewer: null`, so a rule applied only to the real file would pass without
 * ever having decided anything. The synthetic cases below are where this earns its place.
 *
 * The reference locale is exempt: it is authored here, not translated, so there is no reviewer whose
 * approval could go stale. Anything else claiming review has to say when that claim runs out.
 */
export function reviewClaimProblems(code, row, referenceLocale, now) {
  const problems = [];
  if (row.status === "placeholder") return problems; // claims nothing; nothing to expire
  if (code === referenceLocale) return problems;

  if (!row.reviewer) {
    problems.push(`${code}: declared ${row.status} with no reviewer`);
  }
  if (row.reviewExpires === null || row.reviewExpires === undefined) {
    problems.push(
      `${code}: declared ${row.status} with no reviewExpires — an approval that never runs out is ` +
        "not an approval anybody has to renew",
    );
    return problems;
  }
  const expires = new Date(row.reviewExpires);
  if (!Number.isFinite(expires.getTime())) {
    problems.push(`${code}: reviewExpires is not a date: ${JSON.stringify(row.reviewExpires)}`);
    return problems;
  }
  if (expires <= now) {
    problems.push(
      `${code}: the review expired on ${row.reviewExpires} — the strings are still shipping and ` +
        "nobody currently stands behind them",
    );
  }
  return problems;
}

test("no locale ships a review claim that has run out", () => {
  const problems = Object.entries(capability.locales).flatMap(([code, row]) =>
    reviewClaimProblems(code, row, capability.referenceLocale, new Date()),
  );
  assert.deepEqual(
    problems,
    [],
    `a shipped locale's review claim does not hold:\n  ${problems.join("\n  ")}\n` +
      "Either renew the review and update reviewExpires, or drop the row to `placeholder` so the " +
      "app stops claiming a translation nobody currently vouches for.",
  );
});

test("REJECTS a review that expired yesterday", () => {
  const now = new Date("2026-08-15T00:00:00Z");
  const p = reviewClaimProblems(
    "ckb",
    { status: "complete", keys: 389, reviewer: "A. Reviewer", reviewExpires: "2026-08-14" },
    "en",
    now,
  );
  assert.match(p.join(), /expired on 2026-08-14/);
});

test("ACCEPTS a review that expires tomorrow", () => {
  // The boundary in the other direction, so the rule cannot be satisfied by rejecting everything.
  const now = new Date("2026-08-15T00:00:00Z");
  const p = reviewClaimProblems(
    "ckb",
    { status: "complete", keys: 389, reviewer: "A. Reviewer", reviewExpires: "2026-08-16" },
    "en",
    now,
  );
  assert.deepEqual(p, []);
});

test("REJECTS a review claim with no expiry at all", () => {
  // The likelier mistake: someone writes a reviewer's name and leaves `reviewExpires: null` as it
  // already is in every row, and the claim silently becomes permanent.
  const p = reviewClaimProblems(
    "ar",
    { status: "partial", keys: 40, reviewer: "A. Reviewer", reviewExpires: null },
    "en",
    new Date("2026-08-15T00:00:00Z"),
  );
  assert.match(p.join(), /no reviewExpires/);
});

test("a placeholder needs no reviewer and no expiry", () => {
  // Claiming nothing is the one honest state that costs nothing to hold, which is why every row is
  // in it today. If this rule ever demanded a reviewer here, the pressure would be to upgrade the
  // status rather than to find one.
  const p = reviewClaimProblems("tr", capability.locales.tr, "en", new Date());
  assert.deepEqual(p, []);
});

test("every shipped locale file satisfies the parity rules, not just ckb", () => {
  // The rules above were applied to one hard-coded path. A second locale file appearing — which is
  // exactly what P2.4 produces — would have been checked by nothing.
  const checked = [];
  const failures = [];
  for (const code of Object.keys(capability.locales)) {
    if (code === capability.referenceLocale) continue;
    const path = join(root, `apps/web/src/locales/${code}.json`);
    if (!existsSync(path)) continue;
    checked.push(code);
    const problems = localeProblems(en, JSON.parse(readFileSync(path, "utf8")));
    if (problems.length) failures.push(`${code}:\n    ${problems.join("\n    ")}`);
  }
  assert.ok(
    checked.length >= 1,
    "no non-reference locale file was checked; this test is passing on an empty set",
  );
  assert.deepEqual(failures, [], `locale files break the parity rules:\n  ${failures.join("\n  ")}`);
});

/** English keys a locale does not carry — every one of them renders through `fallbackLng: "en"`. */
export function fallbackKeys(english, locale) {
  const present = new Set(leafKeys(locale));
  return leafKeys(english).filter((key) => !present.has(key));
}

test("a locale declared complete falls back for NOTHING", () => {
  const reference = shippedLocale(capability.referenceLocale);
  const wrong = [];
  for (const [code, row] of Object.entries(capability.locales)) {
    if (row.status !== "complete" || code === capability.referenceLocale) continue;
    const missing = fallbackKeys(reference, shippedLocale(code));
    if (missing.length) {
      wrong.push(
        `${code}: declared complete and falls back to ${capability.referenceLocale} for ` +
          `${missing.length} keys, starting with ${missing.slice(0, 3).join(", ")}`,
      );
    }
  }
  assert.deepEqual(wrong, [], wrong.join("\n  "));
});

test("REJECTS a complete claim that is complete only by COUNT", () => {
  // The case the count check cannot see, and the reason this test exists. Same number of keys as the
  // English, one of them an orphan, one English key absent: `actual < referenceKeys` is false, so
  // the status check passes, and the learner reads English where they were promised Kurdish.
  const english = { a: "A", b: "B", c: "C" };
  const sameCountDifferentKeys = { a: "ئا", b: "ب", zz: "ز" };
  assert.equal(leafKeys(sameCountDifferentKeys).length, leafKeys(english).length);
  assert.deepEqual(fallbackKeys(english, sameCountDifferentKeys), ["c"]);
});
