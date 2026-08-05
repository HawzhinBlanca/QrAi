import assert from "node:assert/strict";
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
