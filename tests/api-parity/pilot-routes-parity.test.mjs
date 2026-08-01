/**
 * N13b — bootstrap, logout and invitation minting: the Node shell against Rust.
 * specs/migration-completion/plan.md §2 · port of handlers/pilot.rs
 *
 *   NODE_API_PORTED="POST /v1/pilot/session/bootstrap,POST /v1/pilot/session/logout,POST /v1/pilot/invitations" \
 *     node --test tests/api-parity/pilot-routes-parity.test.mjs
 *
 * ── The cookie ATTRIBUTES are the contract, not just the value ──────────────────────────────────
 * `__Host-` is a browser-enforced prefix: a cookie with that name is rejected OUTRIGHT unless it is
 * `Secure`, has `Path=/`, and carries no `Domain`. Dropping any one of them produces no error
 * anywhere — the browser silently declines to store it and the learner simply never stays logged
 * in. Nothing server-side notices, which is why these are asserted attribute by attribute rather
 * than with a substring match on the whole header.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, before } from "node:test";

import { assertABMutating } from "./lib/ab.mjs";
import { TENANT, queryJson, request, startApi, startShell } from "./lib/harness.mjs";

const ORIGIN = "http://localhost:5173";

let api;
let shell;
let learnerId;
let staffId;

before(async () => {
  api = await startApi({ env: { CORS_ALLOWED_ORIGINS: ORIGIN } });
  shell = await startShell({ upstream: api.baseUrl, env: { CORS_ALLOWED_ORIGINS: ORIGIN } });
  const [learner] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  const [staff] = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role <> 'learner' ORDER BY id LIMIT 1",
    [TENANT],
  );
  assert.ok(learner && staff, "this suite needs one learner and one non-learner in the pilot tenant");
  learnerId = learner.id;
  staffId = staff.id;
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

const mint = (baseUrl, body) =>
  request(baseUrl, "/v1/pilot/invitations", { method: "POST", role: "admin", body });

const boot = (baseUrl, token, headers = { origin: ORIGIN }) =>
  request(baseUrl, "/v1/pilot/session/bootstrap", {
    method: "POST",
    tenant: null,
    headers,
    body: { token },
  });

/**
 * The session row for THIS cookie, found by its own token hash.
 *
 * NOT `ORDER BY created_at DESC LIMIT 1` for the learner. The parity suites run in parallel and
 * `pilot-auth-parity` bootstraps sessions for the same seeded learner, so "the newest session"
 * belongs to whichever file happened to run last. That passed this file standalone and failed
 * inside verify.sh — a flake that would have been "fixed" by a retry.
 */
async function sessionFor(cookieValue) {
  const hash = createHash("sha256").update(cookieValue, "utf8").digest("hex");
  const rows = await queryJson(
    "SELECT token_hash, idle_expires_at, absolute_expires_at, revoked_at FROM pilot_sessions WHERE token_hash = $1",
    [hash],
  );
  assert.equal(rows.length, 1, "exactly one session must exist for this cookie");
  return rows[0];
}

/** Split a Set-Cookie into { name, value, attrs: Map<lowercased, value|true> }. */
function parseCookie(raw) {
  const [pair, ...rest] = raw.split(";");
  const eq = pair.indexOf("=");
  const attrs = new Map();
  for (const a of rest) {
    const t = a.trim();
    const i = t.indexOf("=");
    if (i === -1) attrs.set(t.toLowerCase(), true);
    else attrs.set(t.slice(0, i).toLowerCase(), t.slice(i + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

// ── minting ────────────────────────────────────────────────────────────────────────────────────

test("minting is admin/ops only, and refusals are identical", async () => {
  for (const role of ["learner", "teacher", "scholar", "admin", "ops"]) {
    await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `mint as ${role}`,
      probeFor: () => ({
        path: "/v1/pilot/invitations",
        method: "POST",
        role,
        body: { learnerId },
      }),
      // token/invitationId/inviteUrl/expiresAt are all per-call.
      normalize: (b) =>
        b && typeof b === "object" && b.token
          ? { ...b, token: "<T>", invitationId: "<ID>", inviteUrl: "<URL>", expiresAt: "<TIME>" }
          : b,
    });
  }
});

test("the minted body has the right keys, alphabetically, and the token is shown ONCE", async () => {
  const res = await mint(shell.baseUrl, { learnerId });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body), [
    "expiresAt",
    "invitationId",
    "inviteUrl",
    "learnerId",
    "token",
  ], '"invitationId" sorts before "inviteUrl" — at index 5 it is a vs e');

  // Only the HASH is stored: a leaked row must not be replayable into a session.
  const rows = await queryJson("SELECT token_hash FROM pilot_invitations WHERE id = $1", [
    res.body.invitationId,
  ]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, res.body.token, "the RAW token must never be stored");
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/, "stored value must be a SHA-256 hex digest");
});

test("a non-learner target is refused, and a missing one is 404", async () => {
  await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "mint for a non-learner",
    probeFor: () => ({
      path: "/v1/pilot/invitations",
      method: "POST",
      role: "admin",
      body: { learnerId: staffId },
    }),
    normalize: (b) => b,
  });
  await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "mint for a nonexistent user",
    probeFor: () => ({
      path: "/v1/pilot/invitations",
      method: "POST",
      role: "admin",
      body: { learnerId: "user-does-not-exist" },
    }),
    normalize: (b) => b,
  });
});

test("ttlHours is clamped to [1, 720] — no immortal invitations", async () => {
  for (const [ttlHours, expectHours] of [[0, 1], [-5, 1], [99999, 720], [24, 24]]) {
    const res = await mint(shell.baseUrl, { learnerId, ttlHours });
    assert.equal(res.status, 200, res.text);
    const hours = (Date.parse(res.body.expiresAt) - Date.now()) / 3600000;
    assert.ok(
      Math.abs(hours - expectHours) < 0.1,
      `ttlHours=${ttlHours} should clamp to ${expectHours}h, got ${hours.toFixed(2)}h`,
    );
  }
});

// ── bootstrap ──────────────────────────────────────────────────────────────────────────────────

test("bootstrap sets a cookie with EVERY __Host- attribute the browser requires", async () => {
  const minted = await mint(api.baseUrl, { learnerId });
  const res = await boot(shell.baseUrl, minted.body.token);
  assert.equal(res.status, 200, res.text);

  const raw = res.headers.getSetCookie().find((c) => c.startsWith("__Host-qrai-pilot="));
  assert.ok(raw, "bootstrap must set the pilot cookie");
  const { name, value, attrs } = parseCookie(raw);

  assert.equal(name, "__Host-qrai-pilot");
  assert.ok(value.length > 0, "an empty session token would authenticate nobody");
  // Each one asserted separately: a substring match on the whole header passes while a single
  // attribute is missing, and a missing attribute is invisible until a learner cannot stay signed in.
  assert.equal(attrs.get("secure"), true, "__Host- REQUIRES Secure; without it the browser drops it");
  assert.equal(attrs.get("path"), "/", "__Host- REQUIRES Path=/");
  assert.equal(attrs.has("domain"), false, "__Host- FORBIDS Domain");
  assert.equal(attrs.get("httponly"), true, "without HttpOnly the token is readable by script");
  assert.equal(attrs.get("samesite"), "Strict");
  assert.equal(attrs.get("max-age"), "28800", "8 hours, matching idle_expires_at");
});

test("the bootstrap cookie is byte-identical to Rust's, attribute for attribute", async () => {
  const a = await mint(api.baseUrl, { learnerId });
  const b = await mint(api.baseUrl, { learnerId });
  const fromShell = await boot(shell.baseUrl, a.body.token);
  const fromRust = await boot(api.baseUrl, b.body.token);

  const strip = (res) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-qrai-pilot="))
      .replace(/^__Host-qrai-pilot=[^;]*/, "__Host-qrai-pilot=<TOKEN>");
  assert.equal(strip(fromShell), strip(fromRust));
});

test("bootstrap requires an allowed Origin, before it even looks at the token", async () => {
  const minted = await mint(api.baseUrl, { learnerId });
  for (const headers of [{}, { origin: "" }, { origin: "https://evil.example" }]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `bootstrap origin ${JSON.stringify(headers)}`,
      probeFor: () => ({
        path: "/v1/pilot/session/bootstrap",
        method: "POST",
        tenant: null,
        headers,
        body: { token: minted.body.token },
      }),
      normalize: (b) => b,
    });
    assert.equal(s.status, 403);
  }
  // …and the token is still unconsumed, so a legitimate redemption still works.
  const ok = await boot(shell.baseUrl, minted.body.token);
  assert.equal(ok.status, 200, "a refused Origin must not burn the invitation");
});

test("an invitation is SINGLE USE — the second redemption is 401", async () => {
  const minted = await mint(api.baseUrl, { learnerId });
  assert.equal((await boot(shell.baseUrl, minted.body.token)).status, 200);

  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "redeem a consumed invitation",
    probeFor: () => ({
      path: "/v1/pilot/session/bootstrap",
      method: "POST",
      tenant: null,
      headers: { origin: ORIGIN },
      body: { token: minted.body.token },
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 401, "a consumed invitation must not mint a second session");
});

test("an unknown token is 401 — the same answer as consumed and expired", async () => {
  const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
    name: "bootstrap with an unknown token",
    probeFor: () => ({
      path: "/v1/pilot/session/bootstrap",
      method: "POST",
      tenant: null,
      headers: { origin: ORIGIN },
      body: { token: "00000000-0000-0000-0000-000000000000" },
    }),
    normalize: (b) => b,
  });
  assert.equal(s.status, 401, "distinguishing unknown from consumed leaks which tokens existed");
});

test("bootstrap stores only the session HASH and sets both expiries", async () => {
  const minted = await mint(api.baseUrl, { learnerId });
  const res = await boot(shell.baseUrl, minted.body.token);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), [
    "csrfToken",
    "displayName",
    "role",
    "tenantId",
    "userId",
  ]);
  assert.equal(res.body.role, "learner");

  const sessionToken = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-qrai-pilot="))
    .split(";")[0]
    .slice("__Host-qrai-pilot=".length);
  const row = await sessionFor(sessionToken);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/, "only the digest may be stored");
  const idleH = (row.idle_expires_at.valueOf() - Date.now()) / 3600000;
  const absH = (row.absolute_expires_at.valueOf() - Date.now()) / 3600000;
  assert.ok(Math.abs(idleH - 8) < 0.1, `idle should be ~8h, got ${idleH.toFixed(2)}`);
  assert.ok(Math.abs(absH - 24) < 0.1, `absolute should be ~24h, got ${absH.toFixed(2)}`);
});

// ── logout ─────────────────────────────────────────────────────────────────────────────────────

test("logout clears the cookie identically, with or without a session", async () => {
  const minted = await mint(api.baseUrl, { learnerId });
  const booted = await boot(shell.baseUrl, minted.body.token);
  const cookie = booted.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-qrai-pilot="))
    .split(";")[0];

  for (const headers of [{ cookie }, {}, { cookie: "__Host-qrai-pilot=nonsense" }]) {
    const { shell: s } = await assertABMutating(shell.baseUrl, api.baseUrl, {
      name: `logout with ${JSON.stringify(headers)}`,
      probeFor: () => ({
        path: "/v1/pilot/session/logout",
        method: "POST",
        tenant: null,
        headers,
      }),
      normalize: (b) => b,
    });
    // Always 200. A 401 for an unknown cookie tells a caller that a stolen cookie was already
    // revoked, and logout must be idempotent for a client retrying on a flaky network.
    assert.equal(s.status, 200);
    assert.deepEqual(s.body, { status: "logged_out" });

    const cleared = s.headers.getSetCookie().find((c) => c.startsWith("__Host-qrai-pilot="));
    const { value, attrs } = parseCookie(cleared);
    assert.equal(value, "", "the clearing cookie must have an empty value");
    assert.equal(attrs.get("max-age"), "0");
    assert.ok(attrs.has("expires"), "BOTH Max-Age=0 and a past Expires — old browsers honour one");
    assert.equal(attrs.get("secure"), true, "the clearing cookie is still __Host- and still needs Secure");
    assert.equal(attrs.get("path"), "/");
  }
});

test("logout actually REVOKES the session — the cookie stops working afterwards", async () => {
  const minted = await mint(api.baseUrl, { learnerId });
  const booted = await boot(shell.baseUrl, minted.body.token);
  const cookie = booted.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-qrai-pilot="))
    .split(";")[0];

  // Works before.
  assert.equal(
    (await request(shell.baseUrl, "/v1/learner/progress", { tenant: null, headers: { cookie } })).status,
    200,
  );

  const out = await request(shell.baseUrl, "/v1/pilot/session/logout", {
    method: "POST",
    tenant: null,
    headers: { cookie },
  });
  assert.equal(out.status, 200);

  // A 200 from logout proves nothing on its own — the revocation is the observable effect.
  const after = await request(shell.baseUrl, "/v1/learner/progress", {
    tenant: null,
    headers: { cookie },
  });
  assert.equal(after.status, 401, "the session must not survive its own logout");

  const row = await sessionFor(cookie.slice("__Host-qrai-pilot=".length));
  assert.ok(row.revoked_at, "revoked_at must be set, not merely implied by a 200");
});
