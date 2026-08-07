import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileResponseValidators, loadOpenapi, templateFor } from "../../contract/lib/openapi.mjs";

/**
 * C3 — make the OpenAPI schemas load-bearing for routes the golden fixtures never touch.
 *
 * `scripts/validate-openapi-responses.mjs` checks the contract against the 26 recorded fixture
 * steps. **None of the 8 routes C1/C2 cover is one of them**, so the 12 schemas written in C3 would
 * have had nothing checking them — a schema no oracle exercises is exactly the decoration this whole
 * exercise is against. Discovered by running the validator after writing them: `validated: 14`,
 * unchanged.
 *
 * So the parity tests validate their own live responses against the contract. Same schemas, second
 * oracle, and it runs on every gate.
 */

const spec = loadOpenapi(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages/contracts/openapi.yaml"),
);
const validators = compileResponseValidators(spec);

/**
 * Assert a live response satisfies the contracted schema for its operation.
 *
 * FAILS LOUDLY when no schema is found, rather than passing. A silent skip would make every typo in
 * a path or status a green test — the failure mode that makes a contract suite worthless precisely
 * when someone renames a route.
 */
export function assertMatchesContract(method, concretePath, res) {
  const template = templateFor(spec, method, concretePath);
  assert.ok(template, `no OpenAPI path matches ${method} ${concretePath} — contract it or fix the path`);

  const key = `${method} ${template} ${res.status}`;
  const entry = validators.get(key);
  assert.ok(entry, `no contracted ${res.status} response for ${method} ${template}`);
  assert.ok(
    !entry.unvalidated,
    `${key} is x-unvalidated — validating against a permissive schema proves nothing, so this ` +
      `call should not be asserting the contract at all`,
  );

  const ok = entry.validate(res.body);
  assert.ok(
    ok,
    `${key} does not match the contract:\n` +
      (entry.validate.errors ?? [])
        .map((e) => `  ${e.instancePath || "/"} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ""}`)
        .join("\n") +
      `\n\nobserved: ${JSON.stringify(res.body).slice(0, 400)}`,
  );
}
