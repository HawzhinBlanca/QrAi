/**
 * The authorization matrix, asserted ABSOLUTELY — against each implementation on its own.
 *
 *   NODE_API_PORTED="$(…PORTABLE…)" node --test tests/api-parity/authz-matrix.test.mjs
 *
 * ── Why this file is not another A/B ────────────────────────────────────────────────────────────
 * Every other file in this directory answers one question: "do the shell and Rust agree?" That is
 * the right question for a port, and it is structurally blind to exactly one thing — a change that
 * lands on BOTH sides. `assertAB` compares two answers to each other and to nothing else, so if the
 * two implementations become wrong together, ~200 assertions stay green.
 *
 * "Both sides" is not the far-fetched case it sounds like. The two implementations share a database,
 * a seed corpus, a role vocabulary and a set of `ActorRole` values. A migration, a revoked GRANT, an
 * RLS policy, a renamed role, or a seed change is ONE edit that both implementations read
 * identically — and the differ cannot see any of it. Neither can it see a rule transcribed wrongly
 * from Rust into Node and then "fixed" in Rust to match.
 *
 * So the expectations below are LITERALS. Nothing here is derived from a running server, from the
 * other implementation, or from the source it guards. Both implementations are measured against the
 * same written-down table, separately. That is the only shape of assertion that survives a
 * both-sides change.
 *
 * ── What is asserted, and what deliberately is not ──────────────────────────────────────────────
 * Denied  →  EXACTLY 403. There is one right answer and it is worth pinning.
 * Allowed →  NOT 403, NOT 401, and NOT 5xx. Not a fixed status: `GET /v1/eval-runs/{v}` is a 404
 *            when the corpus has no such row and a 200 when it does, and pinning either would make
 *            this a corpus fixture rather than an authorization test. "The gate let this role
 *            through and the handler did not fall over" is the whole property, and it is enough:
 *            403 is the only status the gate itself can produce.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test, { after, before } from "node:test";

import { TENANT, request, startApi, startShell } from "./lib/harness.mjs";

let api;
let shell;
/**
 * The url of the REAL Rust binary, which is not always `api.baseUrl`.
 *
 * Under `PARITY_THROUGH_SHELL=1` — the mode `scripts/verify.sh` uses for its ported pass — `startApi`
 * puts a Node shell IN FRONT of Rust and hands back the shell's url, exposing the binary as
 * `upstreamUrl`. Every other file here wants that, because they compare two paths through the stack.
 * This file is the one that must not have it: its whole claim is that each implementation is measured
 * SEPARATELY against a written-down table, and a handle labelled "rust" that is really Node makes that
 * claim false in exactly the mode the gate runs.
 *
 * Measured, not deduced — the first version of this file used `api.baseUrl`, passed when run directly,
 * and went red inside verify.sh with "Rust answered 403" because it was asking a Node shell.
 */
let rustUrl;

before(async () => {
  api = await startApi({});
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  // Point the shell at the binary rather than at `api.baseUrl`: under PARITY_THROUGH_SHELL that would
  // chain shell -> shell -> rust, and "the shell" would be measuring another copy of itself.
  shell = await startShell({ upstream: rustUrl });
});

after(async () => {
  await shell?.stop();
  await api?.stop();
});

/** The two implementations, each addressed directly. Read inside a test, after `before` has run. */
const implementations = () => [
  ["shell", shell.baseUrl],
  ["rust", rustUrl],
];

const ROLES = ["learner", "teacher", "scholar", "admin", "ops"];

/**
 * Every role-gated GET, with its allow-list written out by hand.
 *
 * Transcribed one at a time from the `requireAnyRole` call in each handler and checked against a
 * live probe of both implementations — not generated from either, which would reproduce whatever
 * they currently do and assert nothing. The lists are genuinely different from each other (scholar
 * reads agent runs and tajweed findings but not sessions; learner reads its own progress and its own
 * session but cannot list a tenant's sessions), and that variety is the reason a matrix beats
 * spot-checks: a copy-paste between two of these rows reads as correct.
 */
const GET_MATRIX = [
  { key: "GET /v1/agent-runs", path: "/v1/agent-runs", allow: ["teacher", "scholar", "admin", "ops"] },
  { key: "GET /v1/audit-events", path: "/v1/audit-events", allow: ["admin", "ops"] },
  { key: "GET /v1/eval-runs/{model_version}", path: "/v1/eval-runs/model-v0.3", allow: ["admin", "ops"] },
  { key: "GET /v1/tajweed-findings", path: "/v1/tajweed-findings", allow: ["teacher", "scholar", "admin", "ops"] },
  { key: "GET /v1/teacher-review-queue", path: "/v1/teacher-review-queue", allow: ["teacher", "admin", "ops"] },
  { key: "GET /v1/scholar-approvals", path: "/v1/scholar-approvals", allow: ["scholar", "teacher", "admin", "ops"] },
  { key: "GET /v1/learner/progress", path: "/v1/learner/progress", allow: ["learner", "teacher", "admin", "ops"] },
  {
    key: "GET /v1/learner/progress/weekly",
    path: "/v1/learner/progress/weekly",
    allow: ["learner", "teacher", "admin", "ops"],
  },
  { key: "GET /v1/recitation-sessions", path: "/v1/recitation-sessions", allow: ["teacher", "admin", "ops"] },
  { key: "GET /v1/learners/active", path: "/v1/learners/active", allow: ["teacher", "admin", "ops"] },
  // The two id-scoped reads use an id that does not exist ON PURPOSE. The role gate runs BEFORE the
  // row lookup, so a denied role is still 403 and an allowed one gets 404/200 — which means these
  // rows need no fixture and cannot rot when the seed corpus changes.
  {
    key: "GET /v1/recitation-sessions/{id}",
    path: "/v1/recitation-sessions/no-such-session",
    allow: ["learner", "teacher", "admin", "ops"],
  },
  {
    key: "GET /v1/recitation-sessions/{id}/alignments",
    path: "/v1/recitation-sessions/no-such-session/alignments",
    allow: ["teacher", "admin", "ops"],
  },
];

for (const row of GET_MATRIX) {
  test(`${row.key} — absolute role matrix, each implementation on its own`, async () => {
    for (const role of ROLES) {
      const allowed = row.allow.includes(role);
      for (const [impl, base] of implementations()) {
        const res = await request(base, row.path, { role });
        if (allowed) {
          assert.notEqual(
            res.status,
            403,
            `${impl} refused ${role} on ${row.key}, which the matrix allows (got 403)`,
          );
          assert.notEqual(res.status, 401, `${impl}: ${role} on ${row.key} was unauthenticated, not just refused`);
          assert.ok(
            res.status < 500,
            `${impl}: ${role} passed the gate on ${row.key} and the handler returned ${res.status}`,
          );
        } else {
          assert.equal(
            res.status,
            403,
            `${impl} let ${role} through on ${row.key} (got ${res.status}); the matrix denies it`,
          );
        }
      }
    }
  });
}

/**
 * The two POST routes whose valid body is small enough to state here. Same absolute matrix as the
 * GETs, and it reaches the role gate on BOTH implementations, which the invalid-body case below
 * does not.
 */
const POST_MATRIX = [
  {
    key: "POST /v1/auth/token",
    path: "/v1/auth/token",
    allow: ["admin", "ops"],
    body: { userId: "learner-1", role: "learner", tenantId: TENANT },
  },
  {
    key: "POST /v1/pilot/invitations",
    path: "/v1/pilot/invitations",
    allow: ["admin", "ops"],
    body: { learnerId: "learner-1" },
  },
];

for (const row of POST_MATRIX) {
  test(`${row.key} — absolute role matrix with a VALID body, each implementation on its own`, async () => {
    for (const role of ROLES) {
      const allowed = row.allow.includes(role);
      for (const [impl, base] of implementations()) {
        const res = await request(base, row.path, { method: "POST", role, body: row.body });
        if (allowed) {
          assert.notEqual(res.status, 403, `${impl} refused ${role} on ${row.key}, which the matrix allows`);
          assert.notEqual(
            res.status,
            422,
            `${impl}: the body this test sends is no longer valid for ${row.key}, so this row stopped ` +
              "testing the role gate and started testing deserialization. Fix the body, not the assertion.",
          );
          assert.ok(res.status < 500, `${impl}: ${role} on ${row.key} returned ${res.status}`);
        } else {
          assert.equal(
            res.status,
            403,
            `${impl} let ${role} through on ${row.key} (got ${res.status}); the matrix denies it`,
          );
        }
      }
    }
  });
}

/**
 * ── A MEASURED DIVERGENCE, pinned rather than quietly carried ───────────────────────────────────
 *
 * With an INVALID body, the two implementations refuse an unauthorized caller for different reasons
 * and with different statuses:
 *
 *   shell  403 {"error":"actor is not allowed to perform this action"}
 *   rust   422 Failed to deserialize the JSON body into the target type: missing field `learnerId`
 *
 * The cause is structural, not a transcription slip. In Axum a `Json<T>` argument is an EXTRACTOR:
 * it runs before the handler function body, and `actor.require_any(..)` lives inside that body. So
 * every Rust handler with a typed body validates before it authorizes. The Node port calls
 * `resolveActor` + `requireAnyRole` first and reads `req.body` afterwards, so it authorizes before
 * it validates.
 *
 * Neither behaviour is a bug on its own; the DIVERGENCE is, because the brief for this port is
 * strict wire compatibility. Two things make it worth pinning rather than silently repairing:
 *
 *  - The safer implementation is the one that diverges. Rust hands an unauthorized caller the field
 *    names of a request schema it has no right to submit. Making Node "match" would mean adding that
 *    disclosure to every privileged write, so this is a decision to take deliberately and in one
 *    direction, not a difference to paper over from whichever side is easier to edit.
 *  - It is exactly the cell no A/B probe visits. The suite sends valid bodies as authorized roles and
 *    invalid bodies as authorized roles; UNAUTHORIZED + INVALID is the combination nobody wrote, and
 *    it is where six privileged writes disagree.
 *
 * This test asserts what each side ACTUALLY does today, so the day either one changes — including
 * the day someone resolves the divergence — it says so out loud instead of drifting.
 */
const AUTHZ_BEFORE_BODY = [
  { key: "POST /v1/auth/token", path: "/v1/auth/token", denied: "learner" },
  { key: "POST /v1/pilot/invitations", path: "/v1/pilot/invitations", denied: "learner" },
  { key: "POST /v1/agent-runs", path: "/v1/agent-runs", denied: "learner" },
  { key: "POST /v1/scholar-approvals", path: "/v1/scholar-approvals", denied: "learner" },
  { key: "POST /v1/teacher-reviews", path: "/v1/teacher-reviews", denied: "learner" },
  { key: "POST /v1/realtime-session-tickets", path: "/v1/realtime-session-tickets", denied: "scholar" },
];

/** The route keys the shell is actually serving; anything else it proxies, so it answers as Rust. */
const PORTED = new Set(
  (process.env.NODE_API_PORTED ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

for (const row of AUTHZ_BEFORE_BODY) {
  test(`${row.key} — rust validates the body BEFORE authorizing; the shell does not`, async () => {
    const opts = { method: "POST", role: row.denied, body: {} };

    const rust = await request(rustUrl, row.path, opts);
    assert.equal(
      rust.status,
      422,
      `${row.key}: Rust answered ${rust.status} to an unauthorized caller with an invalid body. ` +
        "It has answered 422 (the Json<T> extractor rejecting before the handler runs). If this is " +
        "now 403 the ordering was changed in Rust — good, but update the shell and this test together.",
    );
    assert.match(
      rust.text,
      /Failed to deserialize the JSON body/,
      `${row.key}: Rust's 422 no longer carries the deserialization detail. That detail reaching an ` +
        "unauthorized caller is the reason this divergence is recorded; if it is gone, re-measure.",
    );

    if (!PORTED.has(row.key)) return; // proxied: the shell IS Rust here, so there is nothing of its own to assert

    const nodeShell = await request(shell.baseUrl, row.path, opts);
    assert.equal(
      nodeShell.status,
      403,
      `${row.key}: the shell answered ${nodeShell.status}. It authorizes before it reads the body, ` +
        "so an unauthorized caller with an invalid body gets 403.",
    );
    assert.doesNotMatch(
      nodeShell.text,
      /deserialize|missing field/i,
      `${row.key}: the shell's refusal now leaks body-schema detail to an unauthorized caller`,
    );

    assert.notEqual(
      nodeShell.status,
      rust.status,
      `${row.key}: shell and Rust now AGREE on this cell. The divergence this test records is ` +
        "resolved — delete this test and add the route to POST_MATRIX with a valid body.",
    );
  });
}

/**
 * The guard that keeps the table above honest.
 *
 * A matrix is only as good as its coverage, and the failure mode is silent: someone adds a
 * `requireAnyRole` to a new handler, no row here describes it, and the suite still reports green
 * across every route it happens to know about. Counting the call sites turns that into a red test.
 *
 * It counts rather than parses because a count cannot be satisfied by a wrong mapping: adding a gate
 * without adding a row fails, and so does deleting a gate without deleting its row.
 */
test("every role gate in the shell has a row in this matrix", () => {
  const gated = [];
  for (const file of readdirSync("services/node-api/routes")) {
    if (!file.endsWith(".mjs") || file === "index.mjs") continue;
    const src = readFileSync(`services/node-api/routes/${file}`, "utf8");
    // `requireAnyRole(actor,` and `requireAnyRole(caller,` — the import line names neither.
    for (const m of src.matchAll(/requireAnyRole\((?:actor|caller),/g)) gated.push(`${file}:${m.index}`);
  }

  const covered = new Set([
    ...GET_MATRIX.map((r) => r.key),
    ...POST_MATRIX.map((r) => r.key),
    ...AUTHZ_BEFORE_BODY.map((r) => r.key),
  ]);

  assert.equal(
    gated.length,
    covered.size,
    `services/node-api/routes has ${gated.length} requireAnyRole call sites but this matrix covers ` +
      `${covered.size} routes. A role gate with no row here is an authorization rule no absolute ` +
      `assertion checks — add it to GET_MATRIX or POST_MATRIX. Call sites: ${gated.join(", ")}`,
  );
});

/**
 * The premise the whole file rests on: an unknown role must not be treated as a known one.
 *
 * Every row above says "these roles yes, those roles no" over a CLOSED vocabulary of five. If an
 * unrecognised role string were mapped to some default instead of rejected, the matrix would still
 * pass while the vocabulary it enumerates had stopped being closed.
 */
test("an unknown role is refused outright, so the five-role vocabulary is closed", async () => {
  for (const [impl, base] of implementations()) {
    const res = await request(base, "/v1/audit-events", { role: "superadmin", userId: "admin-1" });
    assert.ok(
      res.status === 401 || res.status === 403,
      `${impl}: role "superadmin" got ${res.status}. An unknown role must be refused, not defaulted — ` +
        "otherwise every allow-list in this file enumerates a vocabulary that is not closed.",
    );
  }
});
