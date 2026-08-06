import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadOpenapi } from "./lib/openapi.mjs";

/**
 * The THIRD leg of the enum contract: the database CHECK constraints.
 *
 * `enum-parity.test.mjs` ties the OpenAPI contract to `types.rs`, and does it carefully — it even
 * refuses to pass if `types.rs` failed to parse. But it reads two files and no database, and the
 * closed set of these enums is not owned by either of them. It is owned by the CHECK constraint:
 * that is the only place a bad value is actually refused, at 3am, in production, whatever the
 * services believe.
 *
 * ── This has already gone wrong once ────────────────────────────────────────────────────────────
 * `infra/sql/0010_review_status_check.sql` constrains `recitation_sessions.review_status` to FIVE
 * values, omitting `teacher-review-required`, under a comment saying it "matches ReviewStatus in
 * the platform-api types". It did not. `infra/sql/0011_teacher_review_required_status.sql` exists
 * for no other reason than to add the missing value — an entire migration whose existence is the
 * bug report.
 *
 * Every gate in this repository was green through all of that, because none of them read the
 * constraint. That is what this file is for.
 *
 * Needs a live Postgres, so it runs in verify.sh's DB-gated block rather than with the hermetic
 * contract tests it otherwise belongs beside.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const spec = loadOpenapi(join(repoRoot, "specs/flutter-client/openapi.yaml"));

const DATABASE_URL = process.env.DATABASE_URL;

/** Every CHECK constraint on `table` that mentions `column`, as the set of literals it allows. */
async function allowedValues(client, table, column) {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.contype = 'c'`,
    [table],
  );
  const matching = rows.map((r) => r.def).filter((def) => def.includes(column));

  // Fail CLOSED, loudly. A dropped constraint produces no rows here, and a test that treated that
  // as "nothing to compare" would go green at the exact moment the enum stopped being enforced at
  // all — which is the failure this file exists to catch, not one to reproduce inside it.
  assert.ok(
    matching.length > 0,
    `no CHECK constraint on ${table}.${column} — the closed set is not enforced by the database`,
  );
  assert.equal(
    matching.length,
    1,
    `${table}.${column} has ${matching.length} CHECK constraints; which one is authoritative is ambiguous`,
  );

  const literals = [...matching[0].matchAll(/'([^']*)'::text/g)].map((m) => m[1]);
  assert.ok(literals.length > 0, `could not parse any values out of: ${matching[0]}`);
  return literals.sort();
}

const contractEnum = (schema, property) => {
  const values = spec.components?.schemas?.[schema]?.properties?.[property]?.enum;
  // The contract side gets the same treatment: if the enum vanished from the spec, every
  // comparison below would be against `undefined` and would need to fail, not pass.
  assert.ok(Array.isArray(values) && values.length > 0, `${schema}.${property} has no enum in the OpenAPI contract`);
  return [...values].sort();
};

const REVIEW_STATUS_TABLES = ["recitation_sessions", "tajweed_findings", "agent_runs"];

test("the database enforces exactly the review statuses the contract offers", async (t) => {
  if (!DATABASE_URL) return t.skip("no DATABASE_URL — this leg needs the live constraint");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const contract = contractEnum("RecitationSession", "reviewStatus");
    for (const table of REVIEW_STATUS_TABLES) {
      assert.deepEqual(
        await allowedValues(client, table, "review_status"),
        contract,
        `${table}.review_status and the contract disagree — a value one side accepts, the other refuses`,
      );
    }
  } finally {
    await client.end();
  }
});

test("all three review_status constraints agree with EACH OTHER", async (t) => {
  // Not implied by the test above once someone edits it: comparing each table to the contract
  // separately is how two tables end up individually "fixed" against different contract versions.
  // A finding that may be teacher-review-required while its session may not is incoherent state
  // the application has no way to represent.
  if (!DATABASE_URL) return t.skip("no DATABASE_URL — this leg needs the live constraint");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const [first, ...rest] = await Promise.all(
      REVIEW_STATUS_TABLES.map((table) => allowedValues(client, table, "review_status")),
    );
    for (const [index, values] of rest.entries()) {
      assert.deepEqual(
        values,
        first,
        `${REVIEW_STATUS_TABLES[index + 1]} allows a different set from ${REVIEW_STATUS_TABLES[0]}`,
      );
    }
  } finally {
    await client.end();
  }
});

test("the database enforces exactly the audio retentions the contract offers", async (t) => {
  // The one whose values decide how long a child's recorded voice is kept. A value the contract
  // offers but the database refuses is a 500 on a consent write; the reverse is a retention mode
  // nothing downstream knows how to honour.
  if (!DATABASE_URL) return t.skip("no DATABASE_URL — this leg needs the live constraint");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    assert.deepEqual(
      await allowedValues(client, "consent_records", "audio_retention"),
      contractEnum("Consent", "audioRetention"),
      "consent_records.audio_retention and the contract disagree",
    );
  } finally {
    await client.end();
  }
});

/**
 * The span a finding points at, enforced by the TABLE rather than by whoever wrote the row.
 *
 * `usable_span` (handlers/recitation.rs) and `usableSpan` (routes/session-writes.mjs) already refuse
 * an alignment that identifies no audio. Two implementations of one rule, and the whole theme of
 * this week's work is that two implementations agreeing proves nothing about a third — a migration,
 * a backfill, a fixture script, a psql session at 3am, or the next port. The CHECK constraint is the
 * only place the rule holds regardless of who is writing.
 *
 * `word_alignments` already had CHECK constraints on `confidence` (0..1), `status` and
 * `transcript_source`. It had none on the span, so `start_ms`/`end_ms` — the ONLY record of WHERE in
 * a recitation a word was heard, and what a tajweed finding is anchored to — accepted anything an
 * int4 could hold: negative, zero-length, inverted.
 *
 * These probe the constraint DIRECTLY with SQL, not through an API, because going through an API
 * would prove the application check works and say nothing about the table.
 */
/**
 * A tenant that actually owns alignments.
 *
 * DATABASE_URL connects as `quran_ai_app` — nosuperuser, nobypassrls, the production role — so every
 * tenant-owned row is invisible until `app.tenant_id` is set, exactly as `begin_tenant_tx` does it.
 * Probing without this returned zero rows and the control test read that as "the constraint refused
 * my insert", which would have been a false red for a real reason: RLS working.
 */
async function anyTenant(client) {
  const { rows } = await client.query("SELECT id FROM institutions ORDER BY id LIMIT 1");
  assert.ok(rows.length === 1, "no institution row — this probe needs a tenant to set RLS context to");
  return rows[0].id;
}

const UNUSABLE_SPANS_SQL = [
  ["zero-length", 500, 500],
  ["inverted", 900, 400],
  ["negative start", -1, 100],
  ["negative both", -50, -10],
];

test("the table itself refuses an alignment span that identifies no audio", async (t) => {
  if (!DATABASE_URL) return t.skip("no DATABASE_URL — this leg needs the live constraint");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // The constraint must EXIST. A behavioural probe alone would also pass if the insert were
    // refused for some unrelated reason (a NOT NULL, an FK), so name it first.
    const tenant = await anyTenant(client);
    const { rows: found } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'word_alignments'::regclass AND conname = $1`,
      ["word_alignments_span_identifies_audio"],
    );
    assert.equal(
      found.length,
      1,
      "word_alignments has no span CHECK constraint. It has one for confidence, status and " +
        "transcript_source; the span — the only thing saying WHERE a finding happened — had none.",
    );

    // Every write is inside a transaction that is rolled back, so this test never leaves a row
    // behind and never depends on one existing.
    for (const [label, startMs, endMs] of UNUSABLE_SPANS_SQL) {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      let refused = false;
      let detail = "";
      try {
        await client.query(
          `INSERT INTO word_alignments
             (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
              model_version_id, audit_event_id, transcript_source)
           SELECT 'wa-span-probe', wa.tenant_id, wa.session_id, wa.word_id, 'x', $1, $2, 0.9,
                  'matched', wa.model_version_id, wa.audit_event_id, 'client-reported'
           FROM word_alignments wa LIMIT 1`,
          [startMs, endMs],
        );
      } catch (err) {
        refused = true;
        detail = err.message;
      }
      await client.query("ROLLBACK");

      assert.ok(
        refused,
        `the table accepted a "${label}" span (${startMs} -> ${endMs}). A finding anchored to it ` +
          "points at no audio, and no application check can stop a writer that does not run one.",
      );
      assert.match(
        detail,
        /word_alignments_span_identifies_audio/,
        `"${label}" was refused, but by something other than the span constraint: ${detail}`,
      );
    }
  } finally {
    await client.end();
  }
});

test("and still accepts a real span — the control", async (t) => {
  if (!DATABASE_URL) return t.skip("no DATABASE_URL — this leg needs the live constraint");
  // Without this, every assertion above is satisfied by a constraint that refuses EVERYTHING, which
  // would silently end alignment capture rather than clean it up.
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [await anyTenant(client)]);
    const { rowCount } = await client.query(
      `INSERT INTO word_alignments
         (id, tenant_id, session_id, word_id, heard_text, start_ms, end_ms, confidence, status,
          model_version_id, audit_event_id, transcript_source)
       SELECT 'wa-span-probe-ok', wa.tenant_id, wa.session_id, wa.word_id, 'x', 640, 1230, 0.9,
              'matched', wa.model_version_id, wa.audit_event_id, 'client-reported'
       FROM word_alignments wa LIMIT 1`,
    );
    assert.equal(rowCount, 1, "a 640ms-to-1230ms span was refused; the constraint is too strict");
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
});

/**
 * The shared gate corpus must cover every review status the DATABASE can hold.
 *
 * `packages/contracts/fixtures/canonical-gates.json` is the one table four implementations of
 * `canShowLearnerFacingAiOutput` are now held to (#358, #370). Its value is entirely a function of
 * which cases are in it — and nothing checked that it covered the vocabulary it is deciding over.
 *
 * Measured when this was written: the CHECK constraint on `tajweed_findings.review_status` allows
 * six values and the corpus exercised five. The missing one was `blocked` — which is exactly what
 * `TeacherDecision::Rejected` produces (handlers/review.rs). So every gate implementation was
 * verified against a table with no case for "a teacher looked at this and said no", the single most
 * consequential outcome of the review workflow.
 *
 * Cross-referenced against `pg_constraint` rather than a list written here, for the same reason the
 * enum tests above are: a second hand-maintained copy of a closed set is a second thing to drift,
 * and the one that gets forgotten is always the checker.
 */
test("the learner-gate corpus covers every review status the database allows", async (t) => {
  if (!DATABASE_URL) return t.skip("no DATABASE_URL — this leg needs the live constraint");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const allowed = await allowedValues(client, "tajweed_findings", "review_status");

    const corpus = JSON.parse(
      readFileSync(
        join(here, "..", "..", "packages", "contracts", "fixtures", "canonical-gates.json"),
        "utf8",
      ),
    );
    const cases = corpus.canShowLearnerFacingAiOutput?.cases ?? [];
    assert.ok(cases.length > 0, "the corpus has no learner-gate cases at all");

    const covered = new Set(cases.map((c) => c.input?.reviewStatus).filter((s) => typeof s === "string"));
    const missing = allowed.filter((status) => !covered.has(status));

    assert.deepEqual(
      missing,
      [],
      `the corpus decides over review statuses it has never been shown: ${missing.join(", ")}.\n` +
        "Every implementation of the learner gate is verified against this table, so a status " +
        "missing from it is a status no implementation is checked on — including `blocked`, which " +
        "is what a teacher REJECTING a finding produces.",
    );

    // The corpus should not invent statuses either: a case for a value the database cannot hold
    // tests a situation that cannot occur, and reads as coverage.
    const invented = [...covered].filter((s) => s !== "" && !allowed.includes(s) && s !== "under-review");
    assert.deepEqual(
      invented,
      [],
      `the corpus has cases for statuses the database cannot store: ${invented.join(", ")}`,
    );
  } finally {
    await client.end();
  }
});
