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

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

export function createDb(connectionString, options = {}) {
  if (!isNonEmptyString(connectionString)) {
    throw new TypeError("createDb: connectionString is required and has no default");
  }
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    connect_timeout: options.connectTimeout ?? 10,
    // The tenant GUC must never be pre-set on a fresh connection. Anything relying on a connection
    // default would work in tests and leak in production, where the pool is shared.
    onnotice: () => {},
    ...options.pg,
  });

  /**
   * Run `fn` with the tenant context set for the life of one transaction.
   *
   * `set_config(..., true)` is transaction-local, matching `begin_tenant_tx`. Because `sql.begin`
   * owns the connection, there is no path where the caller keeps it past the transaction.
   */
  async function withTenant(tenantId, fn) {
    // A null/empty tenant would set the GUC to '' — which fails closed, but silently, turning an
    // auth bug into an empty page instead of an error. Refuse it.
    if (!isNonEmptyString(tenantId)) {
      throw new TypeError(`withTenant: tenantId must be a non-empty string, got ${JSON.stringify(tenantId)}`);
    }
    return sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      // A runaway statement is how a connection ends up abandoned mid-transaction in the first
      // place. Bounding it here is part of the same defence, not a separate nicety.
      await tx.unsafe(`SET LOCAL statement_timeout = '${Number(options.statementTimeoutMs ?? 10_000)}ms'`);
      return fn(tx);
    });
  }

  /** Read the tenant GUC on a pooled connection. Exists for the leak test — nothing else uses it. */
  async function currentTenantSetting() {
    const [row] = await sql`SELECT current_setting('app.tenant_id', true) AS tenant`;
    return row.tenant;
  }

  return { sql, withTenant, currentTenantSetting, end: () => sql.end({ timeout: 5 }) };
}
