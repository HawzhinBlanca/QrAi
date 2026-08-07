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

import { ROUTES } from "../../server/src/routes/index.mjs";
import { ROLE_USER_IDS, TENANT, request, startApi, startShell, withDb } from "./lib/harness.mjs";

/**
 * Every route this matrix covers, served by the shell rather than proxied.
 *
 * Derive from the executable registry. A hand-copied list here would let this file silently proxy
 * an omitted route to Rust and call that response the Node column.
 */
const PORTED = ROUTES.filter((route) => route.ownerGate === undefined).map((route) => route.key).join(",");

let api;
let shell;
let matrixSessionId;
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

  // This route looks up the session BEFORE its ownership gate. Create a declared fixture through
  // the Rust oracle so denied roles exercise that gate instead of receiving a fixture-dependent 404.
  const created = await request(rustUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    body: {
      learnerId: "learner-1",
      quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
      sourceChecksum: "authz-matrix-declared-fixture",
      language: "ar",
      consent: {
        recordingConsent: true,
        audioRetention: "discard",
        anonymizedLearning: false,
        externalAsrProcessing: false,
        guardianApproved: false,
        consentVersion: "pilot-v1",
      },
    },
  });
  assert.equal(created.status, 200, `could not create the authorization fixture: ${created.text}`);
  matrixSessionId = created.body.id;

  // Point the shell at the binary rather than at `api.baseUrl`: under PARITY_THROUGH_SHELL that would
  // chain shell -> shell -> rust, and "the shell" would be measuring another copy of itself.
  shell = await startShell({ upstream: rustUrl, env: { NODE_API_PORTED: PORTED } });
});

after(async () => {
  try {
    if (matrixSessionId) {
      await withDb(async (client) => {
        const { rows } = await client.query(
          "SELECT consent_record_id, audit_event_id FROM recitation_sessions WHERE id = $1",
          [matrixSessionId],
        );
        if (rows[0]) {
          await client.query("DELETE FROM recitation_sessions WHERE id = $1", [matrixSessionId]);
          await client.query("DELETE FROM consent_records WHERE id = $1", [rows[0].consent_record_id]);
          await client.query("DELETE FROM audit_events WHERE id = $1", [rows[0].audit_event_id]);
        }
      });
    }
  } finally {
    await shell?.stop();
    await api?.stop();
  }
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
  {
    // ADR-0038 target addition. The Rust strangler baseline does not own this operation; asserting
    // 403 against its unknown-route 404 would falsely describe the old service as an implementation.
    key: "GET /v1/learner/recitation-sessions",
    path: "/v1/learner/recitation-sessions",
    allow: ["learner"],
    nodeOnly: true,
  },
  { key: "GET /v1/recitation-sessions", path: "/v1/recitation-sessions", allow: ["teacher", "admin", "ops"] },
  { key: "GET /v1/learners/active", path: "/v1/learners/active", allow: ["teacher", "admin", "ops"] },
  {
    // This handler intentionally resolves the session before checking ownership. Use the declared
    // learner-1 fixture so the matrix reaches the role/ownership gate on both implementations. Scholar
    // stays excluded: reading a tenant review queue does not grant access to one learner's feedback.
    key: "GET /v1/recitation-sessions/{id}/tajweed-findings",
    path: () => `/v1/recitation-sessions/${matrixSessionId}/tajweed-findings`,
    allow: ["learner", "teacher", "admin", "ops"],
  },
  // The next two id-scoped reads use an id that does not exist ON PURPOSE. The role gate runs BEFORE the
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
  {
    // ADR-0037. Scholar is deliberately ABSENT even though a scholar can read the finding queue
    // itself: this is a child's recorded voice, and only the roles that can record a decision about
    // the finding need to hear it. That asymmetry is the reason this row is worth its own line —
    // copying the list from `GET /v1/tajweed-findings` would have been the natural mistake.
    key: "GET /v1/tajweed-findings/{id}/audio",
    path: "/v1/tajweed-findings/no-such-finding/audio",
    allow: ["teacher", "admin", "ops"],
  },
];

for (const row of GET_MATRIX) {
  test(`${row.key} — absolute role matrix, each implementation on its own`, async () => {
    const path = typeof row.path === "function" ? row.path() : row.path;
    const targets = row.nodeOnly
      ? implementations().filter(([implementation]) => implementation === "shell")
      : implementations();
    for (const role of ROLES) {
      const allowed = row.allow.includes(role);
      for (const [impl, base] of targets) {
        const res = await request(base, path, { role });
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
 * ── THE CALLER IS IDENTIFIED BEFORE THE BODY IS READ ────────────────────────────────────────────
 *
 * This started as a pin on a divergence and is now an assertion that it is gone. Keeping the history
 * because the measurement is the point:
 *
 *   before   rust  422  Failed to deserialize the JSON body ... missing field `learnerId`
 *   after    rust  401  {"error":"missing or invalid authorization"}
 *
 * In Axum a `Json<T>` argument is an EXTRACTOR — it runs before the handler function body, where
 * `resolve_actor` and `require_any` live. So every Rust handler with a typed body answered the
 * request schema first and checked the caller second. With **no credentials at all**,
 * `POST /v1/pilot/invitations` named its own required field. Sixteen routes, measured.
 *
 * The first version of this file recorded that as a six-route divergence, which UNDERSTATED it twice
 * over. It is not six routes but sixteen, and the caller need not merely be unauthorized — they need
 * not be authenticated. The four ML-proxy routes hid it behind an untyped `serde_json::Value` body:
 * `{}` deserializes fine, so they looked correct until probed with malformed JSON. A test whose
 * input can only produce one answer proves nothing, which is why both bodies are sent below.
 *
 * Fixed in Rust by taking `Result<Json<T>, JsonRejection>` — an extractor that cannot fail — and
 * unwrapping it after the caller checks. Authorized callers' body errors are byte-identical:
 * 42 responses across 422/400/415 captured before and after, diffed, no change.
 *
 * What this asserts is the PROPERTY, not the port: a caller who fails identification must be refused
 * without learning anything about the body they sent, on BOTH implementations.
 */
const CALLER_CHECKED_FIRST = [
  // Role-gated: a wrong-role caller must be refused before the body is parsed.
  { key: "POST /v1/auth/token", path: "/v1/auth/token", denied: "learner" },
  { key: "POST /v1/pilot/invitations", path: "/v1/pilot/invitations", denied: "learner" },
  { key: "POST /v1/agent-runs", path: "/v1/agent-runs", denied: "learner" },
  { key: "POST /v1/scholar-approvals", path: "/v1/scholar-approvals", denied: "learner" },
  { key: "POST /v1/teacher-reviews", path: "/v1/teacher-reviews", denied: "learner" },
  { key: "POST /v1/realtime-session-tickets", path: "/v1/realtime-session-tickets", denied: "scholar" },
  // Authentication-only: no role gate, but an ANONYMOUS caller must still learn nothing.
  { key: "POST /v1/learner/progress", path: "/v1/learner/progress" },
  { key: "POST /v1/recitation-sessions", path: "/v1/recitation-sessions" },
  { key: "POST /v1/recitation-sessions/{id}/alignments", path: "/v1/recitation-sessions/no-such/alignments" },
  { key: "POST /v1/privacy/export", path: "/v1/privacy/export" },
  { key: "POST /v1/privacy/delete", path: "/v1/privacy/delete" },
  // Untyped `serde_json::Value` bodies — the ones `{}` alone could not have caught.
  { key: "POST /v1/ml/alignments:predict", path: "/v1/ml/alignments:predict" },
  { key: "POST /v1/ml/tajweed-findings:predict", path: "/v1/ml/tajweed-findings:predict" },
  { key: "POST /v1/asr/transcribe", path: "/v1/asr/transcribe" },
  { key: "POST /v1/asr/force-align", path: "/v1/asr/force-align" },
  // No actor at all; the caller check is the ORIGIN allowlist, which is still a check on the caller.
  { key: "POST /v1/pilot/session/bootstrap", path: "/v1/pilot/session/bootstrap", anonymousStatus: 403 },
];

/**
 * Two shapes of bad body, deliberately.
 *
 * `{}` is valid JSON that fails a TYPED schema — and silently succeeds against an untyped
 * `serde_json::Value`, which is exactly how the ML routes looked innocent. `{` fails everywhere.
 * Sending only the first would have reproduced the original mis-measurement.
 */
const BAD_BODIES = [
  ["valid JSON, wrong shape", "{}"],
  ["malformed JSON", "{"],
];

const SCHEMA_LEAK = /deserialize|missing field|invalid type|Failed to parse/i;

/** Raw POST, bypassing `request()`'s JSON encoding so a malformed body stays malformed. */
async function rawPost(base, path, identity) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...identity },
    body: identity.__body,
  });
  return { status: res.status, text: await res.text() };
}

for (const row of CALLER_CHECKED_FIRST) {
  test(`${row.key} — an ANONYMOUS caller is refused without being told the body shape`, async () => {
    const expected = row.anonymousStatus ?? 401;
    for (const [label, raw] of BAD_BODIES) {
      for (const [impl, base] of implementations()) {
        const res = await rawPost(base, row.path, { __body: raw });
        assert.equal(
          res.status,
          expected,
          `${impl}: ${row.key} with ${label} and NO credentials answered ${res.status}, not ${expected}. ` +
            "The caller check must run before the body is parsed.",
        );
        assert.doesNotMatch(
          res.text,
          SCHEMA_LEAK,
          `${impl}: ${row.key} described the request body to a caller it had not identified — ` +
            `${JSON.stringify(res.text).slice(0, 120)}`,
        );
      }
    }
  });
}

for (const row of CALLER_CHECKED_FIRST.filter((r) => r.denied)) {
  test(`${row.key} — a WRONG-ROLE caller is refused without being told the body shape`, async () => {
    for (const [label, raw] of BAD_BODIES) {
      for (const [impl, base] of implementations()) {
        const res = await rawPost(base, row.path, {
          __body: raw,
          "x-user-id": ROLE_USER_IDS[row.denied],
          "x-user-role": row.denied,
          "x-tenant-id": TENANT,
        });
        assert.equal(
          res.status,
          403,
          `${impl}: ${row.key} as ${row.denied} with ${label} answered ${res.status}, not 403. ` +
            "Authorization must run before the body is parsed.",
        );
        assert.doesNotMatch(
          res.text,
          SCHEMA_LEAK,
          `${impl}: ${row.key} described the request body to an unauthorized ${row.denied}`,
        );
      }
    }
  });
}

/**
 * The premise both tests above depend on: those bodies must actually be REJECTED once a caller gets
 * past the gate. If they were somehow acceptable, every assertion above would pass while proving
 * nothing about ordering at all — the requests would simply be succeeding.
 */
test("the bodies used above really are rejected once the caller is authorized", async () => {
  for (const [label, raw] of BAD_BODIES) {
    const res = await rawPost(rustUrl, "/v1/pilot/invitations", {
      __body: raw,
      "x-user-id": ROLE_USER_IDS.admin,
      "x-user-role": "admin",
      "x-tenant-id": TENANT,
    });
    assert.ok(
      res.status === 400 || res.status === 422,
      `an ADMIN sending ${label} got ${res.status}; if this body is acceptable, the tests above are vacuous`,
    );
    assert.match(
      res.text,
      SCHEMA_LEAK,
      "an authorized caller must still get axum's own body error — this is the byte-compatibility half",
    );
  }
});

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
  for (const file of readdirSync("server/src/routes")) {
    if (!file.endsWith(".mjs") || file === "index.mjs") continue;
    const src = readFileSync(`server/src/routes/${file}`, "utf8");
    // `requireAnyRole(actor,` and `requireAnyRole(caller,` — the import line names neither.
    for (const m of src.matchAll(/requireAnyRole\((?:actor|caller),/g)) gated.push(`${file}:${m.index}`);
  }

  const covered = new Set([
    // Session findings uses only `requireSelfOrAny`, not `requireAnyRole`; it has the same absolute
    // matrix above but is deliberately excluded from this call-site count.
    ...GET_MATRIX.filter(
      (r) => r.key !== "GET /v1/recitation-sessions/{id}/tajweed-findings",
    ).map((r) => r.key),
    ...POST_MATRIX.map((r) => r.key),
    // Only the role-gated rows count here: the rest of CALLER_CHECKED_FIRST covers routes whose
    // sole caller check is authentication, which is not a `requireAnyRole` call site.
    ...CALLER_CHECKED_FIRST.filter((r) => r.denied).map((r) => r.key),
  ]);

  assert.equal(
    gated.length,
    covered.size,
    `server/src/routes has ${gated.length} requireAnyRole call sites but this matrix covers ` +
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
