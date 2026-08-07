import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  issueRealtimeTicket,
  signTicketPayload,
  ticketPayload,
  validateRealtimeTicket,
  verifyRealtimeTicket,
} from "../../server/src/lib/ticket.mjs";

/**
 * N1 — the Node half of the cross-language ticket vectors.
 * specs/node-backend-port/plan.md §5
 *
 * The same file is asserted by `services/shared-ticket/src/lib.rs`'s `ticket_vectors` module. Both
 * halves agreeing is what lets a Node platform-api mint tickets the UNCHANGED Rust gateway accepts,
 * which is the whole reason Phase 7 can proceed route-by-route instead of as a flag day.
 *
 * Hermetic: no database, no binary, no network.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../specs/node-backend-port/fixtures/ticket-vectors.json"), "utf8"),
);

test("Node reproduces every committed vector byte-for-byte", () => {
  assert.ok(fixture.vectors.length > 0, "the vector file must not be empty");
  for (const v of fixture.vectors) {
    assert.equal(
      issueRealtimeTicket({ ...v, expiresAtUnixSeconds: BigInt(v.expiresAtUnixSeconds) }, v.secret),
      v.expectedTicket,
      `vector '${v.name}' drifted — the wire format changed, which is a TWO-SERVICE change`,
    );
  }
});

test("the vector count is pinned", () => {
  // A truncated or partially-written file would otherwise silently reduce coverage to zero while
  // both language suites still reported green.
  assert.equal(fixture.vectorCount, fixture.vectors.length);
});

test("the committed vectors cover the cases most likely to diverge across languages", () => {
  // Not decoration: each of these is a real encoding difference between Rust and JS, and a vector
  // set of only ASCII happy paths would prove almost nothing.
  const names = new Set(fixture.vectors.map((v) => v.name));
  for (const required of ["unicode-tenant", "empty-secret", "max-u64-expiry", "external-asr-false"]) {
    assert.ok(names.has(required), `missing the '${required}' vector`);
  }
  // The expiry is a STRING in the fixture. u64::MAX does not survive JSON.parse as a Number
  // (18446744073709551615 -> 18446744073709552000), which this vector is what caught.
  const big = fixture.vectors.find((v) => v.name === "max-u64-expiry");
  assert.equal(typeof big.expiresAtUnixSeconds, "string", "u64 must not be a JSON number");
  assert.equal(BigInt(big.expiresAtUnixSeconds), 18446744073709551615n);
  // Demonstrate the loss rather than assert it against a literal: `18446744073709551615` written in
  // JS SOURCE is already the imprecise double 18446744073709552000, so comparing Number() to the
  // literal compares two equally-wrong values and passes. Round-tripping through BigInt shows it.
  assert.notEqual(
    BigInt(Number(big.expiresAtUnixSeconds)),
    BigInt(big.expiresAtUnixSeconds),
    "u64::MAX must NOT survive a Number round-trip — that is why this field is a string",
  );
});

// --- the failures that matter: minting something Rust cannot parse ---

test("a field containing the separator is REFUSED at mint time", () => {
  // The format is dot-delimited with no escaping, so an id containing "." shifts every later field.
  // Rust cannot construct one by accident; JavaScript can, and the far side would silently read a
  // different tenant.
  for (const bad of [
    { tenantId: "a.b" },
    { sessionId: "s.1" },
    { learnerId: "l.1" },
    { nonce: "n.1" },
    { audioRetention: "dis.card" },
  ]) {
    assert.throws(
      () => issueRealtimeTicket({ ...validFields(), ...bad }, "secret"),
      /must not contain/,
      `${Object.keys(bad)[0]} with a dot must be refused`,
    );
  }
});

test("null / undefined / empty fields are REFUSED, not stringified", () => {
  // `${null}` is "null" — a perfectly valid-looking ticket field that validates on the far side.
  // This is the ticket-format cousin of the `undefined === undefined` ownership bypass (§2.3).
  for (const bad of [
    { tenantId: null },
    { tenantId: undefined },
    { tenantId: "" },
    { learnerId: "   " },
    // An omitted retention would render as "undefined", pass the Rust gateway's non-blank check,
    // reach ml-inference, match none of the three known values, and be treated as "discard" — the
    // exact silent downgrade this field exists to prevent.
    { audioRetention: undefined },
    { audioRetention: "" },
  ]) {
    assert.throws(() => issueRealtimeTicket({ ...validFields(), ...bad }, "secret"), TypeError);
  }
});

test("a truthy non-boolean consent flag is REFUSED", () => {
  // `externalAsrProcessing: "false"` is truthy in JS. Serialized naively it would render as the
  // string "false" and happen to be right; `"yes"` would render as "yes" and Rust's
  // `parse::<bool>()` would reject the ticket at the gateway — after the learner had already been
  // told the session started. Refuse at mint.
  for (const bad of ["true", "yes", 1, 0, null]) {
    assert.throws(
      () => issueRealtimeTicket({ ...validFields(), externalAsrProcessing: bad }, "secret"),
      /must be a boolean/,
    );
  }
});

test("a non-integer or negative expiry is REFUSED", () => {
  for (const bad of [1.5, -1, Number.MAX_SAFE_INTEGER + 2, "2000", NaN]) {
    assert.throws(
      () => issueRealtimeTicket({ ...validFields(), expiresAtUnixSeconds: bad }, "secret"),
      TypeError,
    );
  }
});

// --- signature behaviour ---

test("verify accepts a freshly minted ticket and REJECTS a tampered one", () => {
  const secret = "verify-secret";
  const ticket = issueRealtimeTicket(validFields(), secret);
  assert.equal(verifyRealtimeTicket(ticket, secret), true);

  const parts = ticket.split(".");
  const tamperedTenant = [...parts];
  tamperedTenant[2] = "attacker-tenant";
  assert.equal(verifyRealtimeTicket(tamperedTenant.join("."), secret), false, "tenant swap");

  const tamperedSig = [...parts];
  tamperedSig[8] = tamperedSig[8].replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  assert.equal(verifyRealtimeTicket(tamperedSig.join("."), secret), false, "signature flip");

  // Upgrading your own retention is the attack this field invites: rewrite "discard" into
  // "training-opt-in" and a recording is kept forever. It is inside the signed payload, so it
  // cannot be edited without the secret.
  const tamperedRetention = [...parts];
  tamperedRetention[5] = "training-opt-in";
  assert.equal(verifyRealtimeTicket(tamperedRetention.join("."), secret), false, "retention swap");

  assert.equal(verifyRealtimeTicket(ticket, "wrong-secret"), false, "wrong secret");
  assert.equal(verifyRealtimeTicket("rt_v9." + parts.slice(1).join("."), secret), false, "version");
  assert.equal(verifyRealtimeTicket(parts.slice(0, 8).join("."), secret), false, "truncated");
  // A v1 ticket, from a platform-api that has not been deployed yet.
  assert.equal(
    verifyRealtimeTicket("rt_v1.s.t.l.false.2000.n." + parts[8], secret),
    false,
    "a pre-retention v1 ticket",
  );
});

test("claims validation binds the session, expiry, boolean, and unsigned-u64 domain", () => {
  const secret = "claims-secret";
  const ticket = issueRealtimeTicket(validFields(), secret);
  assert.deepEqual(validateRealtimeTicket("session-1", ticket, secret, 1_999), {
    sessionId: "session-1",
    tenantId: "tenant-1",
    learnerId: "learner-1",
    externalAsrProcessing: true,
    audioRetention: "discard",
    expiresAtUnixSeconds: 2_000n,
    nonce: "nonce-1",
  });
  assert.equal(validateRealtimeTicket("another-session", ticket, secret, 1_999), null);
  assert.equal(validateRealtimeTicket("session-1", ticket, secret, 2_000), null);
  assert.equal(validateRealtimeTicket("session-1", ticket, "wrong-secret", 1_999), null);

  for (const payload of [
    "session-1.tenant-1.learner-1.TRUE.discard.2000.nonce-1",
    "session-1.tenant-1.learner-1.true.discard.18446744073709551616.nonce-1",
  ]) {
    const malformed = `rt_v2.${payload}.${signTicketPayload(payload, secret)}`;
    assert.equal(validateRealtimeTicket("session-1", malformed, secret, 1_999), null);
  }
});

test("the payload is exactly the documented format", () => {
  // Pinned separately from the HMAC so a change to field ORDER is named, not just observed as a
  // different hex digest.
  assert.equal(
    ticketPayload({
      sessionId: "s",
      tenantId: "t",
      learnerId: "l",
      externalAsrProcessing: false,
      audioRetention: "teacher-review",
      expiresAtUnixSeconds: 7,
      nonce: "n",
    }),
    "s.t.l.false.teacher-review.7.n",
  );
  assert.equal(signTicketPayload("s.t.l.false.7.n", "k").length, 64, "lowercase hex sha256");
  assert.match(signTicketPayload("s.t.l.false.7.n", "k"), /^[0-9a-f]{64}$/);
});

test("the committed vectors exercise every retention value the database allows", () => {
  // Mirrors the Rust half. `audioRetention` is the only payload field with a closed set, and the
  // point of carrying it is that the three values arrive DISTINGUISHABLY — vectors that all said
  // "discard" would pin the format without pinning that.
  const covered = new Set(fixture.vectors.map((v) => v.audioRetention));
  assert.deepEqual(
    [...covered].sort(),
    ["discard", "teacher-review", "training-opt-in"],
    "the vector set must exercise every value infra/migrations/0001_core_schema.sql permits",
  );
});

function validFields() {
  return {
    sessionId: "session-1",
    tenantId: "tenant-1",
    learnerId: "learner-1",
    externalAsrProcessing: true,
    audioRetention: "discard",
    expiresAtUnixSeconds: 2000,
    nonce: "nonce-1",
  };
}
