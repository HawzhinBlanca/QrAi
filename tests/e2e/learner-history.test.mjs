import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { assertMatchesContract } from "../api-parity/lib/contract.mjs";
import {
  TENANT,
  insertDeclaredTestAcousticFinding,
  queryJson,
  request,
  startApi,
  startShell,
  uniqueSuffix,
  withDb,
} from "../api-parity/lib/harness.mjs";

const HISTORY_ROUTE = "GET /v1/learner/recitation-sessions";
const LOCAL_ROUTES = [
  HISTORY_ROUTE,
  "GET /v1/recitation-sessions/{id}/tajweed-findings",
  "POST /v1/teacher-reviews",
].join(",");

const quranRef = {
  surahNumber: 1,
  ayahStart: 1,
  ayahEnd: 1,
  display: "1:1",
};

const consent = {
  audioRetention: "discard",
  anonymizedLearning: false,
  externalAsrProcessing: false,
  guardianApproved: false,
  consentVersion: "pilot-v1",
};

let api;
let shell;
let learnerId;
let otherLearnerId;
let otherSessionId;
let findingId;
const sessions = [];

async function createSession(userId, secondsAgo) {
  const created = await request(shell.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    userId,
    body: {
      learnerId: userId,
      quranRef,
      sourceChecksum: "learner-history-declared-fixture",
      language: "ckb",
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent,
    },
  });
  assert.equal(created.status, 200, `could not create history fixture: ${created.text}`);
  sessions.push(created.body.id);
  await queryJson(
    "UPDATE recitation_sessions SET started_at = now() - ($2::text || ' seconds')::interval WHERE id = $1",
    [created.body.id, secondsAgo],
  );
  return created.body;
}

async function history(path = "") {
  return request(shell.baseUrl, `/v1/learner/recitation-sessions${path}`, {
    role: "learner",
    userId: learnerId,
  });
}

before(async () => {
  api = await startApi({});
  const rustUrl = api.upstreamUrl ?? api.baseUrl;
  // Red first: startup must reject HISTORY_ROUTE until it is present in both local registries.
  shell = await startShell({ upstream: rustUrl, env: { NODE_API_PORTED: LOCAL_ROUTES } });

  const suffix = uniqueSuffix();
  learnerId = `learner-history-${suffix}`;
  otherLearnerId = `learner-history-other-${suffix}`;
  await queryJson(
    `INSERT INTO users (id, tenant_id, display_name, role, language)
     VALUES ($1, $3, 'History Learner', 'learner', 'ckb'),
            ($2, $3, 'Other History Learner', 'learner', 'ckb')`,
    [learnerId, otherLearnerId, TENANT],
  );

  for (const secondsAgo of [40, 30, 20, 10]) await createSession(learnerId, secondsAgo);
  otherSessionId = (await createSession(otherLearnerId, 5)).id;

  const [word] = await queryJson("SELECT id FROM canonical_words ORDER BY ayah_id, word_index LIMIT 1");
  assert.ok(word, "canonical-word fixture is required");
  const aligned = await request(shell.baseUrl, `/v1/recitation-sessions/${sessions[1]}/alignments`, {
    method: "POST",
    role: "learner",
    userId: learnerId,
    body: {
      alignments: [
        {
          wordId: word.id,
          heardText: "declared-fixture",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
          status: "matched",
        },
      ],
    },
  });
  assert.equal(aligned.status, 200, `could not create history alignment: ${aligned.text}`);
  const [alignment] = await queryJson(
    "SELECT id FROM word_alignments WHERE session_id = $1 ORDER BY id LIMIT 1",
    [sessions[1]],
  );
  assert.ok(alignment, "the declared alignment must be persisted");

  findingId = `finding-history-${suffix}`;
  await insertDeclaredTestAcousticFinding({
    id: findingId,
    alignmentId: alignment.id,
    reviewStatus: "ai-suggested",
    auditEventId: aligned.body.auditEventId,
    sources: [{ title: "Declared test source", locator: "learner-history-e2e" }],
  });
});

after(async () => {
  try {
    if (sessions.length > 0) {
      await withDb(async (client) => {
        await client.query("BEGIN");
        try {
          const { rows: sessionRows } = await client.query(
            "SELECT consent_record_id, audit_event_id FROM recitation_sessions WHERE id = ANY($1::text[])",
            [sessions],
          );
          const { rows: dependentAuditRows } = await client.query(
            `SELECT audit_event_id FROM word_alignments WHERE session_id = ANY($1::text[])
             UNION SELECT tf.audit_event_id FROM tajweed_findings tf
               JOIN word_alignments wa ON wa.id = tf.alignment_id WHERE wa.session_id = ANY($1::text[])
             UNION SELECT tr.audit_event_id FROM teacher_reviews tr
               JOIN tajweed_findings tf ON tf.id = tr.finding_id
               JOIN word_alignments wa ON wa.id = tf.alignment_id WHERE wa.session_id = ANY($1::text[])`,
            [sessions],
          );
          await client.query(
            `DELETE FROM teacher_reviews WHERE finding_id IN (
               SELECT tf.id FROM tajweed_findings tf JOIN word_alignments wa ON wa.id = tf.alignment_id
               WHERE wa.session_id = ANY($1::text[]))`,
            [sessions],
          );
          await client.query(
            `DELETE FROM tajweed_findings WHERE alignment_id IN (
               SELECT id FROM word_alignments WHERE session_id = ANY($1::text[]))`,
            [sessions],
          );
          await client.query("DELETE FROM word_alignments WHERE session_id = ANY($1::text[])", [sessions]);
          await client.query("DELETE FROM recitation_sessions WHERE id = ANY($1::text[])", [sessions]);
          const consentIds = sessionRows.map((row) => row.consent_record_id);
          if (consentIds.length > 0) {
            await client.query("DELETE FROM consent_records WHERE id = ANY($1::text[])", [consentIds]);
          }
          const auditIds = [
            ...sessionRows.map((row) => row.audit_event_id),
            ...dependentAuditRows.map((row) => row.audit_event_id),
          ];
          if (auditIds.length > 0) {
            await client.query("DELETE FROM audit_events WHERE id = ANY($1::text[])", [auditIds]);
          }
          await client.query("DELETE FROM users WHERE id = ANY($1::text[])", [
            [learnerId, otherLearnerId],
          ]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    }
  } finally {
    await shell?.stop();
    await api?.stop();
  }
});

test("learner history is own-only and the staff list remains privileged", async () => {
  const own = await history();
  assert.equal(own.status, 200);
  assertMatchesContract("GET", "/v1/learner/recitation-sessions", own);
  assert.ok(own.body.items.length >= 4);
  assert.ok(own.body.items.every((item) => sessions.includes(item.id)));
  assert.ok(own.body.items.every((item) => !Object.hasOwn(item, "learnerId")));
  assert.equal(own.body.items.some((item) => item.id === otherSessionId), false);

  for (const role of ["teacher", "scholar", "admin", "ops"]) {
    const denied = await request(shell.baseUrl, "/v1/learner/recitation-sessions", { role });
    assert.equal(denied.status, 403, `${role} must use staff-specific surfaces`);
  }
  const staffList = await request(shell.baseUrl, "/v1/recitation-sessions", {
    role: "learner",
    userId: learnerId,
  });
  assert.equal(staffList.status, 403, "the tenant-wide staff list must not be weakened");
});

test("keyset pages are stable when a newer session arrives between requests", async () => {
  const first = await history("?limit=2");
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 2);
  assert.equal(typeof first.body.nextCursor, "string");
  const firstIds = first.body.items.map((item) => item.id);

  const newer = await createSession(learnerId, 0);
  const second = await history(`?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.items.length, 2);
  assert.equal(second.body.nextCursor, null);
  const secondIds = second.body.items.map((item) => item.id);
  assert.equal(secondIds.includes(newer.id), false, "a newer insert must not shift an older page");
  assert.deepEqual(new Set([...firstIds, ...secondIds]).size, 4, "pages must not duplicate a session");

  const refreshed = await history("?limit=1");
  assert.equal(refreshed.body.items[0].id, newer.id, "a fresh first page sees the new practice");
});

test("unknown, other-owner, and cross-tenant cursors are all 404", async () => {
  for (const cursor of ["no-such-history-cursor", otherSessionId]) {
    const res = await history(`?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(res.status, 404);
  }
  const crossTenant = await request(
    shell.baseUrl,
    `/v1/learner/recitation-sessions?cursor=${encodeURIComponent(sessions[0])}`,
    { role: "learner", userId: learnerId, tenant: "other-tenant" },
  );
  assert.equal(crossTenant.status, 404);
});

test("history limit is strict and bounded", async () => {
  for (const value of ["0", "51", "1.5", "-1", "+1", " 1", "1e1"]) {
    const res = await history(`?limit=${encodeURIComponent(value)}`);
    assert.equal(res.status, 400, `limit=${JSON.stringify(value)} must be refused`);
  }
  const repeated = await history("?limit=1&limit=2");
  assert.equal(repeated.status, 400, "repeated limits must not be coerced");
});

test("a later teacher decision appears on refresh without rerunning inference", async () => {
  const beforeHistory = await history("?limit=50");
  const beforeItem = beforeHistory.body.items.find((item) => item.id === sessions[1]);
  assert.ok(beforeItem);
  assert.deepEqual(
    {
      total: beforeItem.findingCount,
      pending: beforeItem.pendingFindingCount,
      reviewed: beforeItem.reviewedFindingCount,
      blocked: beforeItem.blockedFindingCount,
    },
    { total: 1, pending: 1, reviewed: 0, blocked: 0 },
  );
  const [runsBefore] = await queryJson(
    "SELECT count(*)::int AS n FROM alignment_runs WHERE session_id = $1",
    [sessions[1]],
  );

  const reviewed = await request(shell.baseUrl, "/v1/teacher-reviews", {
    method: "POST",
    role: "teacher",
    body: {
      findingId,
      teacherId: "ignored-by-server",
      decision: "accepted",
      note: "Declared delayed-review fixture",
    },
  });
  assert.equal(reviewed.status, 200, reviewed.text);

  const afterHistory = await history("?limit=50");
  const afterItem = afterHistory.body.items.find((item) => item.id === sessions[1]);
  assert.deepEqual(
    {
      total: afterItem.findingCount,
      pending: afterItem.pendingFindingCount,
      reviewed: afterItem.reviewedFindingCount,
      blocked: afterItem.blockedFindingCount,
    },
    { total: 1, pending: 0, reviewed: 1, blocked: 0 },
  );
  const [runsAfter] = await queryJson(
    "SELECT count(*)::int AS n FROM alignment_runs WHERE session_id = $1",
    [sessions[1]],
  );
  assert.equal(runsAfter.n, runsBefore.n, "refresh and review must not rerun inference");

  const details = await request(
    shell.baseUrl,
    `/v1/recitation-sessions/${sessions[1]}/tajweed-findings`,
    { role: "learner", userId: learnerId },
  );
  assert.equal(details.status, 200);
  const finding = details.body.find((row) => row.id === findingId);
  assert.ok(finding, "the reviewed finding is retrievable later");
  assert.equal(finding.reviewStatus, "teacher-reviewed");
  assert.equal(finding.withheld, true, "declared incomplete evidence remains fail-closed");
  assert.equal(finding.explanation, "");
  assert.deepEqual(finding.sources, []);
});
