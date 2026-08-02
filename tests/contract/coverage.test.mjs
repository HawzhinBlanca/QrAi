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
 * `integration.rs`; if that is why your build is red, add the path to `specs/flutter-client/openapi.yaml`.
 *
 * Hermetic: no database, no service, no network.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const spec = loadOpenapi(join(repoRoot, "specs/flutter-client/openapi.yaml"));
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
      `Add them to specs/flutter-client/openapi.yaml. Do not delete this check.`,
  );
});

test("the contract describes no route the service does not serve", () => {
  // The other direction: a contract promising a route that does not exist is worse than a missing
  // one, because a client will code against it.
  const phantom = [...specPairs].filter((p) => !rustSet.has(p)).sort();
  assert.deepEqual(phantom, [], `contracted but NOT served:\n  ${phantom.join("\n  ")}`);
});

test("the pair count is 39, CORRECTING Phase 7's 34", () => {
  // Phase 7's research counted 34 by matching only `axum::routing::<verb>(`. Five methods are
  // registered CHAINED on an existing MethodRouter — `axum::routing::get(h).post(h2)` — on
  // /v1/recitation-sessions, /v1/recitation-sessions/{id}/alignments, /v1/scholar-approvals,
  // /v1/agent-runs, and /v1/learner/progress. Those were invisible to that pattern.
  //
  // Found because the hand-authored contract listed them and this test reported them as routes the
  // service does not serve. Two independently-derived lists disagreeing is exactly what a contract
  // is for; pinning the number keeps a future under-count from passing quietly.
  //
  // 38 -> 39 (2026-08-02, ADR-0027 action item 4): GET /v1/recitation-sessions/{id}/tajweed-findings.
  // A learner had no route that READ a finding — `/v1/tajweed-findings` is staff-only and the ML
  // predict route re-analyses instead of reading — so a teacher's promotion moved a row nothing
  // learner-facing could reach.
  assert.equal(rustPairs.length, 39, "lib.rs no longer registers 39 method+path pairs");
  assert.equal(specPairs.size, 39);
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

test("x-unvalidated is USED, and its count is pinned so it can only shrink deliberately", () => {
  // A permissive schema that was NOT marked would validate anything and read as coverage — the
  // exact false-green this repo keeps finding. Marking it makes the gap countable.
  //
  // 15 → 3 (C3). The 12 that shrank all gained a schema written from a RESPONSE OBSERVED against a
  // running server, never from reading a Rust struct.
  //
  // ── Why the last 3 are NOT going to zero ───────────────────────────────────────────────────────
  // They are the ML/ASR proxies. Each returns `Json<serde_json::Value>` straight from an upstream
  // service: the platform API parses the body and forwards it verbatim, so the SHAPE belongs to the
  // ML/ASR contract, not to this one. Writing a schema here would assert a shape this service does
  // not control and cannot keep.
  //
  // Not even `type: object` is true — `serde_json::Value` passes an array or a scalar through just
  // as happily. The only accurate schema is "any JSON", which validates nothing, which is precisely
  // what x-unvalidated exists to mark.
  //
  // So `response-schemas-validated` in scripts/cutover-readiness.mjs stays UNMET, and closing it
  // requires giving these routes a real contract — a PRODUCT change, not a documentation one. See
  // specs/contract-coverage-closure/tasks.md.
  const unvalidated = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (op && typeof op === "object" && op["x-unvalidated"] === true) {
        unvalidated.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  assert.deepEqual(
    unvalidated.sort(),
    [
      "POST /v1/asr/force-align",
      "POST /v1/asr/transcribe",
      "POST /v1/ml/tajweed-findings:predict",
    ],
    "the remainder is pinned BY NAME, not by count: a different route becoming unvalidated is a " +
      "regression even when the total stays at 3, and a count alone would not notice the swap.",
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
