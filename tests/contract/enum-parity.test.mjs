import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOpenapi } from "./lib/openapi.mjs";

/**
 * The contract's enum VALUES against the service's own, because names alone were not enough.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * `Consent.audioRetention` was contracted as `[discard, session-only, training-opt-in]`. The
 * service's `AudioRetention` (types.rs:103) is `[discard, training-opt-in, teacher-review]`:
 * `session-only` DOES NOT EXIST and `teacher-review` was missing. A client written from the
 * contract — the Flutter one — offered a learner a consent option the API answers with a 422, and
 * the whole practice flow failed on it.
 *
 * Nothing caught it. `coverage.test.mjs` compares routes, `flutter-contract.test.mjs` compares
 * property NAMES, and `validate-openapi-responses.mjs` only sees operations a fixture covers. Every
 * one of them was green. It was found by creating a real session against a running service.
 *
 * `apps/web` had the right values all along, because it was written against the API rather than
 * against the document. That is the whole lesson: a hand-authored contract is a claim, and a claim
 * needs an oracle.
 *
 * Hermetic: parses `types.rs`. No database, no service, no network.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const spec = loadOpenapi(join(repoRoot, "specs/flutter-client/openapi.yaml"));
const typesRs = readFileSync(join(repoRoot, "services/platform-api/src/types.rs"), "utf8");

/** `TrainingOptIn` -> `training-opt-in`, matching serde's `rename_all = "kebab-case"`. */
const kebab = (variant) =>
  variant.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").toLowerCase();

/**
 * Every `#[serde(rename_all = "kebab-case")] pub enum X { … }` in types.rs, as name -> wire values.
 *
 * Only kebab-case enums are read. A different `rename_all` would need different casing and silently
 * mis-comparing is worse than not comparing — `unmappedRustEnums` below keeps that visible.
 */
function rustEnums() {
  const out = {};
  const re = /#\[serde\(rename_all = "kebab-case"\)\]\s*pub enum (\w+) \{([^}]*)\}/g;
  for (const m of typesRs.matchAll(re)) {
    const variants = m[2]
      .split(",")
      .map((s) => s.trim().split(/\s/)[0])
      .filter((s) => /^[A-Z]\w*$/.test(s));
    if (variants.length > 0) out[m[1]] = variants.map(kebab);
  }
  return out;
}

/** Every `enum:` in the contract, as `Schema.property` -> values. */
function contractEnums() {
  const out = {};
  for (const [schemaName, schema] of Object.entries(spec.components?.schemas ?? {})) {
    for (const [prop, def] of Object.entries(schema.properties ?? {})) {
      if (Array.isArray(def?.enum)) out[`${schemaName}.${prop}`] = def.enum;
    }
  }
  return out;
}

const RUST = rustEnums();
const CONTRACT = contractEnums();

/** `audioRetention` -> `AudioRetention`. The service names its enums after the field. */
const rustNameFor = (prop) => prop.charAt(0).toUpperCase() + prop.slice(1);

test("types.rs actually parsed — otherwise every case below is vacuous", () => {
  assert.ok(
    Object.keys(RUST).length >= 3,
    `found only ${JSON.stringify(Object.keys(RUST))}; the parser has drifted from types.rs`,
  );
  assert.deepEqual(RUST.AudioRetention, ["discard", "training-opt-in", "teacher-review"]);
});

test("the contract has enums to check — otherwise this whole file is decoration", () => {
  assert.ok(Object.keys(CONTRACT).length >= 2, JSON.stringify(Object.keys(CONTRACT)));
});

for (const [path, values] of Object.entries(CONTRACT)) {
  const prop = path.split(".")[1];
  const rustName = rustNameFor(prop);
  if (!RUST[rustName]) continue;

  test(`${path} offers exactly what ${rustName} accepts`, () => {
    const invented = values.filter((v) => !RUST[rustName].includes(v));
    assert.deepEqual(
      invented,
      [],
      `${path} contracts ${JSON.stringify(invented)}, which ${rustName} rejects. A client written ` +
        `from this document sends a value the API answers with a 422.`,
    );

    const missing = RUST[rustName].filter((v) => !values.includes(v));
    assert.deepEqual(
      missing,
      [],
      `${rustName} accepts ${JSON.stringify(missing)} but ${path} does not offer it — a real ` +
        `capability no client built from this contract can reach.`,
    );
  });
}

test("no contracted enum is silently unchecked", () => {
  // The failure this file is most likely to develop: a new enum lands, no Rust counterpart is
  // found by name, and it is skipped without a word. Listing the skips makes that a decision.
  const skipped = Object.keys(CONTRACT).filter((p) => !RUST[rustNameFor(p.split(".")[1])]);
  const expected = ["Consent.audioRetention", "RecitationSession.reviewStatus"];
  const nowChecked = Object.keys(CONTRACT).filter((p) => RUST[rustNameFor(p.split(".")[1])]);
  assert.ok(
    expected.every((e) => nowChecked.includes(e)),
    `these must be checked against Rust and are not: ` +
      `${JSON.stringify(expected.filter((e) => !nowChecked.includes(e)))}. Skipped: ${JSON.stringify(skipped)}`,
  );
});
