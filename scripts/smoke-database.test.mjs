import assert from "node:assert/strict";
import test from "node:test";
import { databaseConnectionArgs, resolvePsqlCommand, smokeAdminDatabaseUrl } from "./smoke-database.mjs";

test("uses the explicitly supplied release database URL as one psql argument", () => {
  const databaseUrl = "postgresql://release_user:secret@db.example.test:5432/quran_release";
  assert.deepEqual(databaseConnectionArgs(databaseUrl), ["--dbname", databaseUrl]);
});

test("retains the local default only when no database URL is supplied", () => {
  assert.deepEqual(databaseConnectionArgs(), ["-U", "hawzhin", "-d", "quran_ai"]);
});

test("does not silently accept an empty database URL", () => {
  assert.throws(() => databaseConnectionArgs("   "), /must not be empty/i);
});

test("uses an explicit administrative URL for destructive smoke setup without replacing the application URL", () => {
  const environment = {
    DATABASE_URL: "postgresql://app_user:secret@db.example.test:5432/quran",
    SMOKE_DATABASE_ADMIN_URL: "postgresql://smoke_admin:secret@db.example.test:5432/quran_smoke",
  };
  assert.equal(smokeAdminDatabaseUrl(environment), environment.SMOKE_DATABASE_ADMIN_URL);
  assert.equal(environment.DATABASE_URL, "postgresql://app_user:secret@db.example.test:5432/quran");
});

test("retains the runtime URL as the legacy local fallback when no administrative URL is configured", () => {
  assert.equal(
    smokeAdminDatabaseUrl({ DATABASE_URL: "postgresql://local_user@localhost:5432/quran_ai" }),
    "postgresql://local_user@localhost:5432/quran_ai",
  );
});

test("uses an explicit PSQL command before automatic discovery", () => {
  const checkedPaths = [];
  assert.equal(
    resolvePsqlCommand({ PSQL: "/custom/postgres/bin/psql --quiet" }, (path) => {
      checkedPaths.push(path);
      return path === "/custom/postgres/bin/psql";
    }),
    "/custom/postgres/bin/psql --quiet",
  );
  assert.deepEqual(checkedPaths, ["/custom/postgres/bin/psql"]);
});

test("discovers the supported Homebrew PostgreSQL client when it is installed", () => {
  assert.equal(
    resolvePsqlCommand({}, (path) => path === "/opt/homebrew/opt/postgresql@16/bin/psql"),
    "/opt/homebrew/opt/postgresql@16/bin/psql",
  );
});

test("falls back to PATH when no known PostgreSQL client path exists", () => {
  assert.equal(resolvePsqlCommand({}, () => false), "psql");
});
