/**
 * N13a — the pilot-cookie authentication path: the Node shell against Rust.
 * specs/migration-completion/plan.md §2 · port of auth.rs:152-256
 *
 *   NODE_API_PORTED="GET /v1/learner/progress,POST /v1/learner/progress" \
 *     node --test tests/api-parity/pilot-auth-parity.test.mjs
 *
 * ── This is not a route. It is the credential path every ported route shares ─────────────────────
 * Until now `resolveActor` returned `{ delegate }` for any request carrying `__Host-qrai-pilot`, so
 * every cookie-bearing request was proxied to Rust no matter which routes were ported. That was the
 * safe default and it was deliberate. Porting it means the shell starts authenticating pilot
 * learners itself — which is why this suite exercises the credential path through ALREADY-PORTED
 * routes rather than through a route of its own, and why it probes the refusals harder than the
 * happy path.
 *
 * The session is always bootstrapped through RUST (that handler is not ported), so the cookie under
 * test is a real one minted by the authoritative implementation.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertAB } from "./lib/ab.mjs";
import { TENANT, queryJson, request, startApi, startShell } from "./lib/harness.mjs";

const ORIGIN = "http://localhost:5173";

/**
 * The routes this file is ABOUT, served by the shell rather than proxied to Rust.
 *
 * Taken from the `NODE_API_PORTED=…` line in the header above, which every parity file carried and
 * none of them set. A file run directly therefore got a shell that proxied everything, so its
 * "shell" side WAS Rust and a Node-only defect could not fail it — the configuration a person
 * actually uses proved the least. Only verify.sh's second pass set the variable, so the same file
 * meant two different things depending on who ran it.
 *
 * `startShell` unions this with the ambient value, so verify.sh's exhaustive pass still serves every
 * PORTABLE route.
 */
const PORTED = "GET /v1/learner/progress,POST /v1/learner/progress";

let api;
let shell;
/**
 * The RUST url, which is not `rustUrl`.
 *
 * Under `PARITY_THROUGH_SHELL=1` — the configuration in which this file's A/B is the only thing that
 * proves anything about the port — `startApi` puts a Node shell in front of the binary and returns
 * the SHELL as `baseUrl`, exposing Rust as `upstreamUrl`. Wiring `startShell({ upstream:
 * rustUrl })` and differing against `rustUrl` therefore put Node on BOTH sides of every
 * `assertAB`: a shell in front of a shell, compared with that inner shell. Identical code cannot
 * disagree with itself, so the probes passed by construction.
 *
 * Measured before this was fixed: a `NODE_ONLY_FIELD` added to Node's `listSurahs` response — a
 * divergence a byte comparison cannot miss — left `assertAB` GREEN in both verify.sh passes. What
 * caught it was a literal key-list assertion beside the probe, which is not a comparison at all.
 */
let rustUrl;

/**
 * Two REAL seeded learners, looked up rather than named.
 *
 * The first draft hardcoded `learner-2`, which does not exist in this corpus — three tests failed
 * while still PROXIED, which is exactly what writing the oracle first is for. A fabricated identity
 * makes a test that cannot pass; a fabricated identity that HAPPENED to exist would make one that
 * passes for the wrong reason.
 */
let learners;

before(async () => {
  api = await startApi({ env: { CORS_ALLOWED_ORIGINS: ORIGIN } });
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({ upstream: rustUrl, env: { NODE_API_PORTED: PORTED, CORS_ALLOWED_ORIGINS: ORIGIN } });
  const rows = await queryJson(
    "SELECT id FROM users WHERE tenant_id = $1 AND role = 'learner' ORDER BY id LIMIT 2",
    [TENANT],
  );
  assert.equal(rows.length, 2, "this suite needs two seeded learners in the pilot tenant");
  learners = rows.map((r) => r.id);
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

/** Mint an invitation and bootstrap a session THROUGH RUST. Returns { cookie, csrf, learnerId }. */
async function bootstrapSession(learnerId = learners[0]) {
  const minted = await request(rustUrl, "/v1/pilot/invitations", {
    method: "POST",
    role: "admin",
    body: { learnerId },
  });
  assert.equal(minted.status, 200, `minting an invitation failed: ${minted.text}`);
  const inviteToken = minted.body.token ?? minted.body.inviteToken;
  assert.ok(inviteToken, `no invite token in ${JSON.stringify(minted.body)}`);

  const booted = await request(rustUrl, "/v1/pilot/session/bootstrap", {
    method: "POST",
    tenant: null,
    headers: { origin: ORIGIN },
    body: { token: inviteToken },
  });
  assert.equal(booted.status, 200, `bootstrap failed: ${booted.text}`);
  const setCookie = booted.headers.getSetCookie().find((c) => c.startsWith("__Host-qrai-pilot="));
  assert.ok(setCookie, "bootstrap must set the pilot cookie");
  return { cookie: setCookie.split(";")[0], csrf: booted.body.csrfToken, learnerId };
}

const asPilot = (cookie, extra = {}) => ({
  tenant: null,
  headers: { cookie, ...extra },
});

test("a valid pilot cookie resolves to the learner, identically on both", async () => {
  const { cookie, learnerId } = await bootstrapSession();
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/v1/learner/progress",
    ...asPilot(cookie),
  });
  assert.equal(s.status, 200);
  assert.equal(s.body.learnerId, learnerId, "the cookie must resolve to the invited learner");
  assert.equal(s.body.tenantId, TENANT);
});

test("a cookie resolves the LEARNER role — it cannot reach a staff-only route", async () => {
  const { cookie } = await bootstrapSession();
  // A pilot session is always ActorRole::Learner. If the port defaulted to any other role this
  // would become a privilege escalation with a cookie anyone can obtain from an invitation.
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/v1/audit-events",
    ...asPilot(cookie),
  });
  assert.equal(s.status, 403, "a pilot learner must never read the audit log");
});

test("a garbage cookie value is refused, not crashed on", async () => {
  for (const value of ["__Host-qrai-pilot=nonsense", "__Host-qrai-pilot=", "__Host-qrai-pilot=%00"]) {
    const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
      path: "/v1/learner/progress",
      ...asPilot(value),
    });
    assert.ok(s.status === 401 || s.status === 400, `${value} -> ${s.status}, expected 401/400`);
  }
});

test("the pilot cookie is found among OTHER cookies, with and without spaces", async () => {
  const { cookie, learnerId } = await bootstrapSession();
  for (const header of [
    `theme=dark; ${cookie}; lang=ckb`,
    `theme=dark;${cookie};lang=ckb`,
    `${cookie}; theme=dark`,
  ]) {
    const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
      path: "/v1/learner/progress",
      ...asPilot(header),
    });
    assert.equal(s.status, 200, `cookie header "${header}" did not resolve`);
    assert.equal(s.body.learnerId, learnerId);
  }
});

test("a cookie whose NAME merely contains the prefix is not mistaken for it", async () => {
  // `x__Host-qrai-pilot=...` must not match. A naive `includes()` or a prefix search that ignores
  // the cookie boundary accepts it, and the value is attacker-chosen.
  const { cookie } = await bootstrapSession();
  const forged = `x${cookie}`;
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/v1/learner/progress",
    ...asPilot(forged),
  });
  assert.equal(s.status, 401, "a cookie named x__Host-qrai-pilot must not authenticate");
});

// ── mutating requests: Origin, then CSRF ───────────────────────────────────────────────────────

const postBody = { quality: 4, ayahRef: "2:1" };

test("a mutating request with NO Origin is 403 — before CSRF is even considered", async () => {
  const { cookie, csrf } = await bootstrapSession();
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/v1/learner/progress",
    method: "POST",
    body: postBody,
    ...asPilot(cookie, { "x-csrf-token": csrf }),
  });
  assert.equal(s.status, 403, "a correct CSRF token must not rescue a missing Origin");
});

test("a mutating request from a DISALLOWED Origin is 403", async () => {
  const { cookie, csrf } = await bootstrapSession();
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/v1/learner/progress",
    method: "POST",
    body: postBody,
    ...asPilot(cookie, { origin: "https://evil.example", "x-csrf-token": csrf }),
  });
  assert.equal(s.status, 403);
});

test("a mutating request with an allowed Origin but NO CSRF header is 401", async () => {
  const { cookie } = await bootstrapSession();
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/v1/learner/progress",
    method: "POST",
    body: postBody,
    ...asPilot(cookie, { origin: ORIGIN }),
  });
  assert.equal(s.status, 401);
});

test("a mutating request with the WRONG CSRF token is 401", async () => {
  const { cookie } = await bootstrapSession();
  const other = await bootstrapSession(learners[1]);
  for (const bad of ["", "nope", other.csrf]) {
    const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
      path: "/v1/learner/progress",
      method: "POST",
      body: postBody,
      ...asPilot(cookie, { origin: ORIGIN, "x-csrf-token": bad }),
    });
    assert.equal(s.status, 401, `CSRF "${bad}" must be refused`);
  }
});

test("a GET needs neither Origin nor CSRF — the checks are for MUTATING methods only", async () => {
  const { cookie } = await bootstrapSession();
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/v1/learner/progress",
    ...asPilot(cookie),
  });
  assert.equal(s.status, 200, "requiring CSRF on a GET would break every pilot page load");
});

test("a correct Origin AND CSRF succeeds", async () => {
  const { cookie, csrf } = await bootstrapSession();
  const res = await request(shell.baseUrl, "/v1/learner/progress", {
    method: "POST",
    body: postBody,
    ...asPilot(cookie, { origin: ORIGIN, "x-csrf-token": csrf }),
  });
  assert.equal(res.status, 200, `expected the write to land: ${res.text}`);
});

// ── the idle roll: PR #283's F2 fix, which must survive the port ────────────────────────────────

/**
 * The roll is the whole reason this path touches the database twice.
 *
 * `pilot_sessions` has FORCE ROW LEVEL SECURITY with a `tenant_id = app.current_tenant_id()`
 * policy, and the session LOOKUP deliberately goes through a SECURITY DEFINER function because
 * there is no tenant context at auth time. Running the UPDATE on the raw pool therefore matched
 * ZERO rows under the restricted role and said nothing: every request looked like it rolled the
 * session, and the session actually expired 8 hours after bootstrap regardless of activity.
 *
 * The observable difference between the fixed and broken versions is the TIMESTAMP MOVING. A
 * success assertion passes against both.
 *
 * ── Measured, three ways ────────────────────────────────────────────────────────────────────────
 * Moving the roll onto the raw pool alone turns SIX tests red — but only because the
 * `rowCount !== 1` assertion converts the zero-row UPDATE into a 401, which is loud. Removing that
 * assertion alone changes nothing observable: locally the role is `quran_ai_app`, the roll lands,
 * and the guard is simply never reached.
 *
 * Remove BOTH — which is exactly the combination that shipped — and **this test is the only one
 * that fails.** Not the 200s, not the identity, not the CSRF gates: just the timestamp refusing to
 * move. That is the whole argument for asserting an observable effect rather than a status code.
 */
test("using the session ROLLS its idle expiry, and the write is asserted", async () => {
  const { cookie, learnerId } = await bootstrapSession(learners[0]);

  const expiryOf = async () => {
    const [row] = await queryJson(
      `SELECT idle_expires_at FROM pilot_sessions
       WHERE learner_id = $2 AND tenant_id = $1
       ORDER BY last_seen_at DESC LIMIT 1`,
      [TENANT, learnerId],
    );
    return row?.idle_expires_at?.valueOf();
  };

  const before = await expiryOf();
  assert.ok(before, "the bootstrapped session must exist");

  // A second of wall clock, so `now + 8h` is measurably different from the bootstrap value.
  await new Promise((r) => setTimeout(r, 1100));

  const res = await request(shell.baseUrl, "/v1/learner/progress", asPilot(cookie));
  assert.equal(res.status, 200);

  const after = await expiryOf();
  assert.ok(
    after > before,
    `idle_expires_at did not move (${before} -> ${after}). The UPDATE either ran without tenant ` +
      "context and matched zero rows, or was skipped entirely — both look like success.",
  );
});

test("an expired session is 401 even though the cookie is otherwise valid", async () => {
  const { cookie, learnerId } = await bootstrapSession(learners[1]);
  // Expire it directly rather than waiting 8 hours. Tenant-scoped so RLS lets the update through.
  await queryJson(
    `UPDATE pilot_sessions SET idle_expires_at = now() - interval '1 minute'
     WHERE learner_id = $2 AND tenant_id = $1`,
    [TENANT, learnerId],
  );
  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/v1/learner/progress",
    ...asPilot(cookie),
  });
  assert.equal(s.status, 401, "an idle-expired session must not authenticate");
});

test("a bearer token WINS over a cookie when both are present", async () => {
  // Rust tries the Bearer path first (auth.rs:100) and only then the cookie. A port that checks the
  // cookie first would silently resolve a different identity for a request carrying both — which is
  // exactly what a browser sends when a staff user has a stale pilot cookie.
  const { cookie } = await bootstrapSession();
  const minted = await request(rustUrl, "/v1/auth/token", {
    method: "POST",
    role: "admin",
    body: { userId: learners[1], tenantId: TENANT, role: "learner" },
  });
  assert.equal(minted.status, 200, minted.text);

  const { shell: s } = await assertAB(shell.baseUrl, rustUrl, {
    path: "/v1/learner/progress",
    tenant: null,
    headers: { cookie, authorization: `Bearer ${minted.body.token}` },
  });
  assert.equal(s.status, 200);
  assert.equal(s.body.learnerId, learners[1], "the BEARER identity must win, not the cookie's");
});
