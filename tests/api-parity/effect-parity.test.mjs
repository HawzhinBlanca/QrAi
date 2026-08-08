/**
 * EFFECT parity: for the same request, does the Node port write the same ROWS Rust writes?
 *
 *   node --test tests/api-parity/effect-parity.test.mjs
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────────
 * `assertAB` compares status, headers and response bytes. It cannot see a missing INSERT. Measured
 * on `POST /v1/ml/tajweed-findings:predict` before it was fixed:
 *
 *     rust        status=200  findings in response=5  tajweed_findings=1  audit=1
 *     node shell  status=200  findings in response=5  tajweed_findings=0  audit=0
 *
 * Identical on every axis the differ inspects, opposite on the axis that decides whether a teacher
 * ever sees the finding. RESPONSE PARITY IS NOT EFFECT PARITY, and the suite had no test of the
 * second kind at all — for any route.
 *
 * So this counts rows per table around one request, against each implementation in turn, and fails
 * on any table where the two disagree. It is deliberately generic: the next route someone ports will
 * be covered by adding one case, not by remembering that this class of bug exists.
 *
 * ── What it cannot tell you ─────────────────────────────────────────────────────────────────────
 * Row COUNTS, not contents. Two implementations writing one row each with different columns look
 * identical here — that is what the per-route effects tests are for
 * (`tajweed-persistence-effects.test.mjs` asserts review_status, analysis_basis, the audit action,
 * the trace and the actor). This is the wide, shallow net; those are the deep ones.
 *
 * ── Proven to have teeth ────────────────────────────────────────────────────────────────────────
 * With Node's agent-runs audit INSERT deleted, this reports:
 *
 *     POST /v1/agent-runs   500/200   agent_runs: shell +0 vs rust +1; audit_events: shell +0 vs rust +1
 *
 * A sweep that has only ever been run against agreeing implementations has never been shown to
 * detect a disagreement.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  purgeSessionsByChecksum,
  queryJson,
  request,
  startApi,
  startMockUpstream,
  startShell,
  uniqueSuffix,
} from "./lib/harness.mjs";

// Run-scoped session checksums, so the teardown at the end of this file deletes exactly this run's
// rows and nothing else. These suites created sessions and never removed them: measured, the shared
// staging database had accumulated 64,869 recitation sessions across ~8 fixed checksums, growing by
// thousands a day. Leaked rows already broke a review-parity assertion and a Rust integration test
// once in this program (`seedQueued`), and an unbounded corpus is what makes ORDER BY without a
// unique tiebreaker, row-count deltas, and other suites' bulk teardown intermittently fail.
// Per-run rather than a shared literal: two agents run this gate against the same Postgres.
const RUN_CK_EFFECTS = `fnv1a32:effects-${uniqueSuffix()}`;


/** Every tenant-owned table a request could plausibly write. Reference data is deliberately absent. */
const TABLES = [
  "agent_runs",
  "alignment_runs",
  "audio_chunks",
  "audit_events",
  "consent_records",
  "learner_progress",
  "pilot_invitations",
  "pilot_sessions",
  "privacy_jobs",
  "realtime_session_tickets",
  "recitation_sessions",
  "scholar_approvals",
  "tajweed_findings",
  "teacher_reviews",
  "word_alignments",
];

const PORTED = [
  "POST /v1/recitation-sessions",
  "POST /v1/recitation-sessions/{id}/alignments",
  "POST /v1/recitation-sessions/{id}/request-teacher-review",
  "POST /v1/learner/progress",
  "POST /v1/agent-runs",
  "POST /v1/realtime-session-tickets",
  "POST /v1/ml/alignments:predict",
].join(",");

const LEARNER = "learner-1";

let api;
let shell;
let rustUrl;
let mlMock;
let words;

const sessionBody = () => ({
  learnerId: LEARNER,
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "Al-Fatihah 1:1" },
  sourceChecksum: RUN_CK_EFFECTS,

  language: "ckb",
  mode: "guided-recite",
  practicePlanId: "fatihah-mastery-v1",
  consent: {
    audioRetention: "discard",
    anonymizedLearning: true,
    externalAsrProcessing: false,
    guardianApproved: true,
    consentVersion: "pilot-v1",
  },
});

before(async () => {
  words = (
    await queryJson(
      "SELECT id FROM canonical_words WHERE ayah_id = '1:1' ORDER BY word_index LIMIT 2",
    )
  ).map((r) => r.id);
  assert.equal(words.length, 2, "need 2 canonical words from 1:1");

  // The ML route must SUCCEED on both sides. Two 502s compare no-effect with no-effect and pass
  // while proving nothing — the first run of this sweep did exactly that on three of seven routes.
  mlMock = await startMockUpstream((req) => ({
    status: 200,
    body: {
      sessionId: req.body?.sessionId ?? null,
      transcriptSource: "client-reported",
      modelVersion: "declared-quran-aligner-fixture",
      modelAttribution: {
        schemaVersion: 1,
        primaryComponent: "quran-aligner",
        components: [
          {
            component: "quran-aligner",
            status: "active",
            implementationId: "declared-quran-aligner-fixture",
            artifactDigest: `sha256:${"a".repeat(64)}`,
            datasetVersion: "declared-fixture",
            analysisBasis: "quran-constrained",
            calibratorId: null,
          },
        ],
      },
      alignments: [
        {
          wordId: words[0],
          heardText: "x",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
          status: "matched",
        },
      ],
    },
  }));

  api = await startApi({ env: { ML_INFERENCE_URL: mlMock.url } });
  rustUrl = api.upstreamUrl ?? api.baseUrl;
  shell = await startShell({
    upstream: rustUrl,
    env: { NODE_API_PORTED: PORTED, ML_INFERENCE_URL: mlMock.url },
  });
});

after(async () => {
  await shell?.stop();
  await api?.stop();
  await mlMock?.stop();
});

async function counts() {
  const out = {};
  for (const t of TABLES) {
    const [row] = await queryJson(`SELECT count(*)::int AS n FROM ${t}`);
    out[t] = row.n;
  }
  return out;
}

async function freshSession(base) {
  const res = await request(base, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    userId: LEARNER,
    body: sessionBody(),
  });
  assert.equal(res.status, 200, `session create failed: ${res.text}`);
  return res.body.id ?? res.body.sessionId;
}

/** One request per implementation. Each builds its own state so neither inherits the other's. */
const CASES = [
  {
    name: "POST /v1/recitation-sessions",
    run: (base) =>
      request(base, "/v1/recitation-sessions", {
        method: "POST",
        role: "learner",
        userId: LEARNER,
        body: sessionBody(),
      }),
  },
  {
    name: "POST /v1/recitation-sessions/{id}/alignments",
    run: async (base) => {
      const id = await freshSession(base);
      return request(base, `/v1/recitation-sessions/${id}/alignments`, {
        method: "POST",
        role: "learner",
        userId: LEARNER,
        body: {
          alignments: [
            {
              wordId: words[0],
              heardText: "x",
              startMs: 0,
              endMs: 100,
              confidence: 0.9,
              status: "matched",
            },
            {
              wordId: words[1],
              heardText: "y",
              startMs: 100,
              endMs: 200,
              confidence: 0.5,
              status: "misread",
            },
          ],
        },
      });
    },
  },
  {
    name: "POST /v1/recitation-sessions/{id}/request-teacher-review",
    run: async (base) => {
      const id = await freshSession(base);
      return request(base, `/v1/recitation-sessions/${id}/request-teacher-review`, {
        method: "POST",
        role: "learner",
        userId: LEARNER,
        body: {},
      });
    },
  },
  {
    name: "POST /v1/learner/progress",
    run: (base) =>
      request(base, "/v1/learner/progress", {
        method: "POST",
        role: "learner",
        userId: LEARNER,
        body: { quality: 5, ayahRef: `2:${uniqueSuffix()}` },
      }),
  },
  {
    name: "POST /v1/agent-runs",
    run: (base) =>
      request(base, "/v1/agent-runs", {
        method: "POST",
        role: "admin",
        body: {
          name: "mistake-pattern",
          goal: "find repeated errors",
          status: "needs-human-review",
          confidence: 0.5,
          reviewStatus: "ai-suggested",
          sources: [{ id: "s1", url: null, title: "Tajweed rule", citation: "ref" }],
          lastEvent: "started",
        },
      }),
  },
  {
    name: "POST /v1/realtime-session-tickets",
    run: async (base) => {
      const id = await freshSession(base);
      return request(base, "/v1/realtime-session-tickets", {
        method: "POST",
        role: "learner",
        userId: LEARNER,
        body: { sessionId: id },
      });
    },
  },
  {
    name: "POST /v1/ml/alignments:predict",
    run: async (base) => {
      const id = await freshSession(base);
      return request(base, "/v1/ml/alignments:predict", {
        method: "POST",
        role: "learner",
        userId: LEARNER,
        body: { sessionId: id, quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" } },
      });
    },
  },
];

for (const c of CASES) {
  test(`${c.name} writes the same rows in both implementations`, async () => {
    const deltas = {};
    const statuses = {};

    for (const [impl, base] of [
      ["shell", shell.baseUrl],
      ["rust", rustUrl],
    ]) {
      const before = await counts();
      const res = await c.run(base);
      const after = await counts();
      statuses[impl] = res.status;
      deltas[impl] = {};
      for (const t of TABLES) {
        if (after[t] !== before[t]) deltas[impl][t] = after[t] - before[t];
      }
    }

    // A request that failed on both sides writes nothing on both sides and would compare equal.
    // Asserting success first is what stops this whole file passing vacuously — three of the seven
    // cases did exactly that on their first run, with a 422 or 502 on both sides.
    assert.equal(
      statuses.shell,
      200,
      `${c.name}: the shell did not succeed (${statuses.shell}), so its effects prove nothing`,
    );
    assert.equal(
      statuses.rust,
      200,
      `${c.name}: rust did not succeed (${statuses.rust}), so its effects prove nothing`,
    );

    const divergent = [];
    for (const t of new Set([...Object.keys(deltas.shell), ...Object.keys(deltas.rust)])) {
      const s = deltas.shell[t] ?? 0;
      const r = deltas.rust[t] ?? 0;
      if (s !== r) divergent.push(`${t}: shell +${s} vs rust +${r}`);
    }
    assert.deepEqual(
      divergent,
      [],
      `${c.name}: the two implementations answered identically and wrote different rows — ` +
        `${divergent.join("; ")}`,
    );

    // A case whose request writes NOTHING anywhere is not testing effect parity; it is testing that
    // two implementations agree about doing nothing, which they always will.
    assert.ok(
      Object.keys(deltas.rust).length > 0,
      `${c.name}: wrote no rows at all, so this case cannot detect a missing write`,
    );
  });
}

// Registered last: node:test runs `after` hooks in registration order, so this drains the
// rows once the hooks above have stopped the services still able to write them.
after(async () => {
  let left = 0;
  left += await purgeSessionsByChecksum(RUN_CK_EFFECTS);
  assert.equal(left, 0, `teardown left ${left} session(s) behind`);
});
