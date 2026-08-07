import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createDb } from "../../server/src/lib/db.mjs";

/**
 * N3 §2.2 — the highest-risk primitive in the whole port.
 * specs/node-backend-port/plan.md §5
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────────
 * Phase 6 proved RLS fails CLOSED when the tenant context is MISSING (`rls_backstops_a_query…`).
 * It proved NOTHING about a context that is present but WRONG — and that is the failure a connection
 * pool produces: a client released while still inside a transaction keeps `app.tenant_id`, and
 * `SET LOCAL` only resets at transaction end.
 *
 * A stale-but-valid tenant fails **OPEN**. `tenant_id = app.current_tenant_id()` is simply true for
 * the wrong tenant's rows, and every handler filter downstream agrees with it. Nothing in this repo
 * covered that before this file.
 *
 * Requires a live Postgres. Connect as `quran_ai_app` for the RLS assertions to mean anything —
 * a superuser bypasses RLS unconditionally and every test here would pass for the wrong reason.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const TENANT = "hikmah-pilot-erbil";

let db;
before(() => {
  db = createDb(DATABASE_URL);
});
after(async () => {
  await db?.end();
});

// --- the hazard itself: proof that a WRONG context is not the safe case ---

test("a stale-but-valid tenant context fails OPEN — this is why the pooling discipline matters", async () => {
  // Deliberately set the GUC at SESSION scope, which is what a leaked transaction leaves behind,
  // and show the database happily serves the other tenant's rows. If this test ever starts failing
  // because Postgres began failing closed here, the rest of this file is over-engineered — but it
  // does not, and that is the point.
  await db.sql.reserve().then(async (reserved) => {
    try {
      await reserved`SELECT set_config('app.tenant_id', ${TENANT}, false)`; // false = SESSION scope
      await reserved`SET ROLE quran_ai_app`;
      const [{ count }] = await reserved`SELECT count(*)::int AS count FROM users`;
      assert.ok(
        count > 0,
        "a session-scoped tenant GUC makes RLS serve that tenant's rows — a LEAKED context is not " +
          "an empty result, it is someone else's data",
      );
    } finally {
      await reserved`RESET ROLE`;
      await reserved`SELECT set_config('app.tenant_id', '', false)`;
      reserved.release();
    }
  });
});

// --- what withTenant must guarantee ---

test("the tenant GUC is set INSIDE the transaction", async () => {
  const inside = await db.withTenant(TENANT, async (tx) => {
    const [row] = await tx`SELECT current_setting('app.tenant_id', true) AS tenant`;
    return row.tenant;
  });
  assert.equal(inside, TENANT);
});

test("worker tenant discovery reads only the global registry and leaves no tenant context", async () => {
  const tenantIds = await db.listTenantIds();
  assert.ok(tenantIds.includes(TENANT));
  assert.deepEqual([...tenantIds].sort(), tenantIds, "tenant polling order must be deterministic");
  assert.ok(!(await db.currentTenantSetting()), "global tenant discovery installed a pooled tenant GUC");
});

test("a discovered tenant receives the same GUC and statement timeout before tenant work", async () => {
  const result = await db.withDiscoveredTenant(
    async (tx) => {
      const [before] = await tx`SELECT current_setting('app.tenant_id', true) AS tenant`;
      assert.ok(!before.tenant, "discovery unexpectedly inherited a tenant context");
      return { tenantId: TENANT, evidence: "security-definer-result" };
    },
    async (tx, discovery) => {
      const [inside] = await tx`
        SELECT current_setting('app.tenant_id', true) AS tenant,
               current_setting('statement_timeout') AS statement_timeout`;
      return { ...inside, evidence: discovery.evidence };
    },
  );
  assert.deepEqual(result, {
    tenant: TENANT,
    statement_timeout: "10s",
    evidence: "security-definer-result",
  });
});

test("a discovered empty tenant is refused and leaves no pooled context", async () => {
  await assert.rejects(
    () => db.withDiscoveredTenant(async () => ({ tenantId: "" }), async () => {}),
    /tenant context must be a non-empty string/,
  );
  for (let i = 0; i < 20; i++) {
    assert.ok(!(await db.currentTenantSetting()), "invalid discovery leaked a tenant context");
  }
});

test("the GUC does NOT survive the transaction on a pooled connection", async () => {
  await db.withTenant(TENANT, async (tx) => {
    await tx`SELECT 1`;
  });
  // Poll several times: the pool may hand back a different connection each call, and the leak only
  // shows on the one that ran the transaction.
  for (let i = 0; i < 20; i++) {
    const leaked = await db.currentTenantSetting();
    assert.ok(!leaked, `tenant context leaked onto a pooled connection: ${JSON.stringify(leaked)}`);
  }
});

test("a THROWING callback leaves no tenant context behind — the case the naive port gets wrong", async () => {
  // This is the exact scenario in §2.2: the work fails, the rollback path runs, and the connection
  // goes back to the pool. If `app.tenant_id` survives, the next request on that connection reads
  // the previous tenant's rows.
  await assert.rejects(
    () =>
      db.withTenant(TENANT, async (tx) => {
        await tx`SELECT 1`;
        throw new Error("deliberate failure inside the transaction");
      }),
    /deliberate failure/,
  );
  for (let i = 0; i < 20; i++) {
    const leaked = await db.currentTenantSetting();
    assert.ok(!leaked, `tenant context leaked after a failed transaction: ${JSON.stringify(leaked)}`);
  }
});

test("a callback that fails at the DATABASE level also leaves nothing behind", async () => {
  // A JS throw unwinds cleanly. A server-side error aborts the transaction first, which is the
  // harder path and the one that produced the original warning about a failing ROLLBACK.
  await assert.rejects(() =>
    db.withTenant(TENANT, async (tx) => {
      await tx`SELECT * FROM a_table_that_does_not_exist`;
    }),
  );
  for (let i = 0; i < 20; i++) {
    assert.ok(!(await db.currentTenantSetting()), "tenant context leaked after a server-side error");
  }
});

test("two interleaved transactions never see each other's tenant", async () => {
  // The pool serves both concurrently; if the GUC were connection-scoped rather than
  // transaction-scoped, one would observe the other's value.
  const [a, b] = await Promise.all([
    db.withTenant("tenant-alpha", async (tx) => {
      await tx`SELECT pg_sleep(0.05)`;
      const [row] = await tx`SELECT current_setting('app.tenant_id', true) AS t`;
      return row.t;
    }),
    db.withTenant("tenant-beta", async (tx) => {
      const [row] = await tx`SELECT current_setting('app.tenant_id', true) AS t`;
      return row.t;
    }),
  ]);
  assert.equal(a, "tenant-alpha");
  assert.equal(b, "tenant-beta");
});

// --- refusing degenerate input, rather than silently failing closed ---

test("an empty or non-string tenant is REFUSED, not passed through", async () => {
  // `set_config('app.tenant_id', '', true)` fails closed — but silently, turning an auth bug into an
  // empty page instead of an error. Refusing makes the bug visible where it happens.
  for (const bad of [null, undefined, "", "   ", 42, {}]) {
    await assert.rejects(() => db.withTenant(bad, async () => {}), TypeError, `tenant ${JSON.stringify(bad)}`);
  }
});

test("createDb refuses a missing connection string", () => {
  assert.throws(() => createDb(undefined), TypeError);
  assert.throws(() => createDb(""), TypeError);
});
