import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ROUTES, ROUTE_KEYS, fastifyPath } from "../../server/src/routes/index.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("../../packages/contracts/route-manifest.json", import.meta.url), "utf8"),
);
const key = ({ method, path }) => `${method.toUpperCase()} ${path}`;

test("the executable registry has one derived key projection and no duplicate allowlist", () => {
  assert.deepEqual(ROUTE_KEYS, ROUTES.map((route) => route.key));
  assert.equal(Object.isFrozen(ROUTES), true, "the executable registry must be immutable after boot");
  assert.ok(ROUTES.every(Object.isFrozen), "a route entry can be mutated after validation");
  assert.equal(Object.isFrozen(ROUTE_KEYS), true, "the derived route-key projection must be immutable");

  const main = readFileSync(new URL("../../server/src/main.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /\bPORTABLE\b/, "main.mjs still owns a second route allowlist");
  assert.match(main, /ROUTE_KEYS/, "startup must validate against the executable registry projection");
});

test("the registry exactly matches the manifest-approved executable transition set", () => {
  const retained = manifest.baselineOperations.filter((operation) => operation.target === "retain");
  const retiredLocal = manifest.baselineOperations.filter(
    (operation) => operation.nodeImplementationStatus === "implemented-transition",
  );
  const additions = manifest.targetAdditions.filter((operation) =>
    ["implemented-node", "implemented-owner-gated"].includes(operation.implementationStatus),
  );
  const expected = [...retained, ...retiredLocal, ...additions].map(key).sort();

  assert.deepEqual([...ROUTE_KEYS].sort(), expected);
  assert.equal(retained.length, 38, "the approved retained baseline drifted");

  const planned = manifest.targetAdditions
    .filter((operation) => operation.implementationStatus === "planned-owner-gated")
    .map(key);
  for (const routeKey of planned) {
    assert.equal(ROUTE_KEYS.includes(routeKey), false, `${routeKey} bypassed its owner production gate`);
  }

  const ownerGated = manifest.targetAdditions
    .filter((operation) => operation.implementationStatus === "implemented-owner-gated")
    .map(key)
    .sort();
  assert.deepEqual(
    ROUTES.filter((route) => route.ownerGate === "device-identity").map((route) => route.key).sort(),
    ownerGated,
  );

  const retired = manifest.baselineOperations.filter((operation) => operation.target === "retire");
  assert.ok(
    retired.every((operation) =>
      ["implemented-transition", "rust-only-transition"].includes(operation.nodeImplementationStatus),
    ),
    "every blocked retirement needs an explicit current implementation state",
  );
  assert.ok(
    retiredLocal.every((operation) => operation.removalState === "blocked-by-transitional-callers"),
    "a retired route may stay executable only while its manifest removal gate is blocked",
  );
});

test("every executable entry is internally consistent and unique", () => {
  assert.equal(new Set(ROUTE_KEYS).size, ROUTE_KEYS.length, "a duplicate key makes one handler unreachable");
  for (const route of ROUTES) {
    const [method, path] = route.key.split(" ");
    assert.equal(route.method, method.toLowerCase(), `${route.key}: method disagrees with key`);
    assert.equal(route.path, path, `${route.key}: path disagrees with key`);
    assert.equal(typeof route.handler, "function", `${route.key}: handler is not executable`);
  }
});

test("fastifyPath converts contract paths without turning action colons into parameters", () => {
  assert.equal(fastifyPath("/v1/recitation-sessions/{id}"), "/v1/recitation-sessions/:id");
  assert.equal(
    fastifyPath("/v1/quran/ayahs/{surah_number}/{ayah_number}"),
    "/v1/quran/ayahs/:surah_number/:ayah_number",
  );
  assert.equal(fastifyPath("/v1/ml/alignments:predict"), "/v1/ml/alignments::predict");
  assert.equal(fastifyPath("/v1/ml/tajweed-findings:predict"), "/v1/ml/tajweed-findings::predict");
  assert.equal(fastifyPath("/v1/x/{id}/y:go"), "/v1/x/:id/y::go");
});

test("canonical verification invokes the registry and standalone proofs exactly once", () => {
  const verify = readFileSync(new URL("../../scripts/verify.sh", import.meta.url), "utf8");
  const active = verify
    .split("\n")
    .filter((line) => line.includes("node ") && line.includes("--test "))
    .filter((line) => !line.trimStart().startsWith("#"));
  for (const target of ["tests/node-api/route-registry.test.mjs", "tests/node-api/standalone.test.mjs"]) {
    assert.equal(active.filter((line) => line.includes(target)).length, 1, `${target} must run exactly once`);
  }
});
