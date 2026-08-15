import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { queryJson } from "../api-parity/lib/harness.mjs";

/**
 * Every place the database can point at a person must have a stated answer for what erasure does.
 *
 * `docs/DATA_INVENTORY.md` §2 lists the personal-data categories and §4 lists the erasure cascade.
 * The two are maintained by hand, side by side, in the same file — and **Account** appears in §2 and
 * in no part of §4. Measured against a live erasure (200 OK, ml-inference running): the learner's
 * `display_name`, `email` and `password_hash` are byte-identical before and after. ADR-0045 poses
 * that question; this guard is what stops the NEXT one from being silent.
 *
 * ── The two lists ───────────────────────────────────────────────────────────────────────────────
 * A: every foreign key referencing `users(id)`, read from the live schema — so a new table linking
 *    to a person appears here the moment it is created, without anyone remembering to add it.
 * B: every `DELETE FROM <table>` in the erasure handler, read from its source.
 *
 * A column in A and not in B must be declared below with a reason. There is no way to have a table
 * that can identify a person and no recorded position on erasing it.
 *
 * ── Why a declaration and not "everything must be deleted" ──────────────────────────────────────
 * Three of these genuinely must not be deleted, and a guard that demanded it would be wrong:
 * `audit_events` and `privacy_jobs` are the RECORD that the erasure happened, and two columns hold a
 * staff actor rather than the subject. The honest invariant is not "delete everything" but "say what
 * you do, per column, and be checked on it".
 *
 * Requires a live Postgres: list A comes from the real schema, which is the entire point. A
 * hand-written list would drift the moment a migration lands.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HANDLER = join(root, "services/platform-api/src/handlers/privacy.rs");

/** Minimum length for a reason, so "n/a" cannot pass as an argument. Mirrors the P2.6 matrix rule. */
const MIN_REASON = 40;

/**
 * The recorded position for every `users` reference the cascade does not delete by.
 *
 * `erased` is not listed: that is derived from the handler, so it cannot be claimed here without
 * being true.
 */
const DECLARED = {
  "audit_events.actor_id": {
    disposition: "retained",
    why:
      "the audit trail is the record that the erasure happened; deleting it would destroy the " +
      "evidence the learner's request was honoured. ADR-0040 holds the open question of whether " +
      "a verified erasure should purge prior audit rows.",
  },
  "privacy_jobs.learner_id": {
    disposition: "retained",
    why:
      "the erasure receipt itself, written by the request being erased. Deleting it would delete " +
      "the proof, and privacy.rs:56 records why the durable record must survive a retry.",
  },
  "scholar_approvals.reviewer_id": {
    disposition: "staff",
    why:
      "holds the scholar who approved a rule, never the learner whose data is being erased; a " +
      "learner is not a reviewer and erasing one must not withdraw another person's approval.",
  },
  "teacher_reviews.teacher_id": {
    disposition: "staff",
    why:
      "holds the teacher who made the decision. The cascade DOES delete teacher_reviews, scoped " +
      "by the learner's findings rather than by this column, so the subject's reviews go and " +
      "other learners' reviews stay (privacy_delete_preserves_other_learners_teacher_reviews).",
  },
  "users.id": {
    disposition: "retained",
    why:
      "the account row survives an erasure with display_name, email and password_hash intact — " +
      "reproduced against a live erasure. Whether 'delete my data' means 'delete my account' is a " +
      "DPO/product ruling, not an engineering default: ADR-0045.",
  },
};

/** List A — every FK into `users`, from the live schema, plus the identity table itself. */
async function personReferences() {
  const rows = await queryJson(`
    SELECT tc.table_name AS t, kcu.column_name AS c
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND ccu.table_name = 'users'
       AND tc.table_schema = 'public'`);
  const refs = rows.map((r) => `${r.t}.${r.c}`);
  // `users` has no FK to itself, so it would be invisible to the query above — which is exactly how
  // the account row came to have no stated disposition in the first place.
  refs.push("users.id");
  return [...new Set(refs)].sort();
}

/** List B — every table the erasure handler deletes from, read from its source. */
function tablesTheCascadeDeletes() {
  const src = readFileSync(HANDLER, "utf8");
  const named = new Set();
  for (const m of src.matchAll(/DELETE\s+FROM\s+([a-z_]+)/gi)) named.add(m[1].toLowerCase());
  // The handler also deletes session-owned rows through a formatted loop over a table list.
  for (const m of src.matchAll(/for\s+table\s+in\s+\[([^\]]*)\]/g)) {
    for (const t of m[1].matchAll(/"([a-z_]+)"/g)) named.add(t[1]);
  }
  return named;
}

test("both lists are non-empty, so this is measuring something", async () => {
  // Without this, a failed query or a moved handler would yield two empty sets that agree perfectly
  // and report that every personal-data reference is accounted for.
  const refs = await personReferences();
  assert.ok(
    refs.length >= 10,
    `only ${refs.length} references to users(id) found — the schema query is broken, not the schema`,
  );
  const deleted = tablesTheCascadeDeletes();
  assert.ok(
    deleted.size >= 8,
    `parsed only ${deleted.size} DELETE targets out of privacy.rs — fix this parser, do not delete ` +
      `the check. Found: ${[...deleted].join(", ")}`,
  );
});

test("every reference to a person is either erased or declared, with a reason", async () => {
  const deleted = tablesTheCascadeDeletes();
  const undeclared = [];

  for (const ref of await personReferences()) {
    const table = ref.split(".")[0];
    const declaration = DECLARED[ref];

    if (deleted.has(table) && !declaration) continue; // erased by the cascade; nothing to declare
    if (!declaration) {
      undeclared.push(
        `${ref} — the erasure cascade does not delete from ${table} and nothing here says why. ` +
          `A table that can identify a person needs a recorded position: erased, retained (with a ` +
          `reason), or staff-only.`,
      );
      continue;
    }
    if (!["retained", "staff"].includes(declaration.disposition)) {
      undeclared.push(`${ref} — unknown disposition ${JSON.stringify(declaration.disposition)}`);
    }
    if ((declaration.why ?? "").length < MIN_REASON) {
      undeclared.push(
        `${ref} — reason is ${declaration.why?.length ?? 0} chars, need ${MIN_REASON}. ` +
          `"Not applicable" without an argument is an unerased table wearing a different label.`,
      );
    }
  }

  assert.deepEqual(
    undeclared,
    [],
    `personal-data references with no recorded erasure position:\n  ${undeclared.join("\n  ")}`,
  );
});

test("no declaration names a reference the schema no longer has", async () => {
  // The reverse direction. A stale declaration is worse than none: it reads as a considered
  // decision about a table that no longer exists, while a real new table goes unnoticed beside it.
  const refs = new Set(await personReferences());
  const stale = Object.keys(DECLARED).filter((ref) => !refs.has(ref));
  assert.deepEqual(stale, [], `declarations for references that are gone from the schema:\n  ${stale.join("\n  ")}`);
});

test("the account question is on the record, not only in this file", async () => {
  // A guard whose reason lives only in the guard is a rule nobody can argue with. If ADR-0045 is
  // decided, `users.id` needs an implementation and a different declaration — this fails first.
  const adrs = readFileSync(join(root, "docs/DECISIONS.md"), "utf8");
  assert.match(adrs, /## ADR-0045 —/, "ADR-0045 is gone, so the retained account row has no recorded reason");
  assert.match(
    adrs.slice(adrs.indexOf("## ADR-0045 —")),
    /\*\*Status:\*\* Proposed/,
    "ADR-0045 is no longer Proposed — if the ruling was made, users.id needs code, not a declaration",
  );
});

test("the data inventory still describes the cascade it actually runs", async () => {
  // §4 of DATA_INVENTORY.md names the cascade in prose. Prose drifts; this pins the naming to the
  // handler so the document cannot quietly describe a deletion that stopped happening.
  // Normalised on both sides: §4 is prose and legitimately writes "consent records" for
  // `consent_records`. Requiring the exact identifier would be a documentation style rule wearing a
  // privacy check's clothing. It still catches a table the prose never names at all — which is how
  // `realtime_session_tickets` was found being described only as "tickets".
  const flatten = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  const doc = flatten(readFileSync(join(root, "docs/DATA_INVENTORY.md"), "utf8"));
  const missing = [...tablesTheCascadeDeletes()].filter((t) => !doc.includes(flatten(t)));
  assert.deepEqual(
    missing,
    [],
    `the erasure deletes from these and DATA_INVENTORY.md never mentions them:\n  ${missing.join("\n  ")}`,
  );
});
