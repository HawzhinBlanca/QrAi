import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCompatibilityIngress } from "../../server/src/inference/compatibility-ingress.mjs";
import { createFilesystemAudioObjectStore } from "../../server/src/storage/audio-object-store.mjs";
import { createJobWorker } from "../../server/src/worker.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the worker compatibility ingress is key-gated, bounded, create-only, and store-injected", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "qrai-compat-ingress-"));
  const audioObjectStore = createFilesystemAudioObjectStore({ rootDir });
  const logs = [];
  const db = {
    async assertRestrictedRole() {},
    async listTenantIds() { return []; },
    async end() {},
  };
  const store = { async summary() { return {}; } };
  const runtime = {
    async runOne() { return { outcome: "idle", job: null }; },
    async drain() { return true; },
    renderMetrics() { return ""; },
  };
  const compatibilityIngress = createCompatibilityIngress({
    audioObjectStore,
    inference: {
      async predictAlignment(body) { return { operation: "alignment", sessionId: body.sessionId }; },
      async predictTajweed(body) { return { operation: "tajweed", sessionId: body.sessionId }; },
      async transcribeSession(body) { return { operation: "transcript", sessionId: body.sessionId }; },
    },
    mlApiKey: "declared-compat-key",
    operationTimeoutMs: 1_000,
    anonymousRateLimit: 20,
    trustedRateLimit: 20,
    log: (message) => logs.push(message),
  });
  const worker = createJobWorker({
    db,
    store,
    runtime,
    audioObjectStore,
    compatibilityIngress,
    host: "127.0.0.1",
    port: 0,
    pollIntervalMs: 10,
    shutdownGraceMs: 200,
    metricsToken: "declared-metrics-token",
    metricsDevOpen: false,
    log: (message) => logs.push(message),
  });
  const audio = Buffer.from("private-recitation-bytes");
  const body = {
    tenantId: "tenant-a",
    learnerId: "learner-a",
    sessionId: "session-a",
    chunkId: "chunk-a",
    sampleRate: 16000,
    startMs: 0,
    endMs: 250,
    audioRetention: "teacher-review",
    audioBase64: audio.toString("base64"),
  };
  const post = (value, key = "declared-compat-key") => fetch(`${worker.url}/v1/audio-chunks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { "x-ml-api-key": key }),
    },
    body: JSON.stringify(value),
  });
  const postPath = (path, value, key = "declared-compat-key") => fetch(`${worker.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { "x-ml-api-key": key }),
    },
    body: JSON.stringify(value),
  });

  try {
    await worker.start();
    assert.equal((await post(body, null)).status, 401);
    assert.deepEqual(await audioObjectStore.listAll(), []);
    assert.equal((await fetch(`${worker.url}/v1/audit-events?tenantId=tenant-a`)).status, 401);
    assert.equal((await postPath("/v1/not-allowed", body)).status, 404, "allowlist widened");

    for (const [path, operation] of [
      ["/v1/alignments:predict", "alignment"],
      ["/v1/tajweed-findings:predict", "tajweed"],
      ["/v1/session-transcript", "transcript"],
    ]) {
      assert.equal((await postPath(path, body, null)).status, 401, `${path} was not key-gated`);
      const response = await postPath(path, body);
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.equal(payload.operation, operation);
    }

    const stored = await post(body);
    assert.equal(stored.status, 200, await stored.text());
    assert.equal((await post(body)).status, 200, "identical gateway retry must be idempotent");
    const persisted = await audioObjectStore.get(body);
    assert.deepEqual(persisted.audioBytes, audio);
    assert.equal(persisted.startMs, 0);
    assert.equal(persisted.endMs, 250);

    const read = await postPath("/v1/audio-objects:read", body);
    const readPayload = await read.json();
    assert.equal(read.status, 200, JSON.stringify(readPayload));
    assert.deepEqual(Buffer.from(readPayload.audioBase64, "base64"), audio);

    const exported = await postPath("/v1/privacy/export", body);
    const exportedPayload = await exported.json();
    assert.equal(exported.status, 200, JSON.stringify(exportedPayload));
    assert.equal(exportedPayload.audioObjectKeys.length, 1);

    const audit = await fetch(`${worker.url}/v1/audit-events?tenantId=tenant-a`, {
      headers: { "x-ml-api-key": "declared-compat-key" },
    });
    const auditPayload = await audit.json();
    assert.equal(audit.status, 200, JSON.stringify(auditPayload));
    assert.ok(Array.isArray(auditPayload));

    const conflict = await post({
      ...body,
      audioBase64: Buffer.from("different-private-recitation").toString("base64"),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual((await audioObjectStore.get(body)).audioBytes, audio, "conflict replaced stored audio");

    const oversized = await post({ ...body, audioBase64: "a".repeat(5_000_100) });
    assert.equal(oversized.status, 413);
    assert.equal(logs.join("\n").includes(body.audioBase64), false, "worker logged raw audio");

    const erased = await postPath("/v1/privacy/delete", body);
    const erasedPayload = await erased.json();
    assert.equal(erased.status, 200, JSON.stringify(erasedPayload));
    assert.equal(erasedPayload.deletedAudioObjectKeys.length, 1);
    assert.deepEqual(await audioObjectStore.listAll(), []);
  } finally {
    await worker.shutdown("compatibility-ingress-test");
    await sleep(10);
    rmSync(rootDir, { recursive: true, force: true });
  }
});
