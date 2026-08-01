/**
 * N12a — `POST /v1/auth/token`: the Node shell against Rust.
 * specs/migration-completion/plan.md §2
 *
 *   NODE_API_PORTED="POST /v1/auth/token" node --test tests/api-parity/auth-token-parity.test.mjs
 *
 * ── Why the token itself cannot be byte-compared ────────────────────────────────────────────────
 * The JWT carries an `exp` claim of `now + 24h`, so two tokens minted a second apart differ in the
 * payload and therefore in the signature. Byte equality is not the property. What IS contract:
 *   - the token verifies under the SAME secret with the SAME algorithm,
 *   - it carries the same claim NAMES and values (`sub`, `tenant_id`, `role`),
 *   - `exp` lands within the configured TTL,
 * and — separately and non-negotiably — a token minted by EITHER implementation must be accepted by
 * the OTHER. That last one is the only check that proves the two are actually interchangeable, and
 * it is the check a same-implementation round trip silently passes without proving anything.
 *
 * ── The response keys are snake_case, and that is deliberate ────────────────────────────────────
 * Every other route in this API is camelCase. This one returns `user_id`, `tenant_id` and
 * `audit_event_id`, because the handler builds a bare `json!` with no rename. The differ's own
 * suite names it — "FAILS when snake_case is camelCased — the /v1/auth/token regression". A port
 * that "tidied" these into camelCase would break every existing client silently.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { jwtVerify } from "jose";

import { assertAB, assertABMutating } from "./lib/ab.mjs";
import { OTHER_TENANT, TENANT, queryJson, request, startApi, startShell } from "./lib/harness.mjs";

const JWT_SECRET = "test-jwt-secret"; // harness BASE_ENV
const KEY = new TextEncoder().encode(JWT_SECRET);

let api;
let shell;

before(async () => {
  api = await startApi({});
  shell = await startShell({ upstream: api.baseUrl });
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

/** A real seeded user this tenant owns, so the happy path is not testing a 401. */
async function anyLearner() {
  const rows = await queryJson(
    "SELECT id, role FROM users WHERE tenant_id = $1 AND role = 'learner' LIMIT 1",
    [TENANT],
  );
  assert.ok(rows.length > 0, "the corpus must contain a learner for this suite to prove anything");
  return rows[0];
}

const admin = { role: "admin" };

test("a minted token verifies, carries the right claims, and expires in ~24h", async () => {
  const learner = await anyLearner();
  const res = await request(shell.baseUrl, "/v1/auth/token", {
    method: "POST",
    ...admin,
    body: { userId: learner.id, tenantId: TENANT, role: learner.role },
  });
  assert.equal(res.status, 200);

  assert.deepEqual(
    Object.keys(res.body),
    ["audit_event_id", "role", "tenant_id", "token", "user_id"],
    "snake_case, alphabetical (json! is BTreeMap-backed). camelCase here is the known regression.",
  );

  const { payload, protectedHeader } = await jwtVerify(res.body.token, KEY, {
    algorithms: ["HS256"],
  });
  assert.equal(protectedHeader.alg, "HS256");
  assert.equal(payload.sub, learner.id);
  assert.equal(payload.tenant_id, TENANT);
  assert.equal(payload.role, learner.role);

  const ttlHours = (payload.exp - Math.floor(Date.now() / 1000)) / 3600;
  assert.ok(ttlHours > 23.5 && ttlHours <= 24.01, `exp should be ~24h out, got ${ttlHours}h`);
});

/**
 * The check that actually proves interchangeability.
 *
 * A token the shell minted must be accepted by the RUST service, and vice versa. Verifying a
 * token with the same implementation that made it proves only that it is self-consistent — a port
 * with the wrong claim names, or an extra claim, or a different secret encoding, passes that and
 * still cannot talk to the other half of a strangler deployment.
 */
test("a token minted by EITHER implementation is accepted by the OTHER", async () => {
  const learner = await anyLearner();
  const body = { userId: learner.id, tenantId: TENANT, role: learner.role };

  const fromShell = (await request(shell.baseUrl, "/v1/auth/token", { method: "POST", ...admin, body }))
    .body.token;
  const fromRust = (await request(api.baseUrl, "/v1/auth/token", { method: "POST", ...admin, body }))
    .body.token;
  assert.ok(fromShell && fromRust);

  // Cross-verify by USING each token as a credential against the other service.
  for (const [label, token, baseUrl] of [
    ["shell-minted token -> rust", fromShell, api.baseUrl],
    ["rust-minted token -> shell", fromRust, shell.baseUrl],
  ]) {
    const res = await request(baseUrl, "/v1/learner/progress", {
      tenant: null,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200, `${label}: ${res.status} ${res.text.slice(0, 120)}`);
    assert.equal(res.body.learnerId, learner.id, `${label}: wrong identity resolved`);
  }
});

test("only admin and ops may mint — every other role is refused identically", async () => {
  const learner = await anyLearner();
  for (const role of ["learner", "teacher", "scholar", "admin", "ops"]) {
    await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `mint as ${role}`,
      probeFor: () => ({
        path: "/v1/auth/token",
        method: "POST",
        role,
        body: { userId: learner.id, tenantId: TENANT, role: learner.role },
      }),
      // audit_event_id and token are per-call; everything else must match exactly.
      normalize: (b) =>
        b && typeof b === "object" && b.token
          ? { ...b, token: "<JWT>", audit_event_id: "<ID>" }
          : b,
    });
  }
});

test("minting ACROSS tenants is 403, not a silent cross-tenant token", async () => {
  const learner = await anyLearner();
  await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "admin of tenant A mints for tenant B",
    probeFor: () => ({
      path: "/v1/auth/token",
      method: "POST",
      ...admin,
      body: { userId: learner.id, tenantId: OTHER_TENANT, role: learner.role },
    }),
    normalize: (b) => b,
  });
});

test("an unknown user is 401 — NOT 404, which would confirm the id does not exist", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "mint for a nonexistent user",
    probeFor: () => ({
      path: "/v1/auth/token",
      method: "POST",
      ...admin,
      body: { userId: "user-does-not-exist", tenantId: TENANT, role: "learner" },
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 401, "a 404 here is a user-enumeration oracle");
});

test("a role that disagrees with the stored row is 403 — the request cannot promote a user", async () => {
  const learner = await anyLearner();
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "mint a learner an admin token",
    probeFor: () => ({
      path: "/v1/auth/token",
      method: "POST",
      ...admin,
      body: { userId: learner.id, tenantId: TENANT, role: "admin" },
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 403, "the role comes from the DB row, never from the request body");
});

test("the audit event records the CALLER as actor and the target as subject", async () => {
  const learner = await anyLearner();
  const res = await request(shell.baseUrl, "/v1/auth/token", {
    method: "POST",
    ...admin,
    body: { userId: learner.id, tenantId: TENANT, role: learner.role },
  });
  assert.equal(res.status, 200);

  const [row] = await queryJson(
    "SELECT actor_id, subject_id, action, subject_type FROM audit_events WHERE id = $1",
    [res.body.audit_event_id],
  );
  assert.ok(row, "minting a token must leave an audit row");
  assert.equal(row.action, "auth.token.issued");
  assert.equal(row.subject_type, "auth_token");
  assert.equal(row.subject_id, learner.id, "the SUBJECT is the user the token is for");
  assert.notEqual(
    row.actor_id,
    learner.id,
    "the ACTOR must be the admin who asked, not the user the token is for — otherwise the audit " +
      "log says the learner minted their own token",
  );
});

test("a malformed body is rejected with the same status on both", async () => {
  for (const body of [{}, { userId: "x" }, { userId: "x", tenantId: TENANT }, { userId: 1, tenantId: 2, role: 3 }]) {
    await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `malformed ${JSON.stringify(body)}`,
      probeFor: () => ({ path: "/v1/auth/token", method: "POST", ...admin, body }),
      // Rust's 422 body is serde's own error text with line/column offsets — a recorded, unfixed
      // divergence (specs/node-backend-port N6). Compare the STATUS, which is what clients branch on.
      normalize: () => null,
    });
  }
});

test("an unauthenticated request cannot mint", async () => {
  await assertAB(shell.baseUrl, api.baseUrl, {
    path: "/v1/auth/token",
    method: "POST",
    tenant: null,
    body: { userId: "x", tenantId: TENANT, role: "learner" },
  });
});
