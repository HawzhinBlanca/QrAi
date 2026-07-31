import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { OTHER_TENANT, request, startApi } from "./lib/harness.mjs";

/**
 * PAR3 — config group: ALLOW_HEADER_AUTH=0, the PRODUCTION default.
 * specs/api-parity-suite/plan.md §4
 *
 * Its own file because the binary reads ALLOW_HEADER_AUTH exactly once, at startup
 * (auth.rs:37-39). A black-box suite cannot flip it between requests.
 */

let api;
before(async () => {
  api = await startApi({ env: { ALLOW_HEADER_AUTH: "0" } });
});
after(async () => {
  await api?.stop();
});

// integration.rs:78 — rejects_spoofed_header_identity_when_header_auth_disabled
test("spoofed x-user-role headers are rejected when header auth is OFF", async () => {
  // Every other test in this suite relies on dev-header identity. This is the one that proves the
  // production default does not accept it — without it, the suite would be green on a build where
  // anyone could claim to be an admin by setting a header.
  const res = await request(api.baseUrl, "/v1/scholar-approvals", {
    role: "admin",
    tenant: OTHER_TENANT,
  });
  assert.equal(res.status, 401, "spoofed header identity must be rejected, a Bearer JWT required");
});

test("the refusal is auth, not a broken server: /health still answers", async () => {
  // Not in the Rust original. A 401 alone would also appear if the process were failing every
  // request for an unrelated reason, which would make the assertion above prove nothing.
  const health = await request(api.baseUrl, "/health");
  assert.equal(health.status, 200);
});
