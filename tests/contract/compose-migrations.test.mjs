import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const composeSource = await readFile("docker-compose.yml", "utf8");
const compose = parse(composeSource);

test("Compose has one one-shot migration/provision boundary and no initdb SQL mounts", () => {
  const postgresVolumes = compose.services.postgres.volumes ?? [];
  assert.equal(postgresVolumes.some((volume) => String(volume).includes("docker-entrypoint-initdb.d")), false);

  const migrations = compose.services.migrations;
  assert.ok(migrations, "migrations service must exist");
  assert.equal(migrations.build.dockerfile, "server/migrations.Dockerfile");
  assert.match(JSON.stringify(migrations.command), /server\/scripts\/migrate\.mjs/);
  assert.match(JSON.stringify(migrations.command), /server\/scripts\/provision-role\.mjs/);
  assert.match(migrations.environment.MIGRATION_DATABASE_URL, /postgresql:\/\/hawzhin:/);
  assert.equal(
    migrations.environment.APP_DATABASE_PASSWORD,
    "${APP_DATABASE_PASSWORD:?APP_DATABASE_PASSWORD is required}",
  );

  const platform = compose.services["platform-api"];
  assert.equal(platform.depends_on.migrations.condition, "service_completed_successfully");
  assert.equal(platform.environment.DATABASE_URL.startsWith("postgresql://quran_ai_app:"), true);
  assert.match(platform.environment.DATABASE_URL, /\$\{APP_DATABASE_PASSWORD\}/);
  assert.doesNotMatch(platform.environment.DATABASE_URL, /\$\{POSTGRES_PASSWORD\}/);
});

test("migration image and every operational path invoke the same runner", async () => {
  const dockerfile = await readFile("server/migrations.Dockerfile", "utf8");
  assert.match(dockerfile, /npm install --global pnpm@11\.7\.0/);
  assert.match(dockerfile, /USER 10001/);
  assert.match(dockerfile, /server\/scripts\/migrate\.mjs/);

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["db:migrate"], "node server/scripts/migrate.mjs");
  assert.equal(packageJson.scripts["db:provision"], "node server/scripts/provision-role.mjs");

  const smokeSql = await readFile("scripts/smoke-sql.mjs", "utf8");
  assert.doesNotMatch(smokeSql, /coreSchemaSafe|dropPolicies/);

  const consumers = new Map([
    ["CI", await readFile(".github/workflows/ci.yml", "utf8")],
    ["staging", await readFile("scripts/recreate-staging.sh", "utf8")],
    ["restore", await readFile("scripts/restore-db.sh", "utf8")],
    ["release", await readFile("scripts/verify.sh", "utf8")],
  ]);
  for (const [label, source] of consumers) {
    assert.match(source, /server\/scripts\/migrate\.mjs/, `${label} does not call the migration runner`);
  }
  const ci = consumers.get("CI");
  assert.ok(ci);
  assert.doesNotMatch(ci, /for sql in/);

  const verify = consumers.get("release");
  assert.ok(verify);
  assert.match(verify, /MIGRATION_TEST_ADMIN_URL="\$\{MIGRATION_TEST_ADMIN_URL:-\$DATABASE_URL\}"/);
  assert.doesNotMatch(verify, /MIGRATION_TEST_ADMIN_URL="\\\$DATABASE_URL" node/);
  assert.doesNotMatch(composeSource, /infra\/sql/);
});
