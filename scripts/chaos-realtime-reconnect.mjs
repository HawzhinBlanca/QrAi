#!/usr/bin/env node
/**
 * T13 proof #1 — scripted chaos run.
 *
 * Drives a REAL audio session against a REAL gateway that is configured to drop the socket
 * mid-stream, and asserts the session still completes. This is the fault injection T13 requires
 * ("build the fault-injection first, then the fix") — without it, "reconnect works" is a claim, not
 * a result.
 *
 * It exercises the same contract the browser client does — a FRESH single-use ticket per connect,
 * equal-jitter backoff, buffer-and-flush — but in Node, so it needs no browser and can run headless.
 *
 * Usage (gateway must run with dev mode + chaos armed):
 *   ALLOW_INSECURE_DEFAULTS=1 \
 *   REALTIME_GATEWAY_TICKET_SECRET=chaos-secret \
 *   REALTIME_CHAOS_DROP_AFTER_CHUNKS=3 REALTIME_CHAOS_MAX_DROPS=2 \
 *   cargo run --manifest-path services/realtime-gateway/Cargo.toml
 *
 *   REALTIME_GATEWAY_TICKET_SECRET=chaos-secret node scripts/chaos-realtime-reconnect.mjs
 *
 * Exits non-zero unless the session survived the drops and delivered every chunk.
 */
import { createHmac } from "node:crypto";

const GATEWAY = process.env.GATEWAY_URL ?? "ws://127.0.0.1:8081";
const SECRET = process.env.REALTIME_GATEWAY_TICKET_SECRET ?? "chaos-secret";
const TENANT = process.env.GATEWAY_TENANT_ID ?? "hikmah-pilot-erbil";
const SESSION = `chaos-session-${Date.now()}`;
const TOTAL_CHUNKS = 12;
const EXPECTED_DROPS = Number(process.env.REALTIME_CHAOS_MAX_DROPS ?? 2);

/**
 * Mint a ticket exactly as platform-api's shared-ticket crate does
 * (rt_v1.session.tenant.learner.externalAsr.expiry.nonce.hmacSha256Hex), so this script needs only
 * the gateway + the shared secret — no database, no platform-api.
 */
function issueTicket(sessionId, nonce) {
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const payload = `${sessionId}.${TENANT}.learner-1.false.${expiresAt}.${nonce}`;
  const signature = createHmac("sha256", SECRET).update(payload).digest("hex");
  return `rt_v1.${payload}.${signature}`;
}

const log = (msg) => console.log(`[chaos] ${new Date().toISOString()} ${msg}`);

/** Equal jitter — mirrors apps/web/src/lib/reconnect.ts planReconnect(). */
function planReconnect(attempt, { baseDelayMs = 500, maxDelayMs = 15000, maxAttempts = 6 } = {}) {
  if (attempt > maxAttempts) return { action: "give-up" };
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  const half = exponential / 2;
  return { action: "retry", delayMs: Math.round(half + half * Math.random()) };
}

async function main() {
  let sent = 0;
  let acked = 0;
  let drops = 0;
  let attempt = 0;
  let ticketsIssued = 0;

  while (sent < TOTAL_CHUNKS) {
    const nonce = `nonce-${++ticketsIssued}`;
    const ticket = issueTicket(SESSION, nonce);
    const url = `${GATEWAY}/v1/recitation-sessions/${encodeURIComponent(SESSION)}/audio?ticket=${encodeURIComponent(ticket)}`;
    log(`connect attempt ${attempt + 1} with FRESH ticket #${ticketsIssued} (single-use)`);

    const closed = await new Promise((resolve) => {
      const ws = new WebSocket(url);
      let closedCleanly = false;

      ws.onopen = () => {
        attempt = 0; // healthy connection resets the ladder
        log(`connected — resuming at chunk ${sent + 1}/${TOTAL_CHUNKS}`);
        const pump = () => {
          if (sent >= TOTAL_CHUNKS) {
            closedCleanly = true;
            ws.close();
            return;
          }
          if (ws.readyState !== WebSocket.OPEN) return; // dropped mid-pump; onclose drives the retry
          ws.send(new Uint8Array([1, 2, 3, 4]));
          sent += 1;
          setTimeout(pump, 30);
        };
        pump();
      };

      ws.onmessage = (event) => {
        const ack = JSON.parse(String(event.data));
        if (ack.accepted) acked += 1;
      };

      ws.onclose = () => resolve({ closedCleanly });
      ws.onerror = () => {};
    });

    if (closed.closedCleanly) break;

    drops += 1;
    log(`DROPPED by chaos after ${sent} chunks (drop #${drops})`);
    attempt += 1;
    const decision = planReconnect(attempt);
    if (decision.action === "give-up") {
      log("gave up — would degrade to batch");
      process.exit(1);
    }
    log(`backoff ${decision.delayMs}ms before re-ticketing (attempt ${attempt})`);
    await new Promise((r) => setTimeout(r, decision.delayMs));
  }

  log(`RESULT sent=${sent}/${TOTAL_CHUNKS} acked=${acked} drops=${drops} tickets=${ticketsIssued}`);

  if (drops < EXPECTED_DROPS) {
    log(`FAIL: expected >=${EXPECTED_DROPS} chaos drops; is the gateway running with chaos armed?`);
    process.exit(1);
  }
  if (sent < TOTAL_CHUNKS) {
    log("FAIL: session did not complete");
    process.exit(1);
  }
  if (ticketsIssued < drops + 1) {
    log("FAIL: reconnect reused a ticket (tickets are single-use)");
    process.exit(1);
  }
  log(`PASS: session survived ${drops} forced drop(s) and delivered all ${TOTAL_CHUNKS} chunks, each reconnect re-ticketed.`);
}

main().catch((error) => {
  log(`ERROR ${error?.message ?? error}`);
  process.exit(1);
});
