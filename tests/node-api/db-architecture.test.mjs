import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(path);
    return entry.name.endsWith(".mjs") || entry.name.endsWith(".js") ? [path] : [];
  });
}

const serverFiles = filesBelow(join(repo, "server"));
const source = (path) => readFileSync(path, "utf8");
const rel = (path) => relative(repo, path);

test("database drivers have one runtime owner and three explicit operator owners", () => {
  const driverImport = /(?:\bfrom\s*|\bimport\s*\()\s*["'](?:pg|postgres)["']/;
  const owners = serverFiles.filter((path) => driverImport.test(source(path))).map(rel).sort();

  assert.deepEqual(owners, [
    "server/scripts/migrate.mjs",
    "server/scripts/provision-role.mjs",
    "server/scripts/repair-audio-index.mjs",
    "server/src/lib/db.mjs",
  ]);

  for (const path of filesBelow(join(repo, "server", "src", "routes"))) {
    assert.doesNotMatch(
      source(path),
      /(?:\bfrom\s*|\bimport\s*\()\s*["'](?:pg|postgres)["']|from\s*["'][^"']*lib\/db\.mjs["']/,
      `${rel(path)} owns DB setup`,
    );
  }
});

test("unscoped runtime SQL is an exact tenant-neutral or security-definer allowlist", () => {
  const runtimeFiles = filesBelow(join(repo, "server", "src"));
  const consumers = new Map();
  for (const path of runtimeFiles) {
    const count = [...source(path).matchAll(/\bctx\.db\.sql(?=`|\.begin\b)/g)].length;
    if (count > 0) consumers.set(rel(path), count);
  }

  assert.deepEqual(Object.fromEntries(consumers), {
    "server/src/lib/authz.mjs": 1,
    "server/src/routes/infra.mjs": 1,
    "server/src/routes/pilot.mjs": 1,
    "server/src/routes/quran.mjs": 4,
  });

  const quran = source(join(repo, "server/src/routes/quran.mjs"));
  const quranQueries = [...quran.matchAll(/ctx\.db\.sql`([\s\S]*?)`/g)].map((match) => match[1]);
  assert.equal(quranQueries.length, 4);
  assert.deepEqual(
    quranQueries.flatMap((query) =>
      [...query.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map((match) => match[1]),
    ),
    [
      "canonical_ayahs",
      "canonical_surahs",
      "canonical_ayahs",
      "canonical_ayahs",
      "canonical_words",
    ],
  );

  const infra = source(join(repo, "server/src/routes/infra.mjs"));
  assert.match(infra, /ctx\.db\.sql`SELECT 1`/);

  for (const path of ["server/src/lib/authz.mjs", "server/src/routes/pilot.mjs"]) {
    const contents = source(join(repo, path));
    assert.match(contents, /ctx\.db\.sql`[\s\S]*app\.get_pilot_session_by_hash/);
  }
});

test("routes cannot open raw transactions or install their own tenant context", () => {
  const routeFiles = filesBelow(join(repo, "server", "src", "routes"));
  for (const path of routeFiles) {
    const contents = source(path);
    assert.doesNotMatch(contents, /ctx\.db\.sql\.begin\b/, `${rel(path)} bypasses the DB transaction boundary`);
    assert.doesNotMatch(
      contents,
      /set_config\(\s*["']app\.tenant_id|set_config\(\s*'app\.tenant_id/,
      `${rel(path)} manually installs tenant identity`,
    );
  }

  const pilot = source(join(repo, "server/src/routes/pilot.mjs"));
  assert.match(pilot, /ctx\.db\.withDiscoveredTenant\(/);
  assert.match(pilot, /app\.consume_pilot_invitation_by_hash/);
  const db = source(join(repo, "server/src/lib/db.mjs"));
  assert.match(db, /async function withDiscoveredTenant\(/);
  assert.match(db, /await setTenantContext\(tx, discovery\?\.tenantId, deadline\)/);
});

test("device identity owns no raw connection and scopes every credential lookup in one discovered-tenant transaction", () => {
  const identity = source(join(repo, "server/src/identity/device-sessions.mjs"));
  assert.doesNotMatch(identity, /\bdb\.sql(?=`|\.begin\b)/);
  assert.doesNotMatch(identity, /set_config\(\s*["']app\.tenant_id/);
  assert.equal(
    [...identity.matchAll(/\bdb\.withDiscoveredTenant\(/g)].length,
    4,
    "exchange, access, refresh, and logout must all use the structural discovery boundary",
  );
  for (const functionName of [
    "consume_device_enrollment_invitation_by_hash",
    "get_device_session_by_access_hash",
    "get_device_session_by_refresh_hash",
  ]) {
    assert.match(identity, new RegExp(`app\\.${functionName}`));
  }
});

test("the restricted-role assertion is a pre-listen lifecycle gate with one explicit dev control", () => {
  const app = source(join(repo, "server/src/app.mjs"));
  const main = source(join(repo, "server/src/main.mjs"));
  const insecure = source(join(repo, "server/src/lib/insecure.mjs"));

  assert.match(app, /app\.addHook\("onReady", async \(\) => db\.assertRestrictedRole\(\)\)/);
  assert.match(app, /app\.addHook\("onClose", async \(\) => db\.end\(\)\)/);
  assert.match(insecure, /ALLOW_SUPERUSER_DB_ROLE = "ALLOW_SUPERUSER_DB_ROLE"/);
  assert.match(
    main,
    /enforceRestrictedDbRole: !relaxed\(ALLOW_SUPERUSER_DB_ROLE, LEGACY_ONE_OR_TRUE\)/,
  );
});
