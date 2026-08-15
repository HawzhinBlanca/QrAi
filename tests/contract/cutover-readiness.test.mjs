import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MET,
  NEEDS_HUMAN,
  UNMET,
  checkAdr0022,
  checkOperationalProof,
  checkOracleCoverage,
  checkRollbackArtifact,
  checkSchemaValidation,
  checkSignOffRows,
  checkTrafficShare,
  coveredPairs,
  summarise,
} from "../../scripts/cutover-readiness.mjs";

/**
 * CU2 — specs/cutover/plan.md
 *
 * These do NOT assert the repo's current values. They assert each check CHANGES ITS VERDICT when its
 * input changes, because a checker that reads the right file and extracts the wrong thing looks
 * identical to a correct one until something moves. That is exactly how Phase 7's route parser
 * silently missed five chained registrations for a whole phase.
 *
 * Hermetic: synthetic inputs, no filesystem, no service — with one deliberate exception at the
 * bottom, the ADR-number uniqueness invariant, which can only be asserted against the real
 * docs/DECISIONS.md because the whole point is that the real file must not contain a collision.
 */

// --- traffic share ---

const nodeCanary = {
  webUpstream: "node-api:8082",
  gatewayUpstream: "http://node-api:8082",
  routeMode: "retained-canary",
  explicitRouteKeys: "",
  rustUpstream: "http://platform-api:8080",
};

test("traffic-share is UNMET while any required route is absent", () => {
  const r = checkTrafficShare(["GET /a"], ["GET /a", "POST /b"], nodeCanary);
  assert.equal(r.state, UNMET);
  assert.match(r.detail, /registers 1 of 2 required routes/);
  assert.match(r.detail, /1 missing/);
});

test("traffic-share flips to MET only on the exact required routes and paired Node topology", () => {
  const r = checkTrafficShare(["GET /a", "POST /b"], ["GET /a", "POST /b"], nodeCanary);
  assert.equal(r.state, MET);
  assert.match(r.detail, /registers 2 of 2 required routes/);
  assert.match(r.detail, /0 extra/);
  assert.match(r.detail, /topology is selected/);
});

test("traffic-share stays UNMET for transition extras or an unpaired gateway", () => {
  assert.equal(
    checkTrafficShare(["GET /a", "GET /transition"], ["GET /a"], nodeCanary).state,
    UNMET,
  );
  assert.equal(
    checkTrafficShare(["GET /a"], ["GET /a"], {
      ...nodeCanary,
      gatewayUpstream: "http://platform-api:8080",
    }).state,
    UNMET,
  );
});

// --- rollback artifact ---

test("rollback-artifact stays UNMET for generic or ephemeral image activity", () => {
  const none = checkRollbackArtifact([{ name: "ci.yml", text: "steps:\n  - run: bash scripts/verify.sh" }]);
  assert.equal(none.state, UNMET);

  for (const line of ["docker build .", "docker push ghcr.io/x", "uses: docker/build-push-action@v6"]) {
    const some = checkRollbackArtifact([{ name: "release.yml", text: `steps:\n  - run: ${line}` }]);
    assert.equal(some.state, UNMET, `"${line}" alone is not a rollback artifact`);
  }
});

test("rollback-artifact flips to MET only for durable publication plus no-build consumption", () => {
  const workflow = `
permissions:
  packages: write
steps:
  - uses: docker/login-action@v3
    with:
      registry: ghcr.io
  - run: node scripts/release-images.mjs
    env:
      RELEASE_IMAGE_DIGESTS_OUTPUT: /tmp/image-digests.json
  - uses: actions/upload-artifact@v4
`;
  const publisher = 'docker("buildx", "build", "--push", ".")';
  const overlay = 'build: !reset null\nimage: "${NODE_BACKEND_IMAGE:?repository@sha256 required}"';
  const deployment = "composeImageEnvironment candidate previous verifyRunningReleaseImages";
  const result = checkRollbackArtifact(
    [{ name: "release-image.yml", text: workflow }],
    publisher,
    overlay,
    deployment,
  );
  assert.equal(result.state, MET);
  assert.match(result.detail, /release-image\.yml/);
});

// --- ADR-0022 ---

test("adr-0022 reads the STATUS line, and flips only on Accepted", () => {
  const doc = (status) => `## ADR-0022 — artifacts\n**Date:** x · **Status:** ${status} · **Deciders:** y`;
  assert.equal(checkAdr0022(doc("Proposed")).state, UNMET);
  assert.equal(checkAdr0022(doc("Accepted")).state, MET);
  assert.equal(checkAdr0022(doc("Superseded")).state, UNMET);
  // A missing ADR must not read as satisfied.
  assert.equal(checkAdr0022("# Decisions\nnothing here").state, UNMET);
});

// --- readiness rows ---

test("operational-proof flips when P5.5 and P5.6 both close", () => {
  const open = "- [ ] P5.5 — prove rollback.\n- [ ] P5.6 — DR drill.";
  const half = "- [x] P5.5 — prove rollback.\n- [ ] P5.6 — DR drill.";
  const done = "- [x] P5.5 — prove rollback.\n- [x] P5.6 — DR drill.";
  assert.equal(checkOperationalProof(open).state, UNMET);
  assert.equal(checkOperationalProof(half).state, UNMET, "half done is not done");
  assert.equal(checkOperationalProof(done).state, MET);
});

// --- THE invariant: a signature is not something a script can satisfy ---

test("security-sign-off is NEEDS-HUMAN even when the rows are marked done", () => {
  // The whole point. If a row being ticked flipped this to MET, the checker would be laundering a
  // checkbox into a security sign-off — and someone could tick it without a reviewer ever looking.
  const open = "- [ ] P1.7 — reviewer signs.\n- [ ] P4.1 — approve threat model.";
  const ticked = "- [x] P1.7 — reviewer signs.\n- [x] P4.1 — approve threat model.";
  assert.equal(checkSignOffRows(open).state, NEEDS_HUMAN);
  assert.equal(checkSignOffRows(ticked).state, NEEDS_HUMAN, "a tick is not a signature");
  assert.match(checkSignOffRows(ticked).detail, /verify a REAL reviewer signed/);
});

test("NEEDS-HUMAN is never counted as met, in any combination", () => {
  const all = (state) => [{ id: "a", state }, { id: "b", state }];
  const s = summarise([...all(MET), { id: "sig", state: NEEDS_HUMAN }]);
  assert.equal(s.met, 2, "the signature must NOT be added to the met count");
  assert.equal(s.human, 1);
  assert.equal(s.unmet, 0);
  assert.equal(s.mechanicalComplete, true);
});

test("summarise exposes no field a caller could read as 'ready'", () => {
  // Defensive on purpose: `if (result.ready)` is how a rubber stamp gets written by accident.
  const s = summarise([{ id: "a", state: MET }, { id: "sig", state: NEEDS_HUMAN }]);
  assert.ok(!("ready" in s), "there must be no `ready` field");
  assert.ok(!("go" in s), "there must be no `go` field");
  assert.doesNotMatch(s.conclusion, /\bGO\b/, "the conclusion string must never contain GO");
  assert.match(s.conclusion, /signature\(s\) still required/);
});

test("the conclusion says NOT READY while anything mechanical is unmet", () => {
  const s = summarise([{ id: "a", state: UNMET }, { id: "sig", state: NEEDS_HUMAN }]);
  assert.match(s.conclusion, /^NOT READY/);
});

// --- coverage counting ---

test("coveredPairs matches a fixture's concrete id against the route TEMPLATE", () => {
  const rust = [
    { method: "GET", path: "/v1/recitation-sessions/{id}" },
    { method: "POST", path: "/v1/teacher-reviews" },
  ];
  const steps = [{ request: { method: "GET", path: "/v1/recitation-sessions/session-abc12345-1234-1234-1234-123456789012" } }];
  assert.equal(coveredPairs(rust, steps, ""), 1, "the concrete id must match {id}");
});

test("coveredPairs counts a parity test's template literal", () => {
  const rust = [{ method: "POST", path: "/v1/recitation-sessions/{id}/request-teacher-review" }];
  const parity = 'const path = `/v1/recitation-sessions/${sessionId}/request-teacher-review`;';
  assert.equal(coveredPairs(rust, [], parity), 1);
});

test("coveredPairs does NOT count a route nothing exercises", () => {
  // The number that matters is the uncovered one; a counter that over-reports would hide it.
  const rust = [{ method: "POST", path: "/v1/teacher-reviews" }];
  assert.equal(coveredPairs(rust, [], "some unrelated source text"), 0);
});

test("boundary-oracle-coverage is MET only at FULL coverage", () => {
  assert.equal(checkOracleCoverage(37, 38).state, UNMET, "one uncovered pair is still uncovered");
  assert.equal(checkOracleCoverage(38, 38).state, MET);
});

// --- schema validation ---

test("response-schemas-validated counts x-unvalidated operations and flips only at zero", () => {
  const doc = (unvalidated) => ({
    paths: {
      "/a": { get: unvalidated ? { "x-unvalidated": true } : {} },
      "/b": { post: {}, parameters: [] },
    },
  });
  const some = checkSchemaValidation(doc(true));
  assert.equal(some.state, UNMET);
  assert.match(some.detail, /1 of 2 operations/);
  assert.equal(checkSchemaValidation(doc(false)).state, MET);
});

// --- ADR numbering ---

test("an ADR number lookup resolves to the FIRST section, which is why numbers must be unique", () => {
  // Synthetic, and the reason the real-file check below exists. checkAdr0022 (and any future
  // by-number reader) does `split("## ADR-00NN")[1]`, so when a number appears twice the SECOND
  // decision is unreachable and the first answers in its name — silently, with no error anywhere.
  const collided = [
    "## ADR-0022 — first one\n\n**Status:** Accepted\n",
    "## ADR-0022 — second one\n\n**Status:** Superseded\n",
  ].join("\n");
  assert.equal(checkAdr0022(collided).state, MET, "the FIRST section answered, not the second");

  const swapped = [
    "## ADR-0022 — second one\n\n**Status:** Superseded\n",
    "## ADR-0022 — first one\n\n**Status:** Accepted\n",
  ].join("\n");
  assert.equal(
    checkAdr0022(swapped).state,
    UNMET,
    "same two sections, opposite order, opposite verdict — order alone decides",
  );
});

test("every ADR number in docs/DECISIONS.md is unique", () => {
  // Reads the real file on purpose: the invariant IS about the real file. ADR-0019 was held by two
  // different decisions (pilot invitations, and locale capability gates) until the latter was
  // renumbered to ADR-0055 (0038 is already the consolidated device-enrollment decision).
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs/DECISIONS.md"),
    "utf8",
  );
  const numbers = (src.match(/^## ADR-\d+/gm) ?? []).map((h) => h.replace("## ADR-", ""));
  const seen = new Set();
  const duplicated = numbers.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  assert.deepEqual(
    [...new Set(duplicated)],
    [],
    "two ADRs share a number; a by-number reader would silently resolve to whichever is first",
  );
});
