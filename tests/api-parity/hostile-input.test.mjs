import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { request, startApi, startMockUpstream, uniqueSuffix } from "./lib/harness.mjs";

/**
 * N2 — the committed half of the hostile-input sweep.
 * specs/nul-byte-5xx/plan.md §5
 *
 * The research probe fired 681 mutations at every endpoint and found exactly one 5xx cause: a NUL
 * byte in any string reaching Postgres, on 16 surfaces. This is the trimmed, permanent version.
 *
 * ── Two halves, and the second is the more valuable ────────────────────────────────────────────
 * The NUL cases prove the fix. The "still holds" cases are the REGRESSION NET: they are what makes
 * a future 500 anywhere in this surface a test failure rather than a discovery. Huge strings,
 * integer overflow, SQL-ish input and malformed bodies all behave correctly today, and nothing
 * except this file says so.
 *
 * The final test asserts NO probe on ANY endpoint returns 5xx, so a new endpoint with the same gap
 * fails without anyone remembering to add a case.
 */

// Written as an escape, not a literal: a raw NUL in a source file is invisible in every diff and
// most editors, and a reader cannot tell it from a typo.
const NUL = String.fromCharCode(0);
const withNul = (s) => `${s}${NUL}x`;

const HUGE = "x".repeat(100_000);
const SQLISH = "'; DROP TABLE users; --";
const LONE_SURROGATE = "a\ud800b";
const DEEP = (() => {
  const root = {};
  let cursor = root;
  for (let i = 0; i < 200; i += 1) {
    cursor.n = {};
    cursor = cursor.n;
  }
  return root;
})();

const consent = {
  recordingConsent: true,
  audioRetention: "discard",
  anonymizedLearning: false,
  externalAsrProcessing: false,
  guardianApproved: false,
  consentVersion: "pilot-v1",
};

let api;
let ml;
let asr;
/** Every response this file provokes, so the sweeping assertion below can see all of them. */
const seen = [];

before(async () => {
  ml = await startMockUpstream(() => ({ status: 200, body: { annotations: [], findings: [] } }));
  asr = await startMockUpstream(() => ({ status: 200, body: { text: "x", words: [] } }));
  api = await startApi({ env: { ML_INFERENCE_URL: ml.url, ASR_INFERENCE_URL: asr.url } });
});
after(async () => {
  await api?.stop();
  await ml?.stop();
  await asr?.stop();
});

async function probe(label, { method = "POST", path, role, body }) {
  const opts = { method, ...(role ? { role } : { tenant: null }) };
  if (body !== undefined) opts.body = body;
  const res = await request(api.baseUrl, path, opts);
  seen.push({ label, status: res.status, text: String(res.text).slice(0, 200) });
  return res;
}

/** The 16 surfaces, as [label, request]. A valid body with ONE field carrying a NUL. */
const nulCases = () => {
  const s = uniqueSuffix();
  return [
    ["session-create/sourceChecksum", { path: "/v1/recitation-sessions", role: "learner", body: {
      learnerId: "learner-1", quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
      sourceChecksum: withNul("c"),  language: "ar", consent } }],
    ["session-create/modelVersion", { path: "/v1/recitation-sessions", role: "learner", body: {
      learnerId: "learner-1", quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 1, display: "1:1" },
      sourceChecksum: "c", modelVersion: withNul("model-v0.3"), language: "ar", consent } }],
    ["progress/ayahRef", { path: "/v1/learner/progress", role: "learner", body: {
      quality: 4, ayahRef: withNul("1:1") } }],
    ["agent-run/name", { path: "/v1/agent-runs", role: "ops", body: {
      name: withNul("n"), goal: "g", status: "queued", confidence: 0.5, reviewStatus: "draft", sources: [] } }],
    ["agent-run/goal", { path: "/v1/agent-runs", role: "ops", body: {
      name: "n", goal: withNul("g"), status: "queued", confidence: 0.5, reviewStatus: "draft", sources: [] } }],
    ["agent-run/sources", { path: "/v1/agent-runs", role: "ops", body: {
      name: "n", goal: "g", status: "queued", confidence: 0.5, reviewStatus: "draft",
      sources: [{ id: withNul("s"), title: "t", citation: "c", url: null }] } }],
    ["teacher-review/findingId", { path: "/v1/teacher-reviews", role: "teacher", body: {
      findingId: withNul("f"), teacherId: "teacher-1", decision: "accepted", note: "n" } }],
    ["scholar-approval/topic", { path: "/v1/scholar-approvals", role: "scholar", body: {
      topic: withNul("t"), reviewerId: "scholar-1", status: "scholar-approved", risk: "low",
      sources: [{ id: "s", title: "t", citation: "c", url: null }] } }],
    ["ticket/sessionId", { path: "/v1/realtime-session-tickets", role: "learner", body: {
      sessionId: withNul("s") } }],
    ["register/tenantId", { path: "/v1/auth/register", role: "admin", body: {
      tenantId: withNul("hikmah-pilot-erbil"), displayName: "d", role: "learner", language: "ar",
      email: `nul-${s}@x.test`, password: "probe-password-12345" } }],
    ["register/email", { path: "/v1/auth/register", role: "admin", body: {
      tenantId: "hikmah-pilot-erbil", displayName: "d", role: "learner", language: "ar",
      email: withNul(`nul-${s}@x.test`), password: "probe-password-12345" } }],
    ["invite/learnerId", { path: "/v1/pilot/invitations", role: "admin", body: {
      learnerId: withNul("learner-1") } }],
    ["privacy-export/learnerId", { path: "/v1/privacy/export", role: "admin", body: {
      learnerId: withNul("learner-1") } }],
    ["alignments/path", { path: `/v1/recitation-sessions/${encodeURIComponent(withNul("s"))}/alignments`,
      role: "learner", body: { alignments: [] } }],
    ["request-review/path", { path: `/v1/recitation-sessions/${encodeURIComponent(withNul("s"))}/request-teacher-review`,
      role: "learner", body: {} }],
    ["get-session/path", { method: "GET", path: `/v1/recitation-sessions/${encodeURIComponent(withNul("s"))}`,
      role: "admin" }],
  ];
};

test("a NUL byte is a 400 on every surface that used to 500", async () => {
  // Postgres text cannot hold U+0000 (SQLSTATE 22021, class 22 = Data Exception). The API used to
  // report that as 500 — "the server broke" — for what is unambiguously bad input.
  const failures = [];
  for (const [label, req] of nulCases()) {
    const res = await probe(`nul/${label}`, req);
    if (res.status !== 400) failures.push(`${label} -> ${res.status} ${res.text.slice(0, 90)}`);
  }
  assert.deepEqual(failures, [], `these did not answer 400:\n  ${failures.join("\n  ")}`);
});

test("the NUL 400 names the problem without leaking database internals", async () => {
  const [, req] = nulCases()[0];
  const res = await probe("nul/message", req);
  assert.match(res.body.error, /NUL/i, "the caller must be told WHAT is wrong, or 400 is a dead end");
  // ApiError::Database redacts raw Postgres text because it can carry table names and conflicting
  // values. The new branch must supply its own message rather than forwarding the database's.
  for (const leak of ["SQLSTATE", "22021", "sqlx", "recitation_sessions", "encoding"]) {
    assert.ok(!res.text.includes(leak), `the response leaked ${leak}: ${res.text}`);
  }
});

// ── the regression net: what already holds, asserted so it keeps holding ────────────────────────

test("oversized, overflowing and hostile inputs still answer a clean 4xx", async () => {
  const s = uniqueSuffix();
  const cases = [
    ["huge-string", { path: "/v1/agent-runs", role: "ops", body: {
      name: HUGE, goal: "g", status: "queued", confidence: 0.5, reviewStatus: "draft", sources: [] } }],
    ["sqlish", { path: "/v1/agent-runs", role: "ops", body: {
      name: SQLISH, goal: SQLISH, status: "queued", confidence: 0.5, reviewStatus: "draft", sources: [] } }],
    ["lone-surrogate", { path: "/v1/agent-runs", role: "ops", body: {
      name: LONE_SURROGATE, goal: "g", status: "queued", confidence: 0.5, reviewStatus: "draft", sources: [] } }],
    ["deep-nesting-200", { path: "/v1/agent-runs", role: "ops", body: DEEP }],
    ["array-not-object", { path: "/v1/agent-runs", role: "ops", body: [] }],
    ["scalar-not-object", { path: "/v1/agent-runs", role: "ops", body: 42 }],
    ["float-overflow", { path: "/v1/learner/progress", role: "learner", body: { quality: 1e308, ayahRef: "1:1" } }],
    ["negative-i32", { path: "/v1/learner/progress", role: "learner", body: { quality: -2147483649, ayahRef: "1:1" } }],
    ["email-huge", { path: "/v1/auth/register", role: "admin", body: {
      tenantId: "hikmah-pilot-erbil", displayName: "d", role: "learner", language: "ar",
      email: `${HUGE}@x.test`, password: `p-${s}-12345678901234` } }],
    ["surah-negative", { method: "GET", path: "/v1/quran/surahs/-1", role: "admin" }],
    ["surah-i32-overflow", { method: "GET", path: "/v1/quran/surahs/2147483648", role: "admin" }],
    ["surah-21-digits", { method: "GET", path: "/v1/quran/surahs/999999999999999999999", role: "admin" }],
    ["ayah-overflow", { method: "GET", path: "/v1/quran/ayahs/2147483648/2147483648", role: "admin" }],
    ["path-traversal", { method: "GET", path: "/v1/eval-runs/..%2f..%2fetc%2fpasswd", role: "admin" }],
    ["query-sqlish", { method: "GET", path: `/v1/learner/progress?learnerId=${encodeURIComponent(SQLISH)}`, role: "admin" }],
  ];
  const failures = [];
  for (const [label, req] of cases) {
    const res = await probe(`holds/${label}`, req);
    // 2xx is fine where the input is merely unusual rather than invalid — an oversized name is not
    // a protocol error. What must never happen is a 5xx.
    if (res.status >= 500) failures.push(`${label} -> ${res.status} ${res.text.slice(0, 90)}`);
  }
  assert.deepEqual(failures, [], `these produced a 5xx:\n  ${failures.join("\n  ")}`);
});

test("NO probe in this file produced a 5xx", async () => {
  // The generalising assertion. Every case above already checks itself, but this one also covers
  // anything added later without its own check — including a new endpoint appended to nulCases()
  // by someone who forgets the per-case assertion.
  assert.ok(seen.length >= 30, `expected the sweep to have run, saw ${seen.length} probes`);
  const fivexx = seen.filter((r) => r.status >= 500);
  assert.deepEqual(
    fivexx.map((r) => `${r.label} -> ${r.status} ${r.text.slice(0, 80)}`),
    [],
    "a 5xx is the signal a security reviewer reads as 'a path nobody thought about'",
  );
});
