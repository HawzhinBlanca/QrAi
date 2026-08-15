/**
 * §2.2 — tenant-scoped database access. The highest-risk piece of the whole port.
 * specs/node-backend-port/plan.md N3
 *
 * ── What Rust gets for free, and JavaScript does not ────────────────────────────────────────────
 * `begin_tenant_tx` (services/platform-api/src/lib.rs) opens a transaction and runs
 * `set_config('app.tenant_id', $1, true)` — transaction-local. sqlx's `Transaction` then binds every
 * later statement to ONE physical connection by RAII, and its `Drop` queues `ROLLBACK`. 90 query
 * sites depend on that.
 *
 * The obvious node-postgres port has a fatal hole:
 *
 *     try { ... } catch { await c.query('ROLLBACK'); throw } finally { c.release() }
 *
 * If the ROLLBACK itself throws — connection reset, statement timeout, backend termination, exactly
 * the cases that matter — `release()` returns a client STILL INSIDE a transaction, with
 * `app.tenant_id` still set, to the pool. `SET LOCAL` only resets at transaction end; if the
 * transaction never ends, the setting persists on that connection.
 *
 * ── And the failure is not the safe one ─────────────────────────────────────────────────────────
 * Phase 6 proved RLS fails CLOSED when the tenant context is MISSING: `current_tenant_id()` returns
 * NULL and the policy matches nothing. That is not this case. A STALE-BUT-VALID tenant id fails
 * **OPEN** — `tenant_id = app.current_tenant_id()` is simply true for the wrong tenant's rows, and
 * every handler filter downstream agrees with it. No test in this repo covered that before N3.
 *
 * ── The decision ────────────────────────────────────────────────────────────────────────────────
 * `postgres` (porsager). `sql.begin(async sql => …)` binds the callback's statements to one reserved
 * connection structurally: there is no handle to leak, because the caller never holds one. Structure
 * beats discipline, and this is a place where discipline has a known way of failing silently.
 */
import postgres from "postgres";

import { DeadlineExceededError } from "./deadline.mjs";

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

export function createDb(connectionString, options = {}) {
  if (!isNonEmptyString(connectionString)) {
    throw new TypeError("createDb: connectionString is required and has no default");
  }
  const statementTimeoutMs = Number(options.statementTimeoutMs ?? 10_000);
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs <= 0) {
    throw new TypeError("createDb: statementTimeoutMs must be a positive whole number");
  }
  const closeTimeoutMs = Number(options.closeTimeoutMs ?? 5_000);
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs <= 0) {
    throw new TypeError("createDb: closeTimeoutMs must be a positive whole number");
  }
  const pgOptions = options.pg ?? {};
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    connect_timeout: options.connectTimeout ?? 10,
    // The tenant GUC must never be pre-set on a fresh connection. Anything relying on a connection
    // default would work in tests and leak in production, where the pool is shared.
    onnotice: () => {},
    ...pgOptions,
    // Server-side cancellation is authoritative. A Promise race can return while a transaction
    // later commits; statement_timeout aborts the statement and therefore the open transaction.
    connection: {
      ...(pgOptions.connection ?? {}),
      statement_timeout: String(statementTimeoutMs),
      idle_in_transaction_session_timeout: String(statementTimeoutMs),
    },
  });

  function deadlineTimeout(deadline) {
    if (deadline === null) return statementTimeoutMs;
    const remainingMs = deadline.remainingMs();
    if (deadline.signal?.aborted || remainingMs <= 0) throw new DeadlineExceededError();
    return Math.max(1, Math.min(statementTimeoutMs, remainingMs));
  }

  async function setTenantContext(tx, tenantId, deadline = null) {
    if (!isNonEmptyString(tenantId)) {
      throw new TypeError(
        `tenant context must be a non-empty string, got ${JSON.stringify(tenantId)}`,
      );
    }
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    // A runaway statement is how a connection ends up abandoned mid-transaction in the first
    // place. Bounding it here is part of the same defence, not a separate nicety.
    await tx.unsafe(`SET LOCAL statement_timeout = '${deadlineTimeout(deadline)}ms'`);
  }

  /**
   * Run `fn` with the tenant context set for the life of one transaction.
   *
   * `set_config(..., true)` is transaction-local, matching `begin_tenant_tx`. Because `sql.begin`
   * owns the connection, there is no path where the caller keeps it past the transaction.
   */
  async function withTenant(tenantId, fn, deadline = null) {
    // A null/empty tenant would set the GUC to '' — which fails closed, but silently, turning an
    // auth bug into an empty page instead of an error. Refuse it.
    if (!isNonEmptyString(tenantId)) {
      throw new TypeError(`withTenant: tenantId must be a non-empty string, got ${JSON.stringify(tenantId)}`);
    }
    deadlineTimeout(deadline);
    return sql.begin(async (tx) => {
      await setTenantContext(tx, tenantId, deadline);
      return fn(tx);
    });
  }

  /**
   * Discover an otherwise unknown tenant, then scope the REST of that same transaction.
   *
   * Only a locked-down security-definer lookup belongs in `discover`. Tenant-owned reads/writes
   * belong in `fn`, which cannot run until the returned `tenantId` has installed the same GUC and
   * statement timeout as `withTenant`.
   */
  async function withDiscoveredTenant(discover, fn, deadline = null) {
    if (typeof discover !== "function" || typeof fn !== "function") {
      throw new TypeError("withDiscoveredTenant: discover and fn must be functions");
    }
    deadlineTimeout(deadline);
    return sql.begin(async (tx) => {
      const discovery = await discover(tx);
      await setTenantContext(tx, discovery?.tenantId, deadline);
      return fn(tx, discovery);
    });
  }

  function forDeadline(deadline) {
    if (
      deadline === null ||
      typeof deadline?.remainingMs !== "function" ||
      !(deadline?.signal instanceof AbortSignal)
    ) {
      throw new TypeError("forDeadline: a deadline is required");
    }
    return Object.freeze({
      sql,
      withTenant: (tenantId, fn) => withTenant(tenantId, fn, deadline),
      withDiscoveredTenant: (discover, fn) => withDiscoveredTenant(discover, fn, deadline),
      assertRestrictedRole,
      listTenantIds,
      currentTenantSetting,
      end: () => sql.end({ timeout: closeTimeoutMs / 1_000 }),
    });
  }

  /** Refuse a runtime role whose capabilities make the restricted DB boundary untrue. */
  async function assertRestrictedRole() {
    const [role] = await sql`
      SELECT current_user AS role_name,
             rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
      FROM pg_roles
      WHERE rolname = current_user`;
    if (!role) {
      throw new Error("database role metadata is unavailable; refusing to start");
    }

    const forbidden = [
      ["SUPERUSER", role.rolsuper],
      ["BYPASSRLS", role.rolbypassrls],
      ["CREATEDB", role.rolcreatedb],
      ["CREATEROLE", role.rolcreaterole],
      ["REPLICATION", role.rolreplication],
    ].filter(([, enabled]) => enabled).map(([name]) => name);
    if (forbidden.length > 0) {
      throw new Error(
        `database role has forbidden capability ${forbidden.join(", ")}; ` +
          "tenant isolation requires a restricted runtime role",
      );
    }
  }

  /** Read the tenant GUC on a pooled connection. Exists for the leak test — nothing else uses it. */
  async function currentTenantSetting() {
    const [row] = await sql`SELECT current_setting('app.tenant_id', true) AS tenant`;
    return row.tenant;
  }

  /**
   * Enumerate the global institution registry for fair worker polling. Institutions are the tenant
   * authority itself, not a tenant-owned table; every subsequent job read/write still uses
   * `withTenant` and forced RLS. A fixed ceiling prevents an unbounded in-process poll set.
   */
  async function listTenantIds(limit = 10_000) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new TypeError("listTenantIds limit must be a whole number from 1 to 10000");
    }
    const rows = await sql`SELECT id FROM institutions ORDER BY id LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  return {
    sql,
    withTenant,
    withDiscoveredTenant,
    forDeadline,
    assertRestrictedRole,
    listTenantIds,
    currentTenantSetting,
    end: () => sql.end({ timeout: closeTimeoutMs / 1_000 }),
  };
}
