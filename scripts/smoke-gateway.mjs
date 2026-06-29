import { createHmac, randomUUID } from "node:crypto";

const baseUrl = process.env.REALTIME_GATEWAY_BASE_URL ?? "ws://127.0.0.1:8081";
const secret = process.env.REALTIME_GATEWAY_TICKET_SECRET ?? "smoke-secret";
const sessionId = process.env.REALTIME_GATEWAY_SMOKE_SESSION_ID ?? `smoke-session-${Date.now()}`;
const tenantId = process.env.REALTIME_GATEWAY_SMOKE_TENANT_ID ?? "tenant-smoke";
const learnerId = process.env.REALTIME_GATEWAY_SMOKE_LEARNER_ID ?? "learner-smoke";
const smokeTraceId = process.env.SMOKE_TRACE_ID ?? `smoke-trace-${randomUUID()}`;
const validUrl =
  process.env.REALTIME_GATEWAY_SMOKE_URL ??
  audioUrl(sessionId, issueTicket({ sessionId, tenantId, learnerId, expiresAt: nowSeconds() + 60, nonce: randomUUID(), secret }));
const missingTicketUrl =
  process.env.REALTIME_GATEWAY_MISSING_TICKET_SMOKE_URL ?? audioUrl(sessionId);
const expiredTicketUrl = audioUrl(
  sessionId,
  issueTicket({ sessionId, tenantId, learnerId, expiresAt: nowSeconds() - 1, nonce: randomUUID(), secret }),
);
const mismatchedTicketUrl = audioUrl(
  sessionId,
  issueTicket({ sessionId: `${sessionId}-other`, tenantId, learnerId, expiresAt: nowSeconds() + 60, nonce: randomUUID(), secret }),
);

if (typeof WebSocket === "undefined") {
  console.error("Node WebSocket global is unavailable.");
  process.exit(1);
}

await expectRejected(missingTicketUrl, "missing ticket");
await expectRejected(expiredTicketUrl, "expired ticket");
await expectRejected(mismatchedTicketUrl, "session-mismatched ticket");

const ack = await sendAudio(validUrl);
if (ack.kind !== "audio.ack" || ack.accepted !== true || ack.session_id !== sessionId || ack.trace_id !== smokeTraceId) {
  console.error(`unexpected gateway ack: ${JSON.stringify(ack)}`);
  process.exit(1);
}

await expectRejected(validUrl, "replayed ticket");

console.log(
  JSON.stringify({
    sessionId,
    traceId: smokeTraceId,
    tenantId,
    learnerId,
    accepted: ack.accepted,
    rejected: ["missing", "expired", "session-mismatch", "replay"],
    sequence: ack.sequence,
  }),
);

function audioUrl(targetSessionId, ticket) {
  const params = new URLSearchParams();
  if (ticket) {
    params.set("ticket", ticket);
  }
  params.set("trace_id", smokeTraceId);
  return `${baseUrl}/v1/recitation-sessions/${encodeURIComponent(targetSessionId)}/audio?${params.toString()}`;
}

function issueTicket({ sessionId, tenantId, learnerId, externalAsrProcessing = true, expiresAt, nonce, secret }) {
  const payload = `${sessionId}.${tenantId}.${learnerId}.${externalAsrProcessing}.${expiresAt}.${nonce}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `rt_v1.${sessionId}.${tenantId}.${learnerId}.${externalAsrProcessing}.${expiresAt}.${nonce}.${signature}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function expectRejected(url, label) {
  const rejected = await new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 1000);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      socket.close();
      resolve(false);
    });
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve(true);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });

  if (!rejected) {
    console.error(`websocket smoke expected ${label} to be rejected`);
    process.exit(1);
  }
}

function sendAudio(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`websocket smoke timed out: ${url}`));
    }, 3000);

    socket.addEventListener("open", () => {
      socket.send(new Uint8Array([1, 2, 3, 4]));
    });

    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      const payload = String(event.data);
      socket.close();
      try {
        resolve(JSON.parse(payload));
      } catch (error) {
        reject(new Error(`invalid gateway ack JSON: ${error.message}: ${payload}`));
      }
    });

    socket.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(new Error(`websocket smoke failed: ${event.message || event.type}`));
    });
  });
}
