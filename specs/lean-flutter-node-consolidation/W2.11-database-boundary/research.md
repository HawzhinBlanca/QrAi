# W2.11 research — restricted database and tenant transaction boundary

## Question

Can the standalone Node API prove at boot that Postgres row-level security is active, and can the
repository prevent a future route from bypassing the one tenant-transaction primitive?

## Findings

### Runtime role posture is provisioned but not asserted by Node

- `infra/provision/app-role.sql` and `server/scripts/provision-role.mjs` create a login role with
  `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`. The live migration proof already verifies all
  four negative capabilities.
- Rust refuses `SUPERUSER` and `BYPASSRLS` in `services/platform-api/src/main.rs` before listening.
  `server/src/main.mjs` had no equivalent. A wrong Node `DATABASE_URL` could therefore make every
  RLS policy ineffective while health and readiness remained green.
- `server/src/app.mjs::createApplication` is the single composition owner and creates the single
  `createDb` pool. Fastify's `onReady` lifecycle is the narrow boot seam: it runs before `listen`
  completes and does not require a second pool or process-global connection.
- The existing local-development relaxation is `ALLOW_SUPERUSER_DB_ROLE`, with deprecated
  `ALLOW_INSECURE_DEFAULTS` compatibility. Production remains fail-closed; this slice preserves the
  established explicit local relaxation rather than adding another flag.

### Tenant query paths are mostly structural already

- All ordinary tenant-owned route queries use `ctx.db.withTenant(actor.tenantId, ...)`.
- `withTenant` uses `postgres.begin`, a transaction-local `set_config('app.tenant_id', ..., true)`,
  and a bounded `SET LOCAL statement_timeout`. The live `db-tenant.test.mjs` proves success,
  callback failure, database failure, interleaving, and pooled-context cleanup.
- Pilot bootstrap is the one tenant-owned exception. It must consume a security-definer invitation
  before the tenant is known, then manually sets the tenant GUC and performs tenant-owned work in
  that same transaction. The ordering is correct, but the duplicate implementation omitted the
  shared statement timeout and could drift again.
- A `withDiscoveredTenant` primitive can preserve the required security-definer discovery step,
  validate its returned tenant, install the same GUC and timeout as `withTenant`, and only then
  invoke tenant-owned work on that transaction.

### Audited unscoped SQL is narrow and legitimate

The runtime currently has exactly these unscoped database consumers:

1. `routes/quran.mjs`: four reads from immutable `canonical_surahs`, `canonical_ayahs`, and
   `canonical_words`; these tables are global, not tenant-owned.
2. `routes/infra.mjs`: readiness `SELECT 1` only.
3. `routes/pilot.mjs` and `lib/authz.mjs`: `app.get_pilot_session_by_hash`, a locked-down
   `SECURITY DEFINER` function required because the tenant is not known until the cookie is looked
   up. Mutation after lookup already uses `withTenant`.
4. Pilot invitation discovery uses `app.consume_pilot_invitation_by_hash`, another locked-down
   `SECURITY DEFINER` function; it will move behind `withDiscoveredTenant`.

`infra/migrations/0021_pilot_identity.sql` revokes both functions from `PUBLIC`, grants them only to
the application role, fixes `search_path`, and keeps tenant tables under forced RLS.

### Raw driver ownership is already lean

- The only runtime driver import under `server/src` is `postgres` in `server/src/lib/db.mjs`.
- The only production operator imports are `pg` in the migration, role-provision, and audio-index
  repair scripts under `server/scripts`.
- Routes do not import either driver or `createDb`. A static architecture test can make that current
  shape executable, pin the exact unscoped SQL allowlist, and reject manual tenant `set_config` in
  every route.

## Decision

Keep the existing project. Add the boot assertion and the discovered-tenant transaction to the
single database primitive; do not add another service, ORM, repository hierarchy, or database pool.
Enforce the boundary with one focused live role suite, expanded live tenant tests, and one hermetic
architecture test.
