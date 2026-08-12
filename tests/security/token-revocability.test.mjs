import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { queryJson } from "../api-parity/lib/harness.mjs";

/**
 * A token the system stores must be looked up before it is trusted, or say why it is not.
 *
 * Storing a token's hash is what makes it revocable: an erasure, a logout or a compromise can delete
 * the row, and the next request that presents the token finds nothing. That only holds if some code
 * path actually reads the column. A hash written and never read is a revocation record that revokes
 * nothing — and it looks exactly like one that does, in the schema, in the export, and in the
 * erasure cascade.
 *
 * ── What was measured ───────────────────────────────────────────────────────────────────────────
 * Three of the four token columns are looked up through a `SECURITY DEFINER` function before the
 * request is trusted. `realtime_session_tickets.token_hash` is looked up by nothing: platform-api
 * writes it (recitation.rs:514) and realtime-gateway — the only service that sees the ticket again —
 * has no database connection at all. The erasure's
 * `DELETE FROM realtime_session_tickets` therefore deletes a record, not an authorization.
 *
 * Reproduced against a real gateway and a real ml-inference (ADR-0047): an erasure completed and
 * reported success, then a ticket minted before it wrote the learner's audio back to disk.
 *
 * ── The two lists ───────────────────────────────────────────────────────────────────────────────
 * A: every column in the live schema whose name carries a token or secret — so a new one appears
 *    here the moment a migration adds it, without anyone remembering.
 * B: the declarations below. `stateful` names the file and the marker that performs the lookup;
 *    `stateless` carries a reason.
 *
 * This is the same shape as the erasure and consent guards: not "everything must be revocable", but
 * "say what each one is, and be checked on it".
 *
 * Requires a live Postgres — list A comes from the real schema, which is the entire point.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Long enough that a shrug cannot pass for an argument. Mirrors the erasure and consent guards. */
const MIN_REASON = 40;

const DECLARED = {
  "pilot_sessions.token_hash": {
    kind: "stateful",
    lookup: {
      file: "services/platform-api/src/auth.rs",
      marker: "app.get_pilot_session_by_hash($1)",
    },
    why:
      "the pilot session cookie. Every authenticated request re-reads the row, so `revoked_at`, " +
      "the idle window and the absolute window all take effect on the next request.",
  },
  "pilot_invitations.token_hash": {
    kind: "stateful",
    lookup: {
      file: "services/platform-api/src/handlers/pilot.rs",
      marker: "app.consume_pilot_invitation_by_hash($1)",
    },
    why:
      "single-use: the consuming function marks it consumed in the same statement that reads it, " +
      "so a replayed invitation finds no row.",
  },
  "pilot_sessions.csrf_token": {
    kind: "stateless",
    why:
      "not a lookup key and never presented alone — it is read OUT of the session row that the " +
      "cookie hash already resolved, then compared to the submitted header. Revoking the session " +
      "revokes it, so it needs no revocation path of its own.",
  },
  "realtime_session_tickets.token_hash": {
    kind: "stateless",
    why:
      "nothing reads it. The realtime ticket is a stateless 300s HMAC and realtime-gateway holds " +
      "no database connection, so deleting this row cannot stop a ticket already minted. An " +
      "erasure can therefore be raced by an in-flight ticket — reproduced, ADR-0047, which holds " +
      "the choice between a gateway database dependency, a Redis revocation set, a shorter TTL, " +
      "and a deferred re-erase.",
  },
};

/** List A — every token/secret-bearing column, from the live schema. */
async function tokenColumns() {
  const rows = await queryJson(`
    SELECT table_name AS t, column_name AS c
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (column_name LIKE '%token%' OR column_name LIKE '%secret%')`);
  return rows.map((r) => `${r.t}.${r.c}`).sort();
}

/**
 * Does `src` still contain `marker` as a whole thing?
 *
 * A plain `includes` matches a marker that is a PREFIX of a renamed symbol, which is how a guard
 * comes to report a lookup that no longer exists. When a marker ends in an identifier character,
 * the next character must not extend it.
 */
function containsMarker(src, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = /[A-Za-z0-9_]$/.test(marker) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(escaped + suffix).test(src);
}

test("the schema query finds token columns at all, so this is measuring something", async () => {
  // Without this, a failed query returns an empty list, every column in it is trivially declared,
  // and the guard reports that every stored token has a recorded position.
  const columns = await tokenColumns();
  assert.ok(
    columns.length >= 3,
    `found only ${columns.length} token-bearing columns — the schema query is broken, not the ` +
      `schema. Found: ${columns.join(", ")}`,
  );
});

test("every stored token is looked up before it is trusted, or declared stateless with a reason", async () => {
  const undeclared = [];

  for (const column of await tokenColumns()) {
    const declaration = DECLARED[column];
    if (!declaration) {
      undeclared.push(
        `${column} — a token or secret is stored here and nothing says whether presenting it is ` +
          `checked against this row. If it is, name the lookup; if it is not, say so and why, ` +
          `because then deleting this row revokes nothing.`,
      );
      continue;
    }
    if (!["stateful", "stateless"].includes(declaration.kind)) {
      undeclared.push(`${column} — unknown kind ${JSON.stringify(declaration.kind)}`);
    }
    if ((declaration.why ?? "").length < MIN_REASON) {
      undeclared.push(
        `${column} — reason is ${declaration.why?.length ?? 0} chars, need ${MIN_REASON}`,
      );
    }
  }

  assert.deepEqual(
    undeclared,
    [],
    `stored tokens with no recorded revocation position:\n  ${undeclared.join("\n  ")}`,
  );
});

test("every claimed lookup is still present in the file that claims it", () => {
  // The assertion that makes `stateful` mean something. A lookup deleted from a file that survives
  // would otherwise keep counting, and a token would read as revocable forever.
  const broken = [];
  for (const [column, declaration] of Object.entries(DECLARED)) {
    if (declaration.kind !== "stateful") continue;
    const { file, marker } = declaration.lookup;
    let src;
    try {
      src = readFileSync(join(root, file), "utf8");
    } catch {
      broken.push(`${column}: ${file} does not exist`);
      continue;
    }
    if (!containsMarker(src, marker)) {
      broken.push(`${column}: ${file} no longer contains ${JSON.stringify(marker)}`);
    }
  }
  assert.deepEqual(broken, [], `token lookups that have moved or gone:\n  ${broken.join("\n  ")}`);
});

test("no declaration names a column the schema no longer has", async () => {
  // A stale declaration is worse than none: it reads as a considered decision about a token that no
  // longer exists, while a real new one goes unnoticed beside it.
  const columns = new Set(await tokenColumns());
  const stale = Object.keys(DECLARED).filter((c) => !columns.has(c));
  assert.deepEqual(stale, [], `declarations for columns gone from the schema:\n  ${stale.join("\n  ")}`);
});

test("the realtime gateway still holds no database connection, and ADR-0047 is still open", () => {
  // The load-bearing fact under the `realtime_session_tickets` declaration. If the gateway gains a
  // database dependency, that declaration is out of date — the ticket may now be checkable, and the
  // reason written above stops being true.
  const manifest = readFileSync(join(root, "services/realtime-gateway/Cargo.toml"), "utf8");
  assert.ok(
    !/^\s*sqlx\b/m.test(manifest) && !/^\s*tokio-postgres\b/m.test(manifest),
    "realtime-gateway now depends on a database driver — revisit ADR-0047 and this declaration: " +
      "the realtime ticket may now be revocable, and if it is, it should be revoked.",
  );

  const adrs = readFileSync(join(root, "docs/DECISIONS.md"), "utf8");
  assert.match(adrs, /## ADR-0047 —/, "ADR-0047 is gone, so an unrevocable token has no recorded reason");
  assert.match(
    adrs.slice(adrs.indexOf("## ADR-0047 —")),
    /\*\*Status:\*\* Proposed/,
    "ADR-0047 is no longer Proposed — if the ruling was made, the ticket needs code, not a declaration",
  );
});
