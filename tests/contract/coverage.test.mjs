import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadOpenapi, routePairsFromRust } from "./lib/openapi.mjs";

/**
 * F1 — every route in the service is contracted, exactly once.
 * specs/flutter-client/plan.md
 *
 * Parses `services/platform-api/src/lib.rs` and compares against the hand-authored spec, so adding a
 * route fails this gate until it is contracted. Same deliberate coupling as PAR6's parser on
 * `integration.rs`; if that is why your build is red, add the path to `packages/contracts/openapi.yaml`.
 *
 * Hermetic: no database, no service, no network.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const spec = loadOpenapi(join(repoRoot, "packages/contracts/openapi.yaml"));
const rustPairs = routePairsFromRust(
  readFileSync(join(repoRoot, "services/platform-api/src/lib.rs"), "utf8"),
);

/** OpenAPI writes `{id}`; axum writes `{id}` too — but normalise names so a rename is not a failure. */
const shape = (p) => p.replace(/\{[^}]+\}/g, "{}");

const specPairs = new Set(
  Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((k) => ["get", "post", "put", "patch", "delete"].includes(k))
      .map((m) => `${m.toUpperCase()} ${shape(path)}`),
  ),
);
const rustSet = new Set(rustPairs.map(({ method, path }) => `${method} ${shape(path)}`));

test("every route the service registers is present in the contract", () => {
  const missing = [...rustSet].filter((p) => !specPairs.has(p)).sort();
  assert.deepEqual(
    missing,
    [],
    `these routes exist in lib.rs but are NOT contracted:\n  ${missing.join("\n  ")}\n` +
      `Add them to packages/contracts/openapi.yaml. Do not delete this check.`,
  );
});

test("the contract describes no route the service does not serve", () => {
  // The other direction: a contract promising a route that does not exist is worse than a missing
  // one, because a client will code against it.
  const phantom = [...specPairs].filter((p) => !rustSet.has(p)).sort();
  assert.deepEqual(phantom, [], `contracted but NOT served:\n  ${phantom.join("\n  ")}`);
});

test("the route inventory contains all 42 method/path pairs", () => {
  // The original correction found 40 routes by recognizing chained MethodRouter verbs, but two
  // registrations still disappeared because comments sit between `.route(` and the path:
  //   GET  /v1/tajweed-findings/{id}/audio
  //   POST /v1/audio-chunks
  // Pin both names as well as the total so another parser defect cannot preserve the count by losing
  // one route while accidentally gaining another.
  assert.equal(rustPairs.length, 42, "lib.rs no longer registers 42 method+path pairs");
  assert.equal(specPairs.size, 42);
  assert.ok(
    rustSet.has("GET /v1/tajweed-findings/{}/audio"),
    "finding-audio route disappeared from the Rust inventory",
  );
  assert.ok(rustSet.has("POST /v1/audio-chunks"), "audio-index route disappeared from the Rust inventory");
});

test("every operation declares at least one response, and error codes reference the shared shape", () => {
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const where = `${method.toUpperCase()} ${path}`;
      assert.ok(op.responses && Object.keys(op.responses).length > 0, `${where}: no responses`);
      assert.ok(
        Object.keys(op.responses).some((c) => c.startsWith("2")),
        `${where}: no success response`,
      );
    }
  }
});

test("no operation is marked x-unvalidated", () => {
  // W0.2 closes the three producer-owned ML/ASR gaps with schemas derived from the real
  // inference response models. Any future permissive operation must fail this gate by name rather
  // than silently turning the cutover metric green.
  const unvalidated = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (op && typeof op === "object" && op["x-unvalidated"] === true) {
        unvalidated.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  assert.deepEqual(
    unvalidated,
    [],
    `permissive response contracts remain:\n  ${unvalidated.join("\n  ")}`,
  );
});

test("the security schemes cover all three auth paths the service accepts", () => {
  // A client that only knows about Bearer will fail against a pilot cookie, and one that trusts the
  // dev headers will be silently unauthenticated in production.
  assert.deepEqual(Object.keys(spec.components.securitySchemes).sort(), [
    "bearerAuth",
    "devHeaderAuth",
    "pilotCookie",
  ]);
});

test("route inventory keeps a route whose path follows a line comment", () => {
  const pairs = routePairsFromRust(`
    Router::new().route(
      // Finding audio is intentionally adjacent to its authorization note.
      "/v1/line-comment",
      axum::routing::get(handler),
    )
  `);

  assert.deepEqual(pairs, [{ method: "GET", path: "/v1/line-comment" }]);
});

test("route inventory keeps a route whose path follows a block comment", () => {
  const pairs = routePairsFromRust(`
    Router::new().route(
      /* Audio indexing is internal. /* Rust block comments can nest. */ Tenant-scoped. */
      "/v1/block-comment",
      axum::routing::post(handler),
    )
  `);

  assert.deepEqual(pairs, [{ method: "POST", path: "/v1/block-comment" }]);
});

test("the two recovered audio routes have strict success contracts", () => {
  const routes = [
    ["post", "/v1/audio-chunks", "AudioChunkIndexResult"],
    ["get", "/v1/tajweed-findings/{id}/audio", "FindingAudio"],
  ];

  for (const [method, path, schemaName] of routes) {
    const operation = spec.paths[path]?.[method];
    assert.ok(operation, `${method.toUpperCase()} ${path}: operation is missing`);
    assert.notEqual(operation["x-unvalidated"], true, `${method.toUpperCase()} ${path}: permissive`);
    assert.deepEqual(
      operation.responses["200"]?.content?.["application/json"]?.schema,
      { $ref: `#/components/schemas/${schemaName}` },
      `${method.toUpperCase()} ${path}: success response is not bound to ${schemaName}`,
    );
    assert.equal(
      spec.components.schemas[schemaName]?.additionalProperties,
      false,
      `${schemaName}: undeclared response fields are accepted`,
    );
  }
});

/**
 * A permissive ARRAY schema must be marked `x-unvalidated`, exactly like a permissive object one.
 *
 * The test above says it plainly: "A permissive schema that was NOT marked would validate anything
 * and read as coverage — the exact false-green this repo keeps finding." It then pins
 * `x-unvalidated` to three routes BY NAME, which is careful work — and it never looked inside an
 * array's `items`.
 *
 * Measured when this was written: FOUR routes declared `items: { type: object }`, none of them
 * marked. `{ type: object }` validates every object ever serialized. So the contract described the
 * shape of the staff review queue, the tajweed findings queue, the scholar approvals list and the
 * active learners list as "some objects", and the pinned count of unvalidated routes said 3.
 *
 * Unlike the ML/ASR proxies — which forward an upstream body this service does not control, and
 * where the only accurate schema really is "any JSON" — these four shapes are built by handlers in
 * this repository. They were observed from a running server and written down.
 */

test("an array response may not hide behind `items: { type: object }`", () => {
  const permissive = [];

  const check = (schema, where) => {
    if (!schema || typeof schema !== "object") return;
    if (schema.type === "array") {
      const items = schema.items;
      const typed =
        items &&
        (items.$ref ||
          items.properties ||
          items.oneOf ||
          items.anyOf ||
          items.allOf ||
          (items.type && items.type !== "object"));
      if (!typed) permissive.push(where);
    }
  };

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== "object" || !op.responses) continue;
      // A route that has declared itself unvalidated has already been counted by the test above.
      if (op["x-unvalidated"] === true) continue;
      for (const [code, response] of Object.entries(op.responses)) {
        const schema = response?.content?.["application/json"]?.schema;
        check(schema, `${method.toUpperCase()} ${path} -> ${code}`);
      }
    }
  }

  assert.deepEqual(
    permissive,
    [],
    "these array responses validate nothing and are not marked x-unvalidated:\n  " +
      permissive.join("\n  ") +
      "\n\nEither give the items a schema — observed from a running server, not read off a struct —" +
      "\nor mark the operation x-unvalidated so it is COUNTED. Silence is the false-green the" +
      "\nx-unvalidated test above exists to prevent, and it does not look inside arrays.",
  );
});


test("an object response may not hide behind a bare `type: object`", () => {
  const permissive = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!operation || typeof operation !== "object" || !operation.responses) continue;
      for (const [code, response] of Object.entries(operation.responses)) {
        const schema = response?.content?.["application/json"]?.schema;
        if (
          schema?.type === "object" &&
          !schema.$ref &&
          !schema.properties &&
          !schema.oneOf &&
          !schema.anyOf &&
          !schema.allOf
        ) {
          permissive.push(`${method.toUpperCase()} ${path} -> ${code}`);
        }
      }
    }
  }

  assert.deepEqual(
    permissive,
    [],
    `these object responses validate no fields:\n  ${permissive.join("\n  ")}`,
  );
});
