import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileResponseValidators, derefResponse, loadOpenapi } from "./lib/openapi.mjs";

/**
 * Every response the contract gives a JSON body must have a validator compiled for it — including
 * the ones written as a whole-Response-Object `$ref`.
 *
 * `compileResponseValidators` read `res.content["application/json"].schema` directly. For
 * `'403': { $ref: '#/components/responses/Forbidden' }` — the form EVERY error response in this
 * contract uses — that is `undefined`, so it `continue`d and compiled nothing. 50 contracted
 * responses were checked by nothing, and neither consumer could tell:
 *
 *   - scripts/validate-openapi-responses.mjs counted them under "skipped (no schema)" — a category
 *     meaning "the contract promises no body", which was false — and printed a clean pass. Twelve of
 *     its twenty-six golden fixtures are error responses, so nearly half the oracle was inert.
 *   - assertMatchesContract is careful enough to fail loudly on a missing validator, so it would
 *     have REFUSED any parity test asserting a 403 body. None does; the gap read as "we only assert
 *     happy paths" rather than "we cannot".
 *
 * Negative control before accepting the fix: `components.schemas.Error.properties.error` retyped
 * `string` -> `integer`. Before, the validator run was byte-identical (`validated: 14`, clean pass).
 * After, 11 fixtures fail with `/error must be integer`.
 *
 * Hermetic: synthetic specs, plus one invariant over the real file — see the last test for why that
 * one has to read it.
 */

const spec = loadOpenapi(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "specs/flutter-client/openapi.yaml"),
);

// --- derefResponse ---

const HOST = { components: { responses: { Forbidden: { description: "no", content: { "application/json": { schema: { type: "object" } } } } } } };

test("derefResponse follows a components/responses pointer, and passes an inline response through", () => {
  assert.deepEqual(derefResponse(HOST, { $ref: "#/components/responses/Forbidden" }, "x"), HOST.components.responses.Forbidden);
  const inline = { description: "ok", content: {} };
  assert.equal(derefResponse(HOST, inline, "x"), inline, "a response with no $ref must come back untouched");
});

test("derefResponse THROWS rather than returning undefined for a ref it cannot follow", () => {
  // The whole defect in one assertion. A resolver that returns undefined here puts the caller back
  // where it started: `if (!schema) continue`, and a contracted response silently checked by nothing.
  for (const [ref, why] of [
    ["#/components/responses/Missing", "names a response that does not exist"],
    ["./other.yaml#/Forbidden", "is an external document"],
    ["#/components/schemas/Error", "points somewhere other than components/responses"],
  ]) {
    assert.throws(() => derefResponse(HOST, { $ref: ref }, "GET /x 403"), /GET \/x 403/, `${ref} ${why}`);
  }
  const chained = { components: { responses: { A: { $ref: "#/components/responses/B" }, B: HOST.components.responses.Forbidden } } };
  assert.throws(() => derefResponse(chained, { $ref: "#/components/responses/A" }, "GET /x 403"), /another \$ref/);
});

// --- compileResponseValidators ---

test("a $ref'd response compiles a validator that actually REJECTS a wrong body", () => {
  // Asserting only that a validator EXISTS would pass against a permissive `{}` schema, which is the
  // same nothing in a different shape. So the assertion is that it discriminates.
  const synthetic = {
    openapi: "3.1.0",
    components: {
      schemas: { Error: { type: "object", required: ["error"], properties: { error: { type: "string" } }, additionalProperties: false } },
      responses: { Forbidden: { description: "no", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } },
    },
    paths: { "/x": { get: { responses: { 403: { $ref: "#/components/responses/Forbidden" } } } } },
  };
  const entry = compileResponseValidators(synthetic).get("GET /x 403");
  assert.ok(entry, "a $ref'd response must compile a validator");
  assert.equal(entry.validate({ error: "denied" }), true);
  assert.equal(entry.validate({ error: 7 }), false, "the $ref'd schema must be enforced, not merely present");
  assert.equal(entry.validate({}), false, "`required` must survive the deref");
});

// --- the real contract ---

test("every contracted JSON response in the real spec has a compiled validator", () => {
  // Reads the real file on purpose: the invariant is about THIS contract. It is also what keeps the
  // fix load-bearing — revert derefResponse and this lists all 50 error responses.
  const validators = compileResponseValidators(spec);
  const uncompiled = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      for (const [status, ref] of Object.entries(op.responses ?? {})) {
        const key = `${method.toUpperCase()} ${path} ${status}`;
        if (!derefResponse(spec, ref, key)?.content?.["application/json"]) continue;
        if (!validators.has(key)) uncompiled.push(key);
      }
    }
  }
  assert.deepEqual(uncompiled, [], "these promise a JSON body that no validator checks");
});

test("the error responses are $ref'd, so the case above is the majority of them", () => {
  // Guards the test above against becoming vacuous. If someone inlines every error response, the
  // invariant still passes while no longer exercising deref at all — and the next $ref added would
  // be unprotected. This fails first, and says so.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "specs/flutter-client/openapi.yaml"),
    "utf8",
  );
  const refd = (src.match(/\$ref: '#\/components\/responses\//g) ?? []).length;
  assert.ok(refd >= 40, `expected the contract to still use response-level $ref widely, found ${refd}`);
});
