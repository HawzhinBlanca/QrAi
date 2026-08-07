import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

const compose = YAML.parse(readFileSync("docker-compose.yml", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const verify = readFileSync("scripts/verify.sh", "utf8");

test("the transitional gateway always knows the internal audio-index API", () => {
  assert.equal(
    compose.services["realtime-gateway"].environment.PLATFORM_API_URL,
    "http://platform-api:8080",
  );
  assert.equal(
    compose.services["realtime-gateway"].depends_on["platform-api"].condition,
    "service_healthy",
  );
});

test("the ownership-safe repair command is an explicit operations profile", () => {
  const repair = compose.services["audio-index-repair"];
  assert.deepEqual(repair.profiles, ["operations"]);
  assert.match(repair.environment.DATABASE_URL, /quran_ai_app/);
  assert.match(repair.environment.DATABASE_URL, /APP_DATABASE_PASSWORD/);
  assert.equal(repair.environment.AUDIO_STORAGE_DRIVER, "${AUDIO_STORAGE_DRIVER:-filesystem}");
  assert.equal(repair.environment.AUDIO_STORAGE_DIR, "/data/audio-storage");
  assert.equal(repair.environment.AUDIO_STORAGE_S3_BUCKET, "${AUDIO_STORAGE_S3_BUCKET:-}");
  assert.equal(repair.environment.AUDIO_RECONCILE_TENANT_IDS, "${AUDIO_RECONCILE_TENANT_IDS:-hikmah-pilot-erbil}");
  assert.ok(
    repair.volumes.some((volume) => String(volume).includes("audio_storage:/data/audio-storage:ro")),
  );
  assert.deepEqual(repair.command, ["node", "server/scripts/repair-audio-index.mjs", "--apply"]);
  assert.equal(packageJson.scripts["db:repair-audio-index"], "node server/scripts/repair-audio-index.mjs");
});

test("canonical verification runs the real storage-index-playback proof", () => {
  assert.match(verify, /tests\/e2e\/teacher-audio-index\.test\.mjs/);
});
