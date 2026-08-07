import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  TENANT,
  queryJson,
  request,
  reservePort,
  startApi,
} from "../../api-parity/lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixtureDir = join(root, "tests", "fixtures", "audio");
export const realAudioManifest = JSON.parse(
  readFileSync(join(fixtureDir, "AlFatihatulKitab.manifest.json"), "utf8"),
);
export const realAudioPcm = readFileSync(
  join(fixtureDir, realAudioManifest.derivedPcm.file),
);
export const realAudioCapture = JSON.parse(
  readFileSync(join(fixtureDir, realAudioManifest.capture.file), "utf8"),
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForHealth(url, label, stderr) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Process has not bound yet.
    }
    await sleep(100);
  }
  assert.fail(`${label} never became healthy at ${url}\n${stderr()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt += 1) {
    await sleep(25);
  }
  if (child.exitCode === null) child.kill("SIGKILL");
}

function windowedCapture(windowIndex) {
  // The 92.71 s stream becomes cores [0,90) and [90,end), with contexts [0,92) and [88,end).
  // Replaying the independently captured response in those local coordinates exercises the real
  // bounded-window composition without presenting the capture as a model evaluation.
  const contextStart = windowIndex === 0 ? 0 : 88;
  const words = realAudioCapture.words
    .filter((word) => (word.start + word.end) / 2 >= contextStart)
    .map((word) => ({
      ...word,
      start: Number((word.start - contextStart).toFixed(3)),
      end: Number((word.end - contextStart).toFixed(3)),
    }));
  return {
    ...realAudioCapture,
    text: words.map((word) => word.word).join(" "),
    duration:
      windowIndex === 0
        ? 92
        : realAudioPcm.length / 2 / realAudioManifest.derivedPcm.sampleRate - 88,
    words,
  };
}

/**
 * Start the actual ML process, a captured-real-response ASR worker, a transparent recording proxy,
 * the Rust API, and one isolated live-Postgres session. Call `stop()` in a test hook.
 */
export async function startRealAudioFinalizeHarness(label) {
  assert.equal(realAudioPcm.length, realAudioManifest.derivedPcm.byteLength);
  assert.equal(sha256(realAudioPcm), realAudioManifest.derivedPcm.sha256);
  assert.equal(
    realAudioManifest.evidenceEligibility,
    "integration-fixture-only-not-model-evaluation",
  );

  const mlKey = `${label}-ml-key`;
  const asrKey = `${label}-asr-key`;
  let mlStderr = "";
  let asrRequests = 0;
  const mlCalls = [];

  const asrPort = await reservePort();
  const asrServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      assert.equal(req.url, "/v1/transcribe");
      assert.equal(req.headers["x-asr-api-key"], asrKey);
      const body = JSON.parse(raw);
      assert.equal(body.audioFormat, "wav");
      assert.equal(body.language, "ar");
      assert.ok(body.audioBase64.length > 1000, "the real PCM window did not reach ASR");
      const response = windowedCapture(asrRequests % 2);
      asrRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((resolve, reject) => {
    asrServer.once("error", reject);
    asrServer.listen(asrPort, "127.0.0.1", resolve);
  });

  const storageDir = mkdtempSync(join(tmpdir(), `qrai-${label}-`));
  const mlPort = await reservePort();
  const mlProcess = spawn(process.execPath, [join(root, "services/ml-inference/server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      AUDIO_STORAGE_DIR: storageDir,
      ML_INFERENCE_HOST: "127.0.0.1",
      ML_INFERENCE_PORT: String(mlPort),
      ML_API_KEY: mlKey,
      ASR_SERVICE_URL: `http://127.0.0.1:${asrPort}`,
      ASR_API_KEY: asrKey,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  mlProcess.stderr.on("data", (chunk) => {
    mlStderr += chunk.toString();
  });
  const mlUrl = `http://127.0.0.1:${mlPort}`;
  await waitForHealth(`${mlUrl}/health`, "ml-inference", () => mlStderr);

  // The proxy changes no request/response bytes. It records the exact producer envelope that the
  // Rust finalizer received, which lets the test compare inference → DB → restricted readback.
  const recordingProxy = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", async () => {
      try {
        const upstream = await fetch(`${mlUrl}${req.url}`, {
          method: req.method,
          headers: {
            "content-type": req.headers["content-type"] ?? "application/json",
            "x-ml-api-key": req.headers["x-ml-api-key"] ?? mlKey,
          },
          body: raw,
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        const response = JSON.parse(bytes.toString("utf8"));
        mlCalls.push({ path: req.url, request: JSON.parse(raw), response });
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(bytes);
      } catch (error) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "proxy failure" }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    recordingProxy.once("error", reject);
    recordingProxy.listen(0, "127.0.0.1", resolve);
  });
  const proxyAddress = recordingProxy.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;

  const api = await startApi({ env: { ML_INFERENCE_URL: proxyUrl, ML_API_KEY: mlKey } });
  const created = await request(api.baseUrl, "/v1/recitation-sessions", {
    method: "POST",
    role: "learner",
    body: {
      learnerId: "learner-1",
      quranRef: {
        surahNumber: 1,
        ayahStart: 1,
        ayahEnd: 7,
        display: "Al-Fatihah 1:1-7",
      },
      sourceChecksum: `fixture:${label}`,
      language: "ckb",
      mode: "guided-recite",
      practicePlanId: label,
      consent: {
        audioRetention: "teacher-review",
        anonymizedLearning: false,
        externalAsrProcessing: true,
        guardianApproved: true,
        consentVersion: `${label}-integration-fixture`,
      },
    },
  });
  assert.equal(created.status, 200, created.text);
  const sessionId = created.body.id;
  const [session] = await queryJson(
    "SELECT consent_record_id, audit_event_id, model_version_id FROM recitation_sessions WHERE id = $1",
    [sessionId],
  );

  const durationMs = Math.round(
    (realAudioPcm.length / 2 / realAudioManifest.derivedPcm.sampleRate) * 1000,
  );
  const stored = await fetch(`${mlUrl}/v1/audio-chunks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ml-api-key": mlKey },
    body: JSON.stringify({
      tenantId: TENANT,
      learnerId: "learner-1",
      sessionId,
      chunkId: `${sessionId}-ws-0000`,
      sampleRate: realAudioManifest.derivedPcm.sampleRate,
      startMs: 0,
      endMs: durationMs,
      audioRetention: "teacher-review",
      audioBase64: realAudioPcm.toString("base64"),
    }),
  });
  assert.equal(stored.status, 200, await stored.text());

  return {
    api,
    sessionId,
    sessionModelVersion: session.model_version_id,
    mlCalls,
    getAsrRequests: () => asrRequests,
    async stop() {
      try {
        const alignmentAudits = await queryJson(
          "SELECT DISTINCT audit_event_id FROM word_alignments WHERE session_id = $1",
          [sessionId],
        );
        await queryJson("DELETE FROM teacher_reviews WHERE finding_id IN (SELECT tf.id FROM tajweed_findings tf JOIN word_alignments wa ON wa.id = tf.alignment_id WHERE wa.session_id = $1)", [sessionId]);
        await queryJson("DELETE FROM tajweed_findings WHERE alignment_id IN (SELECT id FROM word_alignments WHERE session_id = $1)", [sessionId]);
        await queryJson("DELETE FROM word_alignments WHERE session_id = $1", [sessionId]);
        await queryJson("DELETE FROM audio_chunks WHERE session_id = $1", [sessionId]);
        await queryJson("DELETE FROM alignment_runs WHERE session_id = $1", [sessionId]);
        await queryJson("DELETE FROM realtime_session_tickets WHERE session_id = $1", [sessionId]);
        await queryJson("DELETE FROM recitation_sessions WHERE id = $1", [sessionId]);
        await queryJson("DELETE FROM consent_records WHERE id = $1", [session.consent_record_id]);
        const auditIds = [
          session.audit_event_id,
          ...alignmentAudits.map((row) => row.audit_event_id),
        ].filter(Boolean);
        if (auditIds.length > 0) {
          await queryJson("DELETE FROM audit_events WHERE id = ANY($1::text[])", [auditIds]);
        }
      } finally {
        await api.stop();
        await new Promise((resolve) => recordingProxy.close(resolve));
        await stopChild(mlProcess);
        await new Promise((resolve) => asrServer.close(resolve));
        rmSync(storageDir, { recursive: true, force: true });
      }
    },
  };
}
