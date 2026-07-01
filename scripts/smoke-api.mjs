import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const baseUrl = process.env.PLATFORM_API_SMOKE_URL ?? "http://127.0.0.1:8080";
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://hawzhin@localhost:5432/quran_ai";
const realtimeTicketSecret = process.env.REALTIME_GATEWAY_TICKET_SECRET ?? "smoke-secret";
const smokeTraceId = process.env.SMOKE_TRACE_ID ?? `smoke-trace-${randomUUID()}`;
const tenant = process.env.SMOKE_TENANT ?? "hikmah-pilot-erbil";

async function request(path, options = {}) {
  const role = options.role ?? "learner";
  const userId = options.userId ?? (role === "learner" ? "learner-1" : role === "teacher" ? "teacher-1" : "admin-1");
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-tenant-id": options.tenant ?? tenant,
      "x-user-id": userId,
      "x-user-role": role,
      "x-trace-id": smokeTraceId,
      ...(options.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

const health = await fetch(`${baseUrl}/health`);
if (!health.ok) {
  console.error(`platform api health failed: ${health.status}`);
  process.exit(1);
}

// Test Quran surah list
const surahs = await request("/v1/quran/surahs", {});
if (!surahs.response.ok || !Array.isArray(surahs.body) || surahs.body.length < 114) {
  console.error(`quran surah list failed: ${surahs.response.status}`);
  process.exit(1);
}

// Test get specific ayah
const ayah = await request("/v1/quran/ayahs/1/1", {});
if (!ayah.response.ok || !ayah.body?.text) {
  console.error(`quran ayah fetch failed: ${ayah.response.status}`);
  process.exit(1);
}

const created = await request("/v1/recitation-sessions", {
  method: "POST",
  body: JSON.stringify({
    learnerId: "learner-1",
    quranRef: {
      surahNumber: 1,
      ayahStart: 1,
      ayahEnd: 7,
      display: "Al-Fatihah 1:1-7",
    },
    sourceChecksum: "fnv1a32:smoke",
    modelVersion: "model-v0.3",
    language: "ckb",
    mode: "guided-recite",
    practicePlanId: "fatihah-mastery-v1",
    consent: {
      audioRetention: "discard",
      anonymizedLearning: true,
      externalAsrProcessing: true,
      guardianApproved: true,
      consentVersion: "pilot-v1",
    },
  }),
});

if (!created.response.ok || !created.body?.id) {
  console.error(`session create failed: ${created.response.status}`);
  process.exit(1);
}

const sameTenant = await request(`/v1/recitation-sessions/${created.body.id}`);
if (!sameTenant.response.ok) {
  console.error(`same tenant read failed: ${sameTenant.response.status}`);
  process.exit(1);
}

const otherTenant = await request(`/v1/recitation-sessions/${created.body.id}`, {
  tenant: "tenant-other",
});
if (otherTenant.response.status !== 404) {
  console.error(`cross tenant isolation failed: ${otherTenant.response.status}`);
  process.exit(1);
}

const ticket = await request("/v1/realtime-session-tickets", {
  method: "POST",
  body: JSON.stringify({
    sessionId: created.body.id,
    requestedSampleRates: [16000, 48000],
  }),
});
if (
  !ticket.response.ok ||
  !ticket.body?.token?.startsWith("rt_v1.")
) {
  console.error(`realtime ticket failed: ${ticket.response.status}`);
  process.exit(1);
}

// Missing findings must be rejected cleanly before insert; this catches FK-driven 500s.
const missingFindingReview = await request("/v1/teacher-reviews", {
  method: "POST",
  role: "teacher",
  body: JSON.stringify({
    findingId: "finding-smoke",
    teacherId: "teacher-1",
    decision: "accepted",
    note: "Smoke review accepted.",
  }),
});
if (missingFindingReview.response.status !== 404) {
  console.error(`teacher-review with missing finding expected 404, got ${missingFindingReview.response.status}`);
  process.exit(1);
}

// Success path: seed a real FK chain, then review it through the public API.
const teacherReviewFindingId = `finding-smoke-${randomUUID()}`;
await seedTeacherReviewFinding({
  sessionId: created.body.id,
  findingId: teacherReviewFindingId,
});
const teacherReview = await request("/v1/teacher-reviews", {
  method: "POST",
  role: "teacher",
  body: JSON.stringify({
    findingId: teacherReviewFindingId,
    teacherId: "teacher-1",
    decision: "edited",
    note: "Smoke review wrote a real teacher decision.",
  }),
});
if (!teacherReview.response.ok || !teacherReview.body?.id) {
  console.error(`teacher-review success path failed: ${teacherReview.response.status}`);
  process.exit(1);
}

// Also test scholar approval (no FK chain needed)
const scholarApproval = await request("/v1/scholar-approvals", {
  method: "POST",
  role: "scholar",
  userId: "scholar-1",
  body: JSON.stringify({
    topic: "Smoke test approval",
    reviewerId: "scholar-1",
    status: "scholar-approved",
    risk: "low",
    sources: [{
      id: "smoke-source",
      title: "Smoke Source",
      citation: "Smoke test citation",
    }],
  }),
});
if (!scholarApproval.response.ok || !scholarApproval.body?.id) {
  console.error(`scholar approval failed: ${scholarApproval.response.status}`);
  process.exit(1);
}

const queue = await request("/v1/teacher-review-queue", {
  role: "teacher",
});
if (!queue.response.ok || !Array.isArray(queue.body)) {
  console.error(`teacher queue failed: ${queue.response.status}`);
  process.exit(1);
}
if (queue.body.length < 1) {
  console.error("teacher queue smoke expected at least one seeded review item");
  process.exit(1);
}

const evalRun = await request("/v1/eval-runs/model-v0.3", { role: "admin" });
if (
  !evalRun.response.ok ||
  !evalRun.body?.modelVersion
) {
  console.error(`eval lookup failed: ${evalRun.response.status}`);
  process.exit(1);
}

const exported = await request("/v1/privacy/export", {
  method: "POST",
  body: JSON.stringify({ learnerId: "learner-1" }),
});
if (!exported.response.ok || !exported.body?.includedRecords?.includes(created.body.id)) {
  console.error(`privacy export failed: ${exported.response.status}`);
  process.exit(1);
}

const deleted = await request("/v1/privacy/delete", {
  method: "POST",
  body: JSON.stringify({ learnerId: "learner-1" }),
});
if (!deleted.response.ok || !deleted.body?.deletedRecords?.includes(created.body.id)) {
  console.error(`privacy delete failed: ${deleted.response.status}`);
  process.exit(1);
}

const deniedTeacherAction = await request("/v1/teacher-reviews", {
  method: "POST",
  role: "learner",
  body: JSON.stringify({
    findingId: "finding-denied-smoke",
    teacherId: "teacher-1",
    decision: "accepted",
    note: "Learner should be denied.",
  }),
});
if (deniedTeacherAction.response.status !== 403) {
  console.error(`RBAC denial smoke failed: ${deniedTeacherAction.response.status}`);
  process.exit(1);
}

const auditEvents = await request("/v1/audit-events", { role: "admin" });
if (
  !auditEvents.response.ok ||
  !auditEvents.body?.some((event) => event.action === "recitation.realtime-ticket.issued") ||
  !auditEvents.body?.some((event) => event.action === "privacy.delete.requested")
) {
  console.error(`audit event smoke failed: ${auditEvents.response.status}`);
  process.exit(1);
}

// Test SM-2 progress
const progress = await request("/v1/learner/progress", {
  method: "POST",
  body: JSON.stringify({ quality: 5, ayahRef: "1:1" }),
});
if (!progress.response.ok || !progress.body?.sm2State) {
  console.error(`SM-2 progress failed: ${progress.response.status}`);
  process.exit(1);
}

console.log(
  JSON.stringify({
    status: "pass",
    sessionId: created.body.id,
    traceId: smokeTraceId,
    surahCount: surahs.body.length,
    ayahText: ayah.body.text.slice(0, 30),
    sameTenant: sameTenant.response.status,
    otherTenant: otherTenant.response.status,
    evalModel: evalRun.body.modelVersion,
    evalPassed: evalRun.body.passed,
    teacherReview: teacherReview.body.id,
    teacherQueue: queue.body.length,
    scholarApproval: scholarApproval.body?.id ?? "none",
    privacyExport: exported.body.includedRecords.length,
    privacyDelete: deleted.body.deletedRecords.length,
    rbacDenied: deniedTeacherAction.response.status,
    auditEvents: auditEvents.body.length,
    sm2Interval: progress.body.sm2State.intervalDays,
    sm2NextReview: progress.body.nextReviewAt,
  }),
);

async function seedTeacherReviewFinding({ sessionId, findingId }) {
  const psql = resolvePsql();
  const alignmentId = `alignment-smoke-${randomUUID()}`;
  const auditId = `audit-smoke-${randomUUID()}`;
  const tenantSql = sqlLiteral(tenant);
  const sessionSql = sqlLiteral(sessionId);
  const findingSql = sqlLiteral(findingId);
  const alignmentSql = sqlLiteral(alignmentId);
  const auditSql = sqlLiteral(auditId);
  const traceSql = sqlLiteral(smokeTraceId);
  const sql = `
begin;
set local app.tenant_id = ${tenantSql};

insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id, metadata)
values (${auditSql}, ${tenantSql}, 'teacher-1', 'smoke.teacher-review.seed', 'tajweed_finding', ${findingSql}, jsonb_build_object('trace_id', ${traceSql}));

with source_word as (
  select id, text_uthmani
  from canonical_words
  where ayah_id = '1:1' and word_index = 1
),
inserted_alignment as (
  insert into word_alignments (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status, model_version_id, audit_event_id)
  select ${alignmentSql}, ${tenantSql}, ${sessionSql}, id, text_uthmani, 0, 500, 0.72, 'needs-review', 'model-v0.3', ${auditSql}
  from source_word
  returning id
)
select count(*) from inserted_alignment;

insert into tajweed_findings (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status, source_refs, model_version_id, audit_event_id)
values (
  ${findingSql},
  ${tenantSql},
  ${alignmentSql},
  'madd',
  'practice',
  0.72,
  'Smoke-seeded finding for public teacher-review write proof.',
  'teacher-review-required',
  '[{"id":"smoke-source","title":"Smoke source","citation":"API smoke seeded review prerequisite"}]',
  'model-v0.3',
  ${auditSql}
);

commit;
`;
  let result;
  try {
    result = await run(psql, [
      "--set",
      "ON_ERROR_STOP=1",
      "--dbname",
      databaseUrl,
      "--command",
      sql,
    ]);
  } catch (error) {
    console.error(`teacher-review smoke seed failed to launch psql: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (result.code !== 0) {
    console.error(`teacher-review smoke seed failed: ${redactDatabaseUrl(result.stderr || result.stdout)}`);
    process.exit(1);
  }
}

function resolvePsql() {
  const candidates = [
    process.env.PSQL,
    "/opt/homebrew/opt/postgresql@16/bin/psql",
    "/opt/homebrew/bin/psql",
    "/usr/local/bin/psql",
    "psql",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  return "psql";
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") }));
  });
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function redactDatabaseUrl(value) {
  return value.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}
