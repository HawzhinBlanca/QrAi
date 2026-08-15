#!/usr/bin/env node
/**
 * Manual W3.7 candidate chaos probe.
 *
 * Unlike the retired T13 script, this probe never mints a ticket locally and never equates
 * WebSocket `send()` with delivery. It obtains every single-use ticket from the platform API,
 * drives the frozen recovery controller, submits the exact recovery report to finalization, and
 * succeeds only when every captured chunk is acknowledged or explicitly accounted as dropped or
 * uncertain. By default any degraded recording fails the command.
 *
 * Required:
 *   CHAOS_SESSION_ID      existing learner-owned recitation session
 *   CHAOS_AUTHORIZATION   e.g. "Bearer ..." (preferred), or the three dev actor variables below
 *   PLATFORM_URL          defaults to http://127.0.0.1:8083
 *   GATEWAY_URL           defaults to ws://127.0.0.1:8081
 *
 * Development-only actor fallback:
 *   CHAOS_TENANT_ID, CHAOS_USER_ID, CHAOS_ROLE
 */
import { fileURLToPath } from "node:url";

import { createRealtimeRecoveryController } from "./lib/realtime-recovery-client.mjs";

const PLATFORM = (process.env.PLATFORM_URL ?? "http://127.0.0.1:8083").replace(/\/$/, "");
const GATEWAY = (process.env.GATEWAY_URL ?? "ws://127.0.0.1:8081").replace(/\/$/, "");
const SESSION = process.env.CHAOS_SESSION_ID;
const TOTAL_CHUNKS = Number(process.env.CHAOS_TOTAL_CHUNKS ?? 12);
const CHUNK_INTERVAL_MS = Number(process.env.CHAOS_CHUNK_INTERVAL_MS ?? 30);
const ALLOW_DEGRADED = process.env.CHAOS_ALLOW_DEGRADED === "true";

const log = (message) => console.log(`[recovery-chaos] ${new Date().toISOString()} ${message}`);

function positiveWhole(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function actorHeaders() {
  const authorization = process.env.CHAOS_AUTHORIZATION;
  if (typeof authorization === "string" && authorization.trim() !== "") {
    return { authorization };
  }
  const tenantId = process.env.CHAOS_TENANT_ID;
  const userId = process.env.CHAOS_USER_ID;
  const role = process.env.CHAOS_ROLE;
  if (![tenantId, userId, role].every((value) => typeof value === "string" && value !== "")) {
    throw new TypeError(
      "CHAOS_AUTHORIZATION or CHAOS_TENANT_ID/CHAOS_USER_ID/CHAOS_ROLE is required",
    );
  }
  return { "x-tenant-id": tenantId, "x-user-id": userId, "x-role": role };
}

async function jsonRequest(path, { body, headers }) {
  const response = await fetch(`${PLATFORM}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || parsed === null || typeof parsed !== "object") {
    throw new Error(`platform request failed with status ${response.status}`);
  }
  return parsed;
}

function websocketBoundary(url, handlers) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = handlers.onOpen;
  ws.onmessage = (event) => handlers.onMessage(
    typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"),
  );
  ws.onclose = handlers.onClose;
  ws.onerror = handlers.onError;
  return {
    send: (bytes) => ws.send(bytes),
    close: () => ws.close(),
  };
}

export async function runRealtimeRecoveryChaos({
  sessionId = SESSION,
  totalChunks = TOTAL_CHUNKS,
  intervalMs = CHUNK_INTERVAL_MS,
  allowDegraded = ALLOW_DEGRADED,
} = {}) {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new TypeError("CHAOS_SESSION_ID is required");
  }
  positiveWhole(totalChunks, "CHAOS_TOTAL_CHUNKS", 100_000);
  positiveWhole(intervalMs, "CHAOS_CHUNK_INTERVAL_MS", 60_000);
  const headers = actorHeaders();
  let ticketsIssued = 0;
  let captureTimer = null;
  let captured = 0;
  let report = null;
  let finalization = null;

  const controller = createRealtimeRecoveryController({
    sessionId,
    getUrl: async () => {
      const ticket = await jsonRequest("/v1/realtime-session-tickets", {
        headers,
        body: { sessionId, requestedSampleRates: [16_000] },
      });
      if (typeof ticket.token !== "string" || ticket.token === "") {
        throw new Error("platform ticket response omitted the token");
      }
      ticketsIssued += 1;
      return `${GATEWAY}/v1/recitation-sessions/${encodeURIComponent(sessionId)}/audio` +
        `?ticket=${encodeURIComponent(ticket.token)}`;
    },
    openSocket: websocketBoundary,
    stopCapture: async () => {
      if (captureTimer !== null) clearInterval(captureTimer);
      captureTimer = null;
    },
    finalize: async (recoveryReport) => {
      report = recoveryReport;
      finalization = await jsonRequest(
        `/v1/recitation-sessions/${encodeURIComponent(sessionId)}/finalize`,
        { headers, body: { recoveryReport } },
      );
    },
    onStateChange: (state) => log(`state=${state}`),
    onError: (reason) => log(`outcome=${reason}`),
  });

  await controller.start();
  captureTimer = setInterval(() => {
    if (captured >= totalChunks) {
      clearInterval(captureTimer);
      captureTimer = null;
      void controller.stop();
      return;
    }
    // Declared deterministic PCM fixture bytes, not model or learner audio.
    controller.capture(Buffer.alloc(15_360, captured % 251));
    captured += 1;
  }, intervalMs);
  captureTimer.unref?.();

  await controller.done;
  if (report === null || finalization === null) throw new Error("recovery finalization did not run");
  const accounted = report.acknowledgedChunks + report.droppedChunks + report.uncertainChunks;
  if (accounted !== report.capturedChunks || report.capturedChunks !== captured) {
    throw new Error(
      `capture accounting failed: captured=${captured} report=${report.capturedChunks} accounted=${accounted}`,
    );
  }
  if (!allowDegraded && report.state !== "complete") {
    throw new Error(
      `recording degraded: reason=${report.stopReason} dropped=${report.droppedChunks} ` +
        `uncertain=${report.uncertainChunks}`,
    );
  }
  if (finalization.recordingStatus !== (report.state === "complete" ? "complete" : "incomplete")) {
    throw new Error("platform finalization did not preserve the recovery integrity state");
  }
  log(
    `PASS state=${report.state} captured=${report.capturedChunks} ` +
      `acknowledged=${report.acknowledgedChunks} dropped=${report.droppedChunks} ` +
      `uncertain=${report.uncertainChunks} tickets=${ticketsIssued}`,
  );
  return { report, finalization, ticketsIssued };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runRealtimeRecoveryChaos().catch((error) => {
    log(`FAIL ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  });
}
