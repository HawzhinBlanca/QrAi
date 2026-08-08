import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** @typedef {{ status: "failed", error: string } | { status: "passed", tenantTablesChecked: number, mode: string, stdout: string[] }} LiveRunResult */
/** @typedef {LiveRunResult | { status: "pending" | "skipped", reason?: string }} LiveStatus */
/** @typedef {{ code: number | null, stdout: string, stderr: string }} CommandResult */

const tenantTables = [
  "users",
  "consent_records",
  "recitation_sessions",
  "audio_chunks",
  "word_alignments",
  "tajweed_findings",
  "teacher_reviews",
  "scholar_approvals",
  "agent_runs",
  "realtime_session_tickets",
  "realtime_ticket_replay_claims",
  "alignment_runs",
  "learner_progress",
  "privacy_jobs",
  "audit_events",
  "eval_runs",
  "pilot_invitations",
  "pilot_sessions",
  "background_jobs",
  "device_enrollment_invitations",
  "device_sessions",
];

const coreSchemaPaths = [
  join("infra", "migrations", "0001_core_schema.sql"),
  join("infra", "migrations", "0005_learner_progress.sql"),
  join("infra", "migrations", "0018_agent_run_learner_id.sql"),
  join("infra", "migrations", "0021_pilot_identity.sql"),
  join("infra", "migrations", "0034_background_jobs.sql"),
  join("infra", "migrations", "0035_device_identity.sql"),
  join("infra", "migrations", "0036_realtime_ticket_replay.sql"),
];
const sessionMigrationPath = join("infra", "migrations", "0008_session_language.sql");
const reviewStatusMigrationPaths = [
  join("infra", "migrations", "0010_review_status_check.sql"),
  join("infra", "migrations", "0011_teacher_review_required_status.sql"),
];
const rlsPaths = [
  join("infra", "migrations", "0003_tenant_rls.sql"),
  join("infra", "migrations", "0009_learner_progress_rls.sql"),
  join("infra", "migrations", "0012_superuser_only_rls_bypass.sql"),
  join("infra", "migrations", "0021_pilot_identity.sql"),
  join("infra", "migrations", "0034_background_jobs.sql"),
  join("infra", "migrations", "0035_device_identity.sql"),
  join("infra", "migrations", "0036_realtime_ticket_replay.sql"),
];
const coreSchemaRaw = (await Promise.all(coreSchemaPaths.map((path) => readFile(path, "utf8")))).join("\n");
const sessionMigrationRaw = await readFile(sessionMigrationPath, "utf8");
const reviewStatusMigrationRaw = (await Promise.all(reviewStatusMigrationPaths.map((path) => readFile(path, "utf8")))).join("\n");
const rlsSchemaRaw = (await Promise.all(rlsPaths.map((path) => readFile(path, "utf8")))).join("\n");
const coreSchema = normalizeSql(coreSchemaRaw);
const reviewStatusSchema = normalizeSql(reviewStatusMigrationRaw);
const rlsSchema = normalizeSql(rlsSchemaRaw);
const pilotIdentitySchema = normalizeSql(await readFile(join("infra", "migrations", "0021_pilot_identity.sql"), "utf8"));
const deviceIdentitySchema = normalizeSql(await readFile(join("infra", "migrations", "0035_device_identity.sql"), "utf8"));
const postgresUrl = process.env.POSTGRES_RLS_SMOKE_URL ?? process.env.DATABASE_URL;
const requireLive = process.env.SQL_SMOKE_REQUIRE_LIVE === "true";

const failures = /** @type {string[]} */ ([]);

for (const table of tenantTables) {
  assertRegex(
    coreSchema,
    new RegExp(`create table (if not exists )?${table} \\(`, "i"),
    `${table} table is missing from tenant schema migrations`,
  );
  assertRegex(
    coreSchema,
    new RegExp(`create table (if not exists )?${table} \\([\\s\\S]*?tenant_id text not null references institutions\\(id\\)`, "i"),
    `${table} must include tenant_id referencing institutions(id)`,
  );
  assertIncludes(rlsSchema, `alter table ${table} enable row level security;`, `${table} does not enable RLS`);
  assertIncludes(rlsSchema, `alter table ${table} force row level security;`, `${table} does not force RLS`);
  assertIncludes(rlsSchema, `create policy tenant_isolation_${table}`, `${table} tenant policy is missing`);
  assertRegex(
    rlsSchema,
    new RegExp(
      `create policy tenant_isolation_${table}[\\s\\S]*?using \\(app\\.is_rls_bypass_enabled\\(\\) or tenant_id = app\\.current_tenant_id\\(\\)\\)[\\s\\S]*?with check \\(app\\.is_rls_bypass_enabled\\(\\) or tenant_id = app\\.current_tenant_id\\(\\)\\);`,
      "i",
    ),
    `${table} policy must gate both USING and WITH CHECK by tenant_id`,
  );
}

assertIncludes(rlsSchema, "create schema if not exists app;", "app schema helper namespace is missing");
assertIncludes(rlsSchema, "create or replace function app.current_tenant_id()", "current tenant helper is missing");
assertIncludes(rlsSchema, "current_setting('app.tenant_id', true)", "current tenant helper must use app.tenant_id");
assertIncludes(rlsSchema, "create or replace function app.is_rls_bypass_enabled()", "RLS bypass helper is missing");
assertIncludes(rlsSchema, "current_setting('app.bypass_rls', true)", "RLS bypass helper must use app.bypass_rls");
assertIncludes(rlsSchema, "rolsuper", "RLS bypass helper must ignore app.bypass_rls for non-superuser roles");

// Pilot identity hardening guards (0021): SECURITY DEFINER functions must pin search_path
// (temp-table shadowing defense), strip PUBLIC execute, guard role grants by existence,
// and the migration must never carry destructive drops.
assertRegex(
  pilotIdentitySchema,
  /set search_path = public, pg_temp[\s\S]*set search_path = public, pg_temp/,
  "both pilot definer functions must pin search_path = public, pg_temp",
);
assertIncludes(
  pilotIdentitySchema,
  "revoke execute on function app.get_pilot_session_by_hash(text) from public;",
  "pilot session lookup must revoke PUBLIC execute",
);
assertIncludes(
  pilotIdentitySchema,
  "revoke execute on function app.consume_pilot_invitation_by_hash(text) from public;",
  "pilot invitation consume must revoke PUBLIC execute",
);
assertIncludes(
  pilotIdentitySchema,
  "rolname = 'quran_ai_app'",
  "pilot grants must be guarded by quran_ai_app role existence",
);
if (pilotIdentitySchema.includes("drop table") || pilotIdentitySchema.includes("drop function")) {
  failures.push("0021_pilot_identity.sql must not contain destructive drops");
}
assertRegex(
  deviceIdentitySchema,
  /set search_path = public, pg_temp[\s\S]*set search_path = public, pg_temp[\s\S]*set search_path = public, pg_temp/,
  "all device identity definer functions must pin search_path = public, pg_temp",
);
for (const signature of [
  "app.consume_device_enrollment_invitation_by_hash(text)",
  "app.get_device_session_by_access_hash(text)",
  "app.get_device_session_by_refresh_hash(text)",
]) {
  assertIncludes(
    deviceIdentitySchema,
    `revoke execute on function ${signature} from public;`,
    `${signature} must revoke PUBLIC execute`,
  );
}
if (deviceIdentitySchema.includes("drop table") || deviceIdentitySchema.includes("drop function")) {
  failures.push("0035_device_identity.sql must not contain destructive drops");
}
assertIncludes(
  reviewStatusSchema,
  "teacher-review-required",
  "review status constraint must allow teacher-review-required",
);

let live = /** @type {LiveStatus} */ ({
  status: "skipped",
  reason: "POSTGRES_RLS_SMOKE_URL or DATABASE_URL not set",
});

if (postgresUrl) {
  const liveResult = await runLivePostgresSmoke(postgresUrl);
  live = liveResult;
  if (liveResult.status === "failed") {
    failures.push(`live Postgres RLS smoke failed: ${liveResult.error}`);
  }
} else if (requireLive) {
  failures.push("live Postgres RLS smoke is required but POSTGRES_RLS_SMOKE_URL/DATABASE_URL is not set");
}

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "failed", failures, live }, null, 2));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      status: "passed",
      static: { tenantTablesChecked: tenantTables.length, forceRlsChecked: tenantTables.length },
      live,
    }),
  );
}

/** @param {string} sql */
function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

/** @param {string} haystack @param {string} needle @param {string} message */
function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle.toLowerCase())) {
    failures.push(message);
  }
}

/** @param {string} haystack @param {RegExp} regex @param {string} message */
function assertRegex(haystack, regex, message) {
  if (!regex.test(haystack)) {
    failures.push(message);
  }
}

/** @param {string} databaseUrl @returns {Promise<LiveRunResult>} */
async function runLivePostgresSmoke(databaseUrl) {
  try {
    const sqlContent = buildLiveSmokeSql();
    const result = /** @type {CommandResult} */ (
      await run("psql", ["--set", "ON_ERROR_STOP=1", "--dbname", databaseUrl], sqlContent)
    );
    if (result.code !== 0) {
      return {
        status: "failed",
        error: redactDatabaseUrl(result.stderr || result.stdout || `psql exited ${result.code}`),
      };
    }

    return {
      status: "passed",
      tenantTablesChecked: tenantTables.length,
      mode: "transaction-rollback",
      stdout: result.stdout.trim().split("\n").filter(Boolean).slice(-3),
    };
  } catch (error) {
    return { status: "failed", error: redactDatabaseUrl(error.message) };
  }
}

function buildLiveSmokeSql() {
  // Expected row count per tenant for each table (from the seed inserts below)
  const expectedPerTenant = {
    users: 3, // learner, teacher, scholar
    consent_records: 1,
    recitation_sessions: 1,
    audio_chunks: 1,
    word_alignments: 1,
    tajweed_findings: 1,
    teacher_reviews: 1,
    scholar_approvals: 1,
    agent_runs: 1,
    realtime_session_tickets: 1,
    realtime_ticket_replay_claims: 1,
    alignment_runs: 1,
    learner_progress: 1,
    privacy_jobs: 1,
    audit_events: 1,
    eval_runs: 1,
    pilot_invitations: 1,
    pilot_sessions: 1,
    background_jobs: 1,
    device_enrollment_invitations: 1,
    device_sessions: 1,
  };

  const requiredVisibleChecks = tenantTables
    .map(
      (table) => `
do $$
declare
  visible_count integer;
begin
  set local app.bypass_rls = 'off';
  set local app.tenant_id = 'tenant-a';
  select count(*) into visible_count from ${table};
  if visible_count <> ${expectedPerTenant[table] ?? 1} then
    raise exception '${table} visible count under tenant-a expected ${expectedPerTenant[table] ?? 1}, got %', visible_count;
  end if;

  set local app.tenant_id = 'tenant-b';
  select count(*) into visible_count from ${table};
  if visible_count <> ${expectedPerTenant[table] ?? 1} then
    raise exception '${table} visible count under tenant-b expected ${expectedPerTenant[table] ?? 1}, got %', visible_count;
  end if;
end $$;`,
    )
    .join("\n");

  // The live smoke never replays schema SQL. A migrated database is a precondition, and
  // missing/drifted objects must fail rather than being repaired inside a rolled-back test.
  // The temporary non-login role exists only to prove RLS as a non-superuser.
  const grantRlsRole = `do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'quran_ai_rls_test') then
    create role quran_ai_rls_test nologin;
  end if;
end $$;
grant usage on schema public to quran_ai_rls_test;
${tenantTables.map((t) => `grant select, insert, update, delete on ${t} to quran_ai_rls_test;`).join("\n")}`;

  return `
begin;
set local app.bypass_rls = 'on';

insert into institutions (id, name, region) values
  ('tenant-a', 'Tenant A', 'test'),
  ('tenant-b', 'Tenant B', 'test');

insert into users (id, tenant_id, display_name, role, language) values
  ('learner-a', 'tenant-a', 'Learner A', 'learner', 'ckb'),
  ('teacher-a', 'tenant-a', 'Teacher A', 'teacher', 'ckb'),
  ('scholar-a', 'tenant-a', 'Scholar A', 'scholar', 'ckb'),
  ('learner-b', 'tenant-b', 'Learner B', 'learner', 'ckb'),
  ('teacher-b', 'tenant-b', 'Teacher B', 'teacher', 'ckb'),
  ('scholar-b', 'tenant-b', 'Scholar B', 'scholar', 'ckb');

insert into model_versions (id, kind, version, status)
values ('qrai-smoke-model-v0.3', 'alignment', '0.3', 'eval-passed');

insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id) values
  ('audit-a', 'tenant-a', 'learner-a', 'smoke.seed', 'seed', 'tenant-a'),
  ('audit-b', 'tenant-b', 'learner-b', 'smoke.seed', 'seed', 'tenant-b');

insert into background_jobs (
  id, tenant_id, kind, subject_id, actor_id, idempotency_key, payload, audit_event_id
) values
  ('job-a', 'tenant-a', 'session.finalize', 'session-a', 'learner-a', 'smoke-a', '{}', 'audit-a'),
  ('job-b', 'tenant-b', 'session.finalize', 'session-b', 'learner-b', 'smoke-b', '{}', 'audit-b');

insert into consent_records (id, tenant_id, user_id, audio_retention, anonymized_learning, external_asr_processing, guardian_approved, audit_event_id) values
  ('consent-a', 'tenant-a', 'learner-a', 'discard', true, true, true, 'audit-a'),
  ('consent-b', 'tenant-b', 'learner-b', 'discard', true, true, true, 'audit-b');

	insert into recitation_sessions (
	  id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode, practice_plan_id,
	  external_processing_allowed, confidence, review_status, started_at, latency_ms, consent_record_id, consent_snapshot, audit_event_id
	) values
	  ('session-a', 'tenant-a', 'learner-a', '{"surahNumber":1,"ayahStart":1,"ayahEnd":1}', 'checksum-a', 'qrai-smoke-model-v0.3', 'guided-recite', 'plan-a', true, 0, 'teacher-review-required', now(), 0, 'consent-a', '{"externalAsrProcessing":true}', 'audit-a'),
	  ('session-b', 'tenant-b', 'learner-b', '{"surahNumber":1,"ayahStart":1,"ayahEnd":1}', 'checksum-b', 'qrai-smoke-model-v0.3', 'guided-recite', 'plan-b', true, 0, 'draft', now(), 0, 'consent-b', '{"externalAsrProcessing":true}', 'audit-b');

insert into realtime_ticket_replay_claims
  (tenant_id, session_id, nonce_hash, expires_at_unix_seconds) values
  ('tenant-a', 'session-a', repeat('1', 64), floor(extract(epoch from clock_timestamp())) + 300),
  ('tenant-b', 'session-b', repeat('2', 64), floor(extract(epoch from clock_timestamp())) + 300);

	insert into learner_progress (tenant_id, learner_id, ayah_ref, easiness_factor, interval_days, repetitions, last_quality, next_review_at) values
	  ('tenant-a', 'learner-a', '1:1', 2.5, 1, 1, 5, now() + interval '1 day'),
	  ('tenant-b', 'learner-b', '1:1', 2.5, 1, 1, 5, now() + interval '1 day');

insert into realtime_session_tickets (id, tenant_id, session_id, learner_id, token_hash, expires_at, allowed_sample_rates, external_asr_processing, audit_event_id) values
  ('ticket-a', 'tenant-a', 'session-a', 'learner-a', 'hash-a', now() + interval '5 minutes', array[16000], true, 'audit-a'),
  ('ticket-b', 'tenant-b', 'session-b', 'learner-b', 'hash-b', now() + interval '5 minutes', array[16000], true, 'audit-b');

insert into audio_chunks (id, tenant_id, session_id, evidence_id, start_ms, end_ms, sample_rate, status, object_key, audit_event_id) values
  ('chunk-a', 'tenant-a', 'session-a', 'evidence-a', 0, 100, 16000, 'queued', 'tenant-a/audio.wav', 'audit-a'),
  ('chunk-b', 'tenant-b', 'session-b', 'evidence-b', 0, 100, 16000, 'queued', 'tenant-b/audio.wav', 'audit-b');

insert into word_alignments (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status, model_version_id, audit_event_id) values
  ('alignment-a', 'tenant-a', 'session-a', '1:1:1', 'bism', 0, 100, 0.95, 'matched', 'qrai-smoke-model-v0.3', 'audit-a'),
  ('alignment-b', 'tenant-b', 'session-b', '1:1:1', 'bism', 0, 100, 0.95, 'matched', 'qrai-smoke-model-v0.3', 'audit-b');

insert into alignment_runs (id, tenant_id, session_id, model_version_id, dataset_version, latency_ms, evidence_ids, consent_snapshot, audit_event_id) values
  ('run-a', 'tenant-a', 'session-a', 'qrai-smoke-model-v0.3', 'smoke', 10, '["evidence-a"]', '{"externalAsrProcessing":true}', 'audit-a'),
  ('run-b', 'tenant-b', 'session-b', 'qrai-smoke-model-v0.3', 'smoke', 10, '["evidence-b"]', '{"externalAsrProcessing":true}', 'audit-b');

insert into tajweed_findings (
  id, tenant_id, alignment_id, rule, severity, confidence, analysis_basis, explanation,
  review_status, source_refs, model_version_id, audit_event_id
) values
  ('finding-a', 'tenant-a', 'alignment-a', 'madd', 'practice', null, 'text-rule', 'source-backed', 'ai-suggested', '[{"id":"source-a"}]', 'qrai-smoke-model-v0.3', 'audit-a'),
  ('finding-b', 'tenant-b', 'alignment-b', 'madd', 'practice', null, 'text-rule', 'source-backed', 'ai-suggested', '[{"id":"source-b"}]', 'qrai-smoke-model-v0.3', 'audit-b');

insert into teacher_reviews (id, tenant_id, finding_id, teacher_id, decision, note, audit_event_id) values
  ('review-a', 'tenant-a', 'finding-a', 'teacher-a', 'accepted', 'ok', 'audit-a'),
  ('review-b', 'tenant-b', 'finding-b', 'teacher-b', 'accepted', 'ok', 'audit-b');

insert into scholar_approvals (id, tenant_id, topic, reviewer_id, status, risk, source_refs, audit_event_id) values
  ('approval-a', 'tenant-a', 'topic-a', 'scholar-a', 'scholar-approved', 'low', '[{"id":"source-a"}]', 'audit-a'),
  ('approval-b', 'tenant-b', 'topic-b', 'scholar-b', 'scholar-approved', 'low', '[{"id":"source-b"}]', 'audit-b');

insert into agent_runs (id, tenant_id, name, goal, status, confidence, review_status, source_refs, trace, audit_event_id) values
  ('agent-a', 'tenant-a', 'agent', 'goal', 'approved', 0.9, 'scholar-approved', '[{"id":"source-a"}]', '{}', 'audit-a'),
  ('agent-b', 'tenant-b', 'agent', 'goal', 'approved', 0.9, 'scholar-approved', '[{"id":"source-b"}]', '{}', 'audit-b');

insert into privacy_jobs (id, tenant_id, learner_id, kind, included_records, deleted_records, audio_object_keys_deleted, audit_event_id) values
  ('privacy-a', 'tenant-a', 'learner-a', 'export', '["session-a"]', '[]', '[]', 'audit-a'),
  ('privacy-b', 'tenant-b', 'learner-b', 'export', '["session-b"]', '[]', '[]', 'audit-b');

insert into eval_runs (id, tenant_id, model_version_id, dataset_version, metrics, word_alignment_f1, tajweed_f1, false_positive_rate, teacher_agreement_rate, unsourced_learner_outputs, passed) values
  ('eval-a', 'tenant-a', 'qrai-smoke-model-v0.3', 'smoke', '{}', 0.95, 0.85, 0.05, 0.95, 0, true),
  ('eval-b', 'tenant-b', 'qrai-smoke-model-v0.3', 'smoke', '{}', 0.95, 0.85, 0.05, 0.95, 0, true);

insert into pilot_invitations (id, tenant_id, learner_id, token_hash, expires_at, consumed_at) values
  ('invite-a', 'tenant-a', 'learner-a', 'hash-invite-a', now() + interval '1 day', null),
  ('invite-b', 'tenant-b', 'learner-b', 'hash-invite-b', now() + interval '1 day', null);

insert into pilot_sessions (id, tenant_id, learner_id, token_hash, csrf_token, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at) values
  ('session-cookie-a', 'tenant-a', 'learner-a', 'hash-session-cookie-a', 'csrf-a', now(), now(), now() + interval '1 day', now() + interval '1 day', null),
  ('session-cookie-b', 'tenant-b', 'learner-b', 'hash-session-cookie-b', 'csrf-b', now(), now(), now() + interval '1 day', now() + interval '1 day', null);

insert into device_enrollment_invitations
  (id, tenant_id, user_id, created_by, token_hash, expires_at, audit_event_id) values
  ('device-invite-a', 'tenant-a', 'learner-a', 'learner-a', repeat('a', 64), now() + interval '1 day', 'audit-a'),
  ('device-invite-b', 'tenant-b', 'learner-b', 'learner-b', repeat('b', 64), now() + interval '1 day', 'audit-b');

insert into device_sessions
  (id, family_id, tenant_id, user_id, generation, access_token_hash, refresh_token_hash,
   status, access_expires_at, idle_expires_at, absolute_expires_at, audit_event_id) values
  ('device-session-a', 'device-family-a', 'tenant-a', 'learner-a', 0, repeat('c', 64), repeat('d', 64),
   'active', now() + interval '15 minutes', now() + interval '7 days', now() + interval '30 days', 'audit-a'),
  ('device-session-b', 'device-family-b', 'tenant-b', 'learner-b', 0, repeat('e', 64), repeat('f', 64),
   'active', now() + interval '15 minutes', now() + interval '7 days', now() + interval '30 days', 'audit-b');

	${grantRlsRole}

-- Run RLS visibility checks as a non-superuser role (superusers bypass RLS)
set role quran_ai_rls_test;

-- Restricted roles must not be able to opt into the maintenance bypass GUC.
set local app.bypass_rls = 'on';
set local app.tenant_id = 'tenant-a';
do $$
declare
  visible_count integer;
begin
  select count(*) into visible_count from users;
  if visible_count <> 3 then
    raise exception 'restricted role bypassed tenant RLS via app.bypass_rls; expected 3 users, got %', visible_count;
  end if;
end $$;

${requiredVisibleChecks}

set local app.bypass_rls = 'off';
set local app.tenant_id = 'tenant-a';
do $$
begin
	  insert into recitation_sessions (
	    id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode, practice_plan_id,
	    external_processing_allowed, confidence, review_status, started_at, latency_ms, consent_record_id, consent_snapshot, audit_event_id
	  ) values (
	    'session-cross-tenant', 'tenant-b', 'learner-b', '{"surahNumber":1,"ayahStart":1,"ayahEnd":1}',
	    'checksum-cross', 'qrai-smoke-model-v0.3', 'guided-recite', 'plan-cross', true, 0, 'draft', now(), 0, 'consent-b',
	    '{"externalAsrProcessing":true}', 'audit-b'
	  );
  raise exception 'cross-tenant insert unexpectedly succeeded';
exception
  when insufficient_privilege or check_violation or with_check_option_violation then
    null;
end $$;

reset role;

rollback;
`;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string | undefined} stdinContent
 * @returns {Promise<CommandResult>}
 */
function run(command, args, stdinContent) {
  let finalCommand = command;
  let finalArgs = args;
  if (command === "psql" && process.env.PSQL) {
    const parts = process.env.PSQL.split(" ");
    finalCommand = parts[0];
    const rewrittenArgs = args.map((arg) => arg.replace("localhost:5433", "localhost:5432"));
    finalArgs = [...parts.slice(1), ...rewrittenArgs];
  }
  return /** @type {Promise<CommandResult>} */ (new Promise((resolve, reject) => {
    const child = spawn(finalCommand, finalArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: [stdinContent ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = /** @type {string[]} */ ([]);
    const stderr = /** @type {string[]} */ ([]);
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") }));
    if (stdinContent && child.stdin) {
      child.stdin.on("error", (error) => {
        if (!("code" in error) || error.code !== "EPIPE") reject(error);
      });
      child.stdin.end(stdinContent);
    }
  }));
}

/** @param {string} value */
function redactDatabaseUrl(value) {
  return value.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}
