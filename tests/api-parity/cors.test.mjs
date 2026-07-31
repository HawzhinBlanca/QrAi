import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { request, startApi } from "./lib/harness.mjs";

/**
 * PAR3 — config group: CORS_ALLOWED_ORIGINS set to a single exact origin.
 * specs/api-parity-suite/plan.md §4
 *
 * In deliberately: `specs/flutter-node-migration/plan.md §2.4` names CORS as one of the four
 * blockers where "the obvious port is wrong in the CSRF-enabling direction" — a Node port that
 * reaches for `cors({ origin: true })` reflects any Origin and passes a naive "does it return the
 * same JSON" review. A suite without this test would be green through exactly that regression.
 *
 * The Rust original (integration.rs:3284) needs a process-wide Mutex because it mutates env inside
 * a parallel test binary. A process per config group removes that hazard entirely.
 */

const ALLOWED = "https://allowed.example.com";
const DISALLOWED = "https://disallowed.example.com";

let api;
before(async () => {
  api = await startApi({ env: { CORS_ALLOWED_ORIGINS: ALLOWED } });
});
after(async () => {
  await api?.stop();
});

// integration.rs:3284 — test_platform_api_cors_origin_validation
test("a disallowed Origin gets no access-control-allow-origin header", async () => {
  const res = await request(api.baseUrl, "/health", { tenant: null, headers: { origin: DISALLOWED } });
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("access-control-allow-origin"),
    null,
    "CORS header must be ABSENT for a disallowed origin",
  );
});

test("the allowed Origin is echoed exactly, never as a wildcard", async () => {
  const res = await request(api.baseUrl, "/health", { tenant: null, headers: { origin: ALLOWED } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
});

test("a wildcard is never returned for an allowlisted deployment", async () => {
  // Not in the Rust original, and the specific failure §2.4 predicts: `origin: true` style
  // reflection returns `*` (or the request's own origin) and would pass the first test above by
  // accident on a request with no Origin at all.
  const res = await request(api.baseUrl, "/health", { tenant: null, headers: { origin: DISALLOWED } });
  assert.notEqual(res.headers.get("access-control-allow-origin"), "*");
});
