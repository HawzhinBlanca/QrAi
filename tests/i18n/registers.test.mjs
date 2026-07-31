import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { leafKeys } from "./lib/keys.mjs";

/**
 * K1 — every user-facing string is classified, and the classification cannot drift.
 * specs/kurdish-i18n/plan.md
 *
 * The classification is what decides who may translate a string, and in particular which strings are
 * NEVER AI-drafted. A stale classification would silently move a religious term into the draftable
 * set — so this asserts it covers `en.json` exactly, in both directions.
 *
 * Hermetic: two JSON files.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const en = JSON.parse(readFileSync(join(root, "apps/web/src/locales/en.json"), "utf8"));
const registers = JSON.parse(readFileSync(join(root, "specs/kurdish-i18n/registers.json"), "utf8"));

const VALID = ["ui", "product", "religious", "brand"];

test("every English string is classified", () => {
  const missing = leafKeys(en).filter((k) => !(k in registers.keys));
  assert.deepEqual(
    missing,
    [],
    `unclassified strings — decide what each is in specs/kurdish-i18n/registers.json:\n  ${missing.join("\n  ")}`,
  );
});

test("the classification names no string that no longer exists", () => {
  const keys = new Set(leafKeys(en));
  const stale = Object.keys(registers.keys).filter((k) => !keys.has(k));
  assert.deepEqual(stale, [], `stale entries (renamed or deleted upstream):\n  ${stale.join("\n  ")}`);
});

test("every register is one of the four, and the counts match reality", () => {
  const counted = {};
  for (const [key, entry] of Object.entries(registers.keys)) {
    assert.ok(VALID.includes(entry.register), `${key}: invalid register ${JSON.stringify(entry.register)}`);
    counted[entry.register] = (counted[entry.register] ?? 0) + 1;
  }
  assert.deepEqual(counted, registers.counts, "the recorded counts disagree with the entries");
  assert.equal(
    Object.values(counted).reduce((a, b) => a + b, 0),
    leafKeys(en).length,
  );
});

test("every religious and brand entry carries a reason", () => {
  // These two registers are the ones that RESTRICT what may be done with a string. A restriction
  // without a stated reason is indistinguishable from an accident, and the next person will remove it.
  for (const [key, entry] of Object.entries(registers.keys)) {
    if (entry.register === "religious" || entry.register === "brand") {
      assert.ok(
        (entry.reason ?? "").length > 20,
        `${key}: a ${entry.register} entry needs a real reason, got ${JSON.stringify(entry.reason)}`,
      );
    }
  }
});

test("the religious set is non-trivial — an empty one would mean the guard does nothing", () => {
  // If a refactor ever emptied this set, every restriction below it would pass vacuously and the
  // drafting boundary would quietly disappear.
  assert.ok(registers.counts.religious > 50, `only ${registers.counts.religious} religious strings — verify that is right`);
});

test("the terms that must never be AI-drafted are all classified religious", () => {
  // A spot-check on the classifier itself: these are the words whose Kurdish rendering is a
  // scholarly judgement. If any lands outside `religious`, the boundary has a hole.
  const mustBeReligious = ["tajweed", "makhraj", "madd", "ghunnah", "recit", "memoriz", "scholar", "surah"];
  const wrong = [];
  for (const key of leafKeys(en)) {
    const value = key.split(".").reduce((a, k) => a?.[k], en);
    const hay = `${key} ${typeof value === "string" ? value : ""}`.toLowerCase();
    if (mustBeReligious.some((t) => hay.includes(t)) && registers.keys[key].register !== "religious") {
      wrong.push(`${key} (${registers.keys[key].register})`);
    }
  }
  assert.deepEqual(wrong, [], `these mention protected terms but are not classified religious:\n  ${wrong.join("\n  ")}`);
});
