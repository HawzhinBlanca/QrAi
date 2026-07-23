import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

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
  "alignment_runs",
  "learner_progress",
  "privacy_jobs",
  "audit_events",
  "eval_runs",
  "pilot_invitations",
  "pilot_sessions",
];

const coreSchemaPaths = [
  join("infra", "sql", "0001_core_schema.sql"),
  join("infra", "sql", "0005_learner_progress.sql"),
  join("infra", "sql", "0018_agent_run_learner_id.sql"),
  join("infra", "sql", "0021_pilot_identity.sql"),
];
const sessionMigrationPath = join("infra", "sql", "0008_session_language.sql");
const reviewStatusMigrationPaths = [
  join("infra", "sql", "0010_review_status_check.sql"),
  join("infra", "sql", "0011_teacher_review_required_status.sql"),
];
const rlsPaths = [
  join("infra", "sql", "0003_tenant_rls.sql"),
  join("infra", "sql", "0009_learner_progress_rls.sql"),
  join("infra", "sql", "0012_superuser_only_rls_bypass.sql"),
  join("infra", "sql", "0021_pilot_identity.sql"),
];
const coreSchemaRaw = (await Promise.all(coreSchemaPaths.map((path) => readFile(path, "utf8")))).join("\n");
const sessionMigrationRaw = await readFile(sessionMigrationPath, "utf8");
const reviewStatusMigrationRaw = (await Promise.all(reviewStatusMigrationPaths.map((path) => readFile(path, "utf8")))).join("\n");
const rlsSchemaRaw = (await Promise.all(rlsPaths.map((path) => readFile(path, "utf8")))).join("\n");
const coreSchema = normalizeSql(coreSchemaRaw);
const reviewStatusSchema = normalizeSql(reviewStatusMigrationRaw);
const rlsSchema = normalizeSql(rlsSchemaRaw);
const pilotIdentitySchema = normalizeSql(await readFile(join("infra", "sql", "0021_pilot_identity.sql"), "utf8"));
const postgresUrl = process.env.POSTGRES_RLS_SMOKE_URL ?? process.env.DATABASE_URL;
const requireLive = process.env.SQL_SMOKE_REQUIRE_LIVE === "true";

const failures = [];

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
assertIncludes(
  reviewStatusSchema,
  "teacher-review-required",
  "review status constraint must allow teacher-review-required",
);

let live = { status: postgresUrl ? "pending" : "skipped", reason: postgresUrl ? undefined : "POSTGRES_RLS_SMOKE_URL or DATABASE_URL not set" };

if (postgresUrl) {
  live = await runLivePostgresSmoke(postgresUrl);
  if (live.status !== "passed") {
    failures.push(`live Postgres RLS smoke failed: ${live.error}`);
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

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle.toLowerCase())) {
    failures.push(message);
  }
}

function assertRegex(haystack, regex, message) {
  if (!regex.test(haystack)) {
    failures.push(message);
  }
}

async function runLivePostgresSmoke(databaseUrl) {
  try {
    const sqlContent = buildLiveSmokeSql();
    const result = await run("psql", ["--set", "ON_ERROR_STOP=1", "--dbname", databaseUrl], sqlContent);
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
    alignment_runs: 1,
    learner_progress: 1,
    privacy_jobs: 1,
    audit_events: 1,
    eval_runs: 1,
    pilot_invitations: 1,
    pilot_sessions: 1,
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

  // Wrap schema creation with IF NOT EXISTS to handle pre-existing tables and indexes
  const coreSchemaSafe = coreSchemaRaw
    .replace(/^create table (?!if not exists )/gim, "create table if not exists ")
    .replace(/^create index (?!if not exists )/gim, "create index if not exists ");
  const sessionMigrationSafe = sessionMigrationRaw;
  const reviewStatusMigrationSafe = reviewStatusMigrationRaw;
  // Drop existing policies before recreating to avoid duplicate policy errors
  const dropPolicies = tenantTables
    .map((t) => `drop policy if exists tenant_isolation_${t} on ${t};`)
    .join("\n");
  // Make the non-superuser RLS test role self-contained: ensure it exists and is granted
  // every tenant table (learner_progress was added after the role was first bootstrapped).
  const grantRlsRole = `do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'quran_ai_rls_test') then
    create role quran_ai_rls_test nologin;
  end if;
end $$;
grant usage on schema public to quran_ai_rls_test;
${tenantTables.map((t) => `grant select, insert, update, delete on ${t} to quran_ai_rls_test;`).join("\n")}`;
  const rlsSchemaSafe = rlsSchemaRaw;

  return `
begin;
set local app.bypass_rls = 'on';

	${coreSchemaSafe}
	${sessionMigrationSafe}
	${reviewStatusMigrationSafe}
	${dropPolicies}
	${rlsSchemaSafe}

	-- Clean up ALL existing data from all tables (transaction will roll back)
	-- This is necessary because API smoke tests create records that block FK deletes
	delete from learner_progress;
	delete from privacy_jobs;
delete from agent_runs;
delete from scholar_approvals;
delete from teacher_reviews;
delete from tajweed_findings;
delete from alignment_runs;
delete from word_alignments;
delete from audio_chunks;
delete from realtime_session_tickets;
delete from recitation_sessions;
delete from consent_records;
delete from eval_runs;
delete from canonical_words;
delete from canonical_ayahs;
delete from audit_events;
delete from model_versions;
delete from users;
delete from institutions;

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

insert into canonical_ayahs (id, surah_number, ayah_number, text_uthmani, source_id, edition, script_type, import_version, source_checksum)
values ('ayah-1-1', 1, 1, 'bismillah', 'tanzil', 'uthmani', 'uthmani', 'smoke', 'checksum-ayah');

insert into canonical_words (id, ayah_id, word_index, text_uthmani, source_checksum)
values ('word-1-1-1', 'ayah-1-1', 1, 'bism', 'checksum-word');

insert into model_versions (id, kind, version, status)
values ('model-v0.3', 'alignment', '0.3', 'eval-passed');

insert into audit_events (id, tenant_id, actor_id, action, subject_type, subject_id) values
  ('audit-a', 'tenant-a', 'learner-a', 'smoke.seed', 'seed', 'tenant-a'),
  ('audit-b', 'tenant-b', 'learner-b', 'smoke.seed', 'seed', 'tenant-b');

insert into consent_records (id, tenant_id, user_id, audio_retention, anonymized_learning, external_asr_processing, guardian_approved, audit_event_id) values
  ('consent-a', 'tenant-a', 'learner-a', 'discard', true, true, true, 'audit-a'),
  ('consent-b', 'tenant-b', 'learner-b', 'discard', true, true, true, 'audit-b');

	insert into recitation_sessions (
	  id, tenant_id, learner_id, quran_ref, source_checksum, model_version_id, mode, practice_plan_id,
	  external_processing_allowed, confidence, review_status, started_at, latency_ms, consent_record_id, consent_snapshot, audit_event_id
	) values
	  ('session-a', 'tenant-a', 'learner-a', '{"surahNumber":1,"ayahStart":1,"ayahEnd":1}', 'checksum-a', 'model-v0.3', 'guided-recite', 'plan-a', true, 0, 'teacher-review-required', now(), 0, 'consent-a', '{"externalAsrProcessing":true}', 'audit-a'),
	  ('session-b', 'tenant-b', 'learner-b', '{"surahNumber":1,"ayahStart":1,"ayahEnd":1}', 'checksum-b', 'model-v0.3', 'guided-recite', 'plan-b', true, 0, 'draft', now(), 0, 'consent-b', '{"externalAsrProcessing":true}', 'audit-b');

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
  ('alignment-a', 'tenant-a', 'session-a', 'word-1-1-1', 'bism', 0, 100, 0.95, 'matched', 'model-v0.3', 'audit-a'),
  ('alignment-b', 'tenant-b', 'session-b', 'word-1-1-1', 'bism', 0, 100, 0.95, 'matched', 'model-v0.3', 'audit-b');

insert into alignment_runs (id, tenant_id, session_id, model_version_id, dataset_version, latency_ms, evidence_ids, consent_snapshot, audit_event_id) values
  ('run-a', 'tenant-a', 'session-a', 'model-v0.3', 'smoke', 10, '["evidence-a"]', '{"externalAsrProcessing":true}', 'audit-a'),
  ('run-b', 'tenant-b', 'session-b', 'model-v0.3', 'smoke', 10, '["evidence-b"]', '{"externalAsrProcessing":true}', 'audit-b');

insert into tajweed_findings (id, tenant_id, alignment_id, rule, severity, confidence, explanation, review_status, source_refs, model_version_id, audit_event_id) values
  ('finding-a', 'tenant-a', 'alignment-a', 'madd', 'practice', 0.9, 'source-backed', 'ai-suggested', '[{"id":"source-a"}]', 'model-v0.3', 'audit-a'),
  ('finding-b', 'tenant-b', 'alignment-b', 'madd', 'practice', 0.9, 'source-backed', 'ai-suggested', '[{"id":"source-b"}]', 'model-v0.3', 'audit-b');

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
  ('eval-a', 'tenant-a', 'model-v0.3', 'smoke', '{}', 0.95, 0.85, 0.05, 0.95, 0, true),
  ('eval-b', 'tenant-b', 'model-v0.3', 'smoke', '{}', 0.95, 0.85, 0.05, 0.95, 0, true);

insert into pilot_invitations (id, tenant_id, learner_id, token_hash, expires_at, consumed_at) values
  ('invite-a', 'tenant-a', 'learner-a', 'hash-invite-a', now() + interval '1 day', null),
  ('invite-b', 'tenant-b', 'learner-b', 'hash-invite-b', now() + interval '1 day', null);

insert into pilot_sessions (id, tenant_id, learner_id, token_hash, csrf_token, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at) values
  ('session-cookie-a', 'tenant-a', 'learner-a', 'hash-session-cookie-a', 'csrf-a', now(), now(), now() + interval '1 day', now() + interval '1 day', null),
  ('session-cookie-b', 'tenant-b', 'learner-b', 'hash-session-cookie-b', 'csrf-b', now(), now(), now() + interval '1 day', now() + interval '1 day', null);

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
	    'checksum-cross', 'model-v0.3', 'guided-recite', 'plan-cross', true, 0, 'draft', now(), 0, 'consent-b',
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

function run(command, args, stdinContent) {
  let finalCommand = command;
  let finalArgs = args;
  if (command === "psql" && process.env.PSQL) {
    const parts = process.env.PSQL.split(" ");
    finalCommand = parts[0];
    const rewrittenArgs = args.map(arg => arg.replace("localhost:5433", "localhost:5432"));
    finalArgs = [...parts.slice(1), ...rewrittenArgs];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(finalCommand, finalArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: [stdinContent ? "pipe" : "ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") }));
    if (stdinContent) {
      child.stdin.write(stdinContent);
      child.stdin.end();
    }
  });
}

function redactDatabaseUrl(value) {
  return value.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1[REDACTED]@");
}
