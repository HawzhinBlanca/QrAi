import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createDb } from "../../services/node-api/lib/db.mjs";

/**
 * Every `SECURITY DEFINER` function is an unconditional hole through tenant isolation, so the set of
 * them must be small, declared, and hardened — checked against the live catalog.
 *
 * `tests/security/rls-policy-coverage.test.mjs` proves all 17 tenant-scoped tables carry a FORCED
 * policy reading `app.is_rls_bypass_enabled() OR tenant_id = app.current_tenant_id()`, and that the
 * bypass is gated on `rolsuper` so no session can set a GUC and turn it off. That is the whole of
 * tenant isolation — except that a `SECURITY DEFINER` function runs as its OWNER, and both owners
 * here are superusers, and a superuser is not subject to row-level security at all. The policy is
 * never consulted.
 *
 * ── What was measured ───────────────────────────────────────────────────────────────────────────
 * One role, one tenant setting, bypass off, two functions differing only in `SECURITY INVOKER` vs
 * `SECURITY DEFINER`, both reading `SELECT count(*) FROM users`:
 *
 *     SET LOCAL ROLE quran_ai_app;              -- not a superuser
 *     SET LOCAL app.tenant_id = 'no-such-tenant';
 *
 *      via_invoker | via_definer
 *     -------------+-------------
 *                0 |        4159
 *
 * Every user row in the database, across every tenant. Not a weakened policy — no policy.
 *
 * ── Why this guard and not the one that exists ──────────────────────────────────────────────────
 * `scripts/smoke-sql.mjs` hardens the two known functions: it requires `set search_path = public,
 * pg_temp` and a `revoke execute … from public` for each. Two things it cannot do, both of which
 * this covers:
 *
 * **1. It cannot see a third function.** It greps for two names. A `SECURITY DEFINER` function added
 * by a later migration gets no search_path check, no PUBLIC revoke, and no stated reason — while
 * every existing check stays green. List A here comes from `pg_proc`, so a new one fails on the
 * migration that adds it, naming it.
 *
 * The negative control made the first point concrete in a way worth writing down: a freshly created
 * `SECURITY DEFINER` function failed the reason check, the search_path check AND the PUBLIC check at
 * once — because Postgres grants `EXECUTE` to `PUBLIC` by default and pins nothing by default. The
 * safe state is the one somebody has to remember to ask for.
 *
 * **2. It reads the migration FILE, not the database.** `0021` still says what it says forever. A
 * later `CREATE OR REPLACE FUNCTION` without `SET search_path` clears `proconfig` — the hardening is
 * gone from the running database and the file-based assertion still passes, because the file it
 * asserts on was never edited. The catalog is the only thing that knows what is actually installed.
 *
 * ── The two lists ───────────────────────────────────────────────────────────────────────────────
 * A: every `prosecdef` function outside the system schemas, from `pg_proc`.
 * B: the declarations below — why this function must bypass RLS, at all.
 *
 * Same shape as the erasure, consent and token guards: not "no definer functions", which would be
 * wrong (the pilot cookie lookup genuinely cannot know the tenant before it resolves the cookie),
 * but "say what each one is for, and be checked on it".
 *
 * DB-gated: list A is the real catalog, which is the entire point.
 */

const DATABASE_URL = process.env.DATABASE_URL;
let db;

before(() => {
  db = createDb(DATABASE_URL);
});
after(async () => {
  await db?.end();
});

/** Long enough that a shrug cannot pass for an argument. Mirrors the erasure and consent guards. */
const MIN_REASON = 40;

/**
 * Why each `SECURITY DEFINER` function is allowed to see every tenant.
 *
 * A function belongs here only if it CANNOT be written as `SECURITY INVOKER`. Both of these are
 * called before the tenant is known — that is the whole reason they exist — so neither could scope
 * itself even if it wanted to.
 */
const DECLARED = {
  "app.get_pilot_session_by_hash": {
    why:
      "resolves the `__Host-qrai-pilot` cookie to a session. It runs BEFORE the tenant is known — " +
      "the cookie is the only thing the request carries, and the row it finds is what supplies " +
      "`tenant_id` for `begin_tenant_tx`. Under RLS it could never find that row, so a definer is " +
      "not a shortcut here, it is the only order the lookup can happen in.",
  },
  "app.consume_pilot_invitation_by_hash": {
    why:
      "same order of operations for invitation redemption: the invitation token arrives from a " +
      "person with no session and therefore no tenant. It marks the invitation consumed in the " +
      "same statement that reads it, so widening its visibility does not widen what it can do.",
  },
};

/** List A — every SECURITY DEFINER function that is not Postgres's own. */
async function definerFunctions() {
  return db.sql`
    SELECT n.nspname || '.' || p.proname AS name,
           pg_get_userbyid(p.proowner) AS owner,
           r.rolsuper AS owner_is_superuser,
           p.proconfig,
           pg_get_functiondef(p.oid) AS def,
           has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.prosecdef
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1`;
}

test("the catalog scan finds the definer functions at all", async () => {
  // Without this, a query that silently matched nothing would report that every RLS bypass in the
  // database is declared and hardened — over an empty set.
  const rows = await definerFunctions();
  assert.ok(
    rows.length >= 2,
    `found ${rows.length} SECURITY DEFINER functions; the pilot identity pair (0021) should always ` +
      `be here, so this query is broken, not the schema`,
  );
});

test("every SECURITY DEFINER function has a stated reason to bypass tenant isolation", async () => {
  const undeclared = [];

  for (const fn of await definerFunctions()) {
    const declaration = DECLARED[fn.name];
    if (!declaration) {
      undeclared.push(
        `${fn.name} — SECURITY DEFINER, owned by ${fn.owner}` +
          (fn.owner_is_superuser ? " (a superuser, so row-level security does not apply at all)" : "") +
          `. Every tenant policy is bypassed inside this function. If it must be, say why here; if ` +
          `it need not be, make it SECURITY INVOKER and it will be scoped like everything else.`,
      );
      continue;
    }
    if ((declaration.why ?? "").length < MIN_REASON) {
      undeclared.push(
        `${fn.name} — reason is ${declaration.why?.length ?? 0} chars, need ${MIN_REASON}. ` +
          `A bypass without an argument is an unscoped query wearing a function's clothing.`,
      );
    }
  }

  assert.deepEqual(
    undeclared,
    [],
    `SECURITY DEFINER functions with no recorded reason to see every tenant:\n  ` +
      `${undeclared.join("\n  ")}`,
  );
});

test("no declaration names a function the database no longer has", async () => {
  // The reverse direction. A stale declaration reads as a considered decision about a bypass that
  // does not exist, while a real new one goes unnoticed beside it.
  const live = new Set((await definerFunctions()).map((f) => f.name));
  const stale = Object.keys(DECLARED).filter((name) => !live.has(name));
  assert.deepEqual(stale, [], `declarations for functions gone from the catalog:\n  ${stale.join("\n  ")}`);
});

test("every definer function pins search_path IN THE INSTALLED DEFINITION", async () => {
  // `scripts/smoke-sql.mjs` asserts this against the text of 0021. That file cannot stop a later
  // `CREATE OR REPLACE FUNCTION` from dropping `SET search_path`, which clears `proconfig` and
  // reopens the temp-table shadowing the pin was added to close — with 0021 still on disk saying
  // otherwise. This reads what is actually installed.
  const unpinned = [];
  for (const fn of await definerFunctions()) {
    const pinned = (fn.proconfig ?? []).some((c) => /^search_path=/.test(c));
    if (!pinned) {
      unpinned.push(
        `${fn.name} — proconfig is ${JSON.stringify(fn.proconfig)}. A definer function that does ` +
          `not pin search_path can be pointed at a shadowing object in pg_temp by its own caller.`,
      );
    }
  }
  assert.deepEqual(unpinned, [], `definer functions running with an unpinned search_path:\n  ${unpinned.join("\n  ")}`);
});

test("no definer function is executable by PUBLIC", async () => {
  // The bypass is only as narrow as the grant. `revoke execute … from public` is in 0021 for both;
  // this asserts the effective privilege rather than the line that was supposed to produce it.
  const open = [];
  for (const fn of await definerFunctions()) {
    if (fn.public_can_execute) {
      open.push(`${fn.name} — PUBLIC can EXECUTE, so any role reaching the database can use the bypass`);
    }
  }
  assert.deepEqual(open, [], `definer functions granted to PUBLIC:\n  ${open.join("\n  ")}`);
});
