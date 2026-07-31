/**
 * F2 — validate the hand-authored contract against RECORDED REAL responses.
 * specs/flutter-client/plan.md
 *
 *   node scripts/validate-openapi-responses.mjs
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * A hand-authored spec that has never met a real response is documentation. This replays the 26
 * committed Phase 5 fixtures through ajv validators compiled from the OpenAPI components, so every
 * schema is checked against something the service actually returned.
 *
 * It reads the COMMITTED fixtures rather than calling a live service, so it needs no database and
 * runs in the hermetic gate step. The fixtures were themselves captured from a live service and are
 * byte-pinned, which is what makes them usable as evidence here.
 *
 * ── The rule when they disagree ────────────────────────────────────────────────────────────────
 * The fixtures are authoritative for VALUES; the spec is authoritative for SHAPES. A divergence is a
 * finding to record — never a reason to edit the fixture. An oracle adjusted to agree with the thing
 * it measures has stopped measuring.
 */
import { readFileSync } from "node:fs";

import { compileResponseValidators, loadOpenapi, templateFor } from "../tests/contract/lib/openapi.mjs";

const spec = loadOpenapi("specs/flutter-client/openapi.yaml");
const validators = compileResponseValidators(spec);
const fixtures = JSON.parse(readFileSync("specs/api-golden-fixtures/fixtures/platform-api.json", "utf8"));

let checked = 0;
let skipped = 0;
const failures = [];
const uncontracted = [];

for (const step of fixtures.steps) {
  const { method, path } = step.request;
  const { status, body } = step.response;

  const template = templateFor(spec, method, path);
  if (!template) {
    uncontracted.push(`${method} ${path}`);
    continue;
  }

  const key = `${method} ${template} ${status}`;
  const entry = validators.get(key);
  if (!entry) {
    // The status is contracted without a JSON schema (a bare `description:`), or not contracted at
    // all. Either way there is nothing to check — counted, not silently passed.
    skipped += 1;
    continue;
  }
  if (entry.unvalidated) {
    skipped += 1;
    continue;
  }

  // Fixture bodies carry normalized PLACEHOLDERS (`<ID:session#1>`, `<JWT#1>`) in place of generated
  // values. Those are strings where the schema expects strings, so most schemas validate as-is; a
  // pattern-constrained field is the exception and is reported honestly rather than special-cased.
  checked += 1;
  if (!entry.validate(body)) {
    failures.push({
      step: step.name,
      key,
      errors: entry.validate.errors.map((e) => `${e.instancePath || "$"} ${e.message}`),
    });
  }
}

console.log(`fixtures: ${fixtures.steps.length}  validated: ${checked}  skipped (no schema or x-unvalidated): ${skipped}`);
if (uncontracted.length > 0) {
  console.log(`\nNOT MATCHED to any contracted path (${uncontracted.length}):`);
  for (const u of uncontracted) console.log(`   ${u}`);
}
if (failures.length > 0) {
  console.log(`\n${failures.length} divergence(s) between the contract and a REAL response:`);
  for (const f of failures) {
    console.log(`  [${f.key}] ${f.step}`);
    for (const e of f.errors) console.log(`      ${e}`);
  }
}

// Uncontracted paths are a hard failure: F1 asserts every route is contracted, so a fixture that
// matches none means the two disagree about what exists.
const bad = failures.length + uncontracted.length;
console.log(bad === 0 ? "\nok   the contract matches every real response it covers" : `\nFAIL ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
