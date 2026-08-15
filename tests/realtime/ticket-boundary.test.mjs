import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createRealtimeAdmission,
  REALTIME_ADMISSION_OUTCOMES,
} from "../../server/src/realtime/admission.mjs";
import {
  createRealtimeApplication,
  parseRealtimeConfig,
} from "../../server/src/realtime/main.mjs";
import { issueRealtimeTicket } from "../../server/src/lib/ticket.mjs";
import { buildHostileTicketCases } from "./ticket-hostile-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const fixture = JSON.parse(readFileSync(
  join(repo, "packages/contracts/fixtures/realtime/rt-v2-ticket-vectors.json"),
  "utf8",
));

const ORIGIN = "https://quran.example.org";
const SECRET = "w3.3-admission-ticket-secret-over-32-bytes";
const TENANT = "tenant-w3-3";
const SESSION = "session-w3-3";
const LEARNER = "learner-w3-3";
const NOW_SECONDS = 2_000_000_000;

function ticket(overrides = {}, secret = SECRET) {
  return issueRealtimeTicket({
    sessionId: SESSION,
    tenantId: TENANT,
    learnerId: LEARNER,
    externalAsrProcessing: false,
    audioRetention: "discard",
    expiresAtUnixSeconds: NOW_SECONDS + 300,
    nonce: "nonce-w3-3",
    ...overrides,
  }, secret);
}

function boundary(overrides = {}) {
  return createRealtimeAdmission({
    ticketSecret: SECRET,
    tenantId: TENANT,
    allowedOrigins: [ORIGIN],
    allowMissingOrigin: false,
    rateLimitEnabled: true,
    replayClaim: async () => "fresh",
    nowUnixSeconds: () => NOW_SECONDS,
    ...overrides,
  });
}

function acceptedInput(overrides = {}) {
  return {
    sessionId: SESSION,
    ticket: ticket(),
    origin: ORIGIN,
    clientIp: "127.0.0.1",
    traceId: null,
    ...overrides,
  };
}

function appOptions(overrides = {}) {
  return {
    db: { assertRestrictedRole: async () => {}, end: async () => {} },
    audioObjectStore: {
      assertReady: async () => {},
      close: async () => {},
      put: async () => ({ created: true }),
    },
    workerReadyUrl: "http://worker:8098/ready",
    asrReadyUrl: "http://asr:8091/ready",
    readinessTimeoutMs: 100,
    shutdownGraceMs: 8_000,
    metricsToken: null,
    metricsDevOpen: true,
    fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} } }),
    ticketSecret: SECRET,
    tenantId: TENANT,
    allowedOrigins: [ORIGIN],
    allowMissingOrigin: false,
    rateLimitEnabled: true,
    trustedProxyHops: 0,
    replayAuthority: {
      claim: async () => "fresh",
      renderMetrics: () => "",
      start: () => {},
      stop: async () => {},
    },
    audioOutcomeAuthority: {
      stored: async ({ identity }) => identity.audioRetention === "discard" ? "discarded" : "indexed",
      lost: async () => "accepted_lost",
      lostMany: async () => "accepted_lost",
    },
    admissionNowUnixSeconds: () => NOW_SECONDS,
    handleAdmittedSocket(socket) {
      socket.close(1013, "test fixture complete");
    },
    logger: false,
    ...overrides,
  };
}

function closeCodeFromFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 4 || (frame[0] & 0x0f) !== 0x08) return null;
  const length = frame[1] & 0x7f;
  if (length < 2 || length > 125 || frame.length < length + 2) return null;
  return frame.readUInt16BE(2);
}

function rawUpgrade({ port, path, origin, forwardedFor }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const headers = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": Buffer.alloc(16, 7).toString("base64"),
      "Sec-WebSocket-Version": "13",
    };
    if (origin !== undefined) headers.Origin = origin;
    if (forwardedFor !== undefined) headers["X-Forwarded-For"] = forwardedFor;
    // A rejected upgrade is intentionally closed by the plugin; never let Node's global
    // keep-alive agent reuse that closing transport for the next security case.
    const req = httpRequest({ agent: false, host: "127.0.0.1", port, path, headers });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`upgrade timed out for ${path}`));
    }, 2_000);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    req.once("response", (response) => {
      // @fastify/websocket deliberately destroys a rejected upgrade socket after Fastify emits
      // the HTTP response. Capture the authenticated status/headers immediately; Node may report
      // that deliberate post-response destroy as ECONNRESET before an `end` event.
      response.once("error", () => {});
      response.resume();
      finish({
        body: "",
        closeCode: null,
        headers: response.headers,
        statusCode: response.statusCode,
      });
    });
    req.once("upgrade", (response, socket, head) => {
      let frame = Buffer.from(head);
      socket.once("error", (error) => {
        if (!settled) reject(error);
      });
      const complete = () => {
        const closeCode = closeCodeFromFrame(frame);
        if (closeCode === null) return false;
        finish({ body: "", closeCode, headers: response.headers, statusCode: response.statusCode });
        socket.destroy();
        return true;
      };
      if (complete()) return;
      socket.on("data", (chunk) => {
        frame = Buffer.concat([frame, chunk]);
        complete();
      });
      socket.once("close", () => {
        if (closeCodeFromFrame(frame) === null) {
          finish({ body: "", closeCode: null, headers: response.headers, statusCode: response.statusCode });
        }
      });
    });
    req.once("error", (error) => {
      if (!settled) reject(error);
    });
    req.end();
  });
}

async function withListeningApp(options, body) {
  const app = createRealtimeApplication(options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    return await body(app, app.server.address().port);
  } finally {
    await app.close();
  }
}

test("all six Rust-generated rt_v2 vectors cross the admission boundary byte-identically", async () => {
  assert.equal(fixture.vectorCount, 6);
  assert.equal(fixture.vectors.length, 6);
  for (const vector of fixture.vectors) {
    const expiresAt = BigInt(vector.expiresAtUnixSeconds);
    const admission = createRealtimeAdmission({
      ticketSecret: vector.secret,
      tenantId: vector.tenantId,
      allowedOrigins: [ORIGIN],
      allowMissingOrigin: false,
      rateLimitEnabled: true,
      replayClaim: async () => "fresh",
      nowUnixSeconds: () => expiresAt - 1n,
    });
    const result = await admission.admit({
      sessionId: vector.sessionId,
      ticket: vector.expectedTicket,
      origin: ORIGIN,
      clientIp: "127.0.0.1",
      traceId: " trace-vector ",
    });
    assert.equal(result.accepted, true, vector.name);
    assert.equal(result.claims.expiresAtUnixSeconds, expiresAt, vector.name);
    assert.equal(result.traceId, "trace-vector", vector.name);
    assert.ok(Object.isFrozen(result), vector.name);
    assert.ok(Object.isFrozen(result.claims), vector.name);
    assert.deepEqual(Object.keys(result).sort(), ["accepted", "claims", "traceId"]);
    assert.equal("ticket" in result, false, vector.name);
    assert.equal("ticket" in result.claims, false, vector.name);
  }
});

test("the Node boundary executes the exact hostile ticket corpus used by the Rust process sweep", async () => {
  const admission = boundary();
  const cases = buildHostileTicketCases({
    validTicket: (overrides) => ticket(overrides),
    sessionId: SESSION,
    tenantId: TENANT,
    learnerId: LEARNER,
    nowUnixSeconds: NOW_SECONDS,
  });
  assert.deepEqual(cases.map(({ name }) => name), [
    "empty",
    "wrong prefix",
    "too few parts",
    "too many parts",
    "100 000 characters",
    "a NUL byte",
    "negative expiry",
    "non-numeric expiry",
    "non-boolean consent",
    "blank retention",
    "short signature",
    "non-hex signature",
    "a pre-retention v1 ticket",
    "another tenant",
    "another session",
  ]);
  for (const { name, ticket: hostileTicket } of cases) {
    const result = await admission.admit(acceptedInput({ ticket: hostileTicket }));
    assert.deepEqual(result, {
      accepted: false,
      outcome: "ticket_rejected",
      retryAfterSeconds: null,
      statusCode: 401,
    }, name);
  }
});

test("signature precedes tenant/lifetime policy and every ticket refusal is one generic class", async () => {
  const admission = boundary();
  const rejected = [
    acceptedInput({ ticket: ticket({}, "another-secret-over-thirty-two-bytes") }),
    acceptedInput({ ticket: ticket({ tenantId: "another-tenant" }) }),
    acceptedInput({ ticket: ticket({ expiresAtUnixSeconds: NOW_SECONDS }) }),
    acceptedInput({ ticket: ticket({ expiresAtUnixSeconds: NOW_SECONDS + 3_601 }) }),
  ];
  for (const input of rejected) {
    assert.deepEqual(await admission.admit(input), {
      accepted: false,
      outcome: "ticket_rejected",
      retryAfterSeconds: null,
      statusCode: 401,
    });
  }

  const boundaryValue = await admission.admit(acceptedInput({
    ticket: ticket({
      audioRetention: "future-non-empty-retention",
      expiresAtUnixSeconds: NOW_SECONDS + 3_600,
    }),
  }));
  assert.equal(boundaryValue.accepted, true);
  assert.equal(boundaryValue.claims.audioRetention, "future-non-empty-retention");
});

test("Origin and native no-Origin policies are separate and exact", async () => {
  const strict = boundary();
  for (const origin of [undefined, "", "null", `${ORIGIN}/`, ` ${ORIGIN}`, `${ORIGIN}, https://evil.example`]) {
    const result = await strict.admit(acceptedInput({ origin }));
    assert.equal(result.accepted, false, JSON.stringify(origin));
    assert.equal(result.outcome, "origin_rejected", JSON.stringify(origin));
    assert.equal(result.statusCode, 403, JSON.stringify(origin));
  }

  const native = boundary({ allowMissingOrigin: true });
  assert.equal((await native.admit(acceptedInput({ origin: undefined }))).accepted, true);
  const disallowed = await native.admit(acceptedInput({ origin: "https://evil.example" }));
  assert.equal(disallowed.accepted, false);
  assert.equal(disallowed.outcome, "origin_rejected");
});

test("the bounded token bucket admits 200 by default, refills at 50 ms, and reports only fixed outcomes", async () => {
  let nowMs = 0;
  const admission = boundary({
    rateLimitOptions: { capacity: 2, refillIntervalMs: 50, now: () => nowMs },
  });
  assert.equal((await admission.admit(acceptedInput())).accepted, true);
  assert.equal((await admission.admit(acceptedInput())).accepted, true);
  assert.deepEqual(await admission.admit(acceptedInput()), {
    accepted: false,
    outcome: "rate_rejected",
    retryAfterSeconds: 1,
    statusCode: 429,
  });
  nowMs = 50;
  assert.equal((await admission.admit(acceptedInput())).accepted, true);
  assert.deepEqual(REALTIME_ADMISSION_OUTCOMES, Object.freeze([
    "accepted",
    "origin_rejected",
    "ticket_rejected",
    "rate_rejected",
    "replay_rejected",
    "replay_unavailable",
  ]));
  const metrics = admission.renderMetrics();
  for (const outcome of REALTIME_ADMISSION_OUTCOMES) {
    assert.match(metrics, new RegExp(`realtime_admission_total\\{outcome="${outcome}"\\} [0-9]+`));
  }
  assert.doesNotMatch(
    metrics,
    /tenant=|learner=|session=|trace=|ticket=|origin=|url=|exception=/i,
  );
});

test("configuration refuses weak secrets, malformed origins, inert proxy settings, and ambiguous switches", () => {
  const base = {
    DATABASE_URL: "postgresql://restricted@127.0.0.1/quran_ai",
    REALTIME_GATEWAY_TICKET_SECRET: SECRET,
    GATEWAY_TENANT_ID: TENANT,
    CORS_ALLOWED_ORIGINS: `${ORIGIN},https://teacher.example.org:8443`,
  };
  const parsed = parseRealtimeConfig(base);
  assert.deepEqual(parsed.allowedOrigins, [ORIGIN, "https://teacher.example.org:8443"]);
  assert.equal(parsed.allowMissingOrigin, false);
  assert.equal(parsed.rateLimitEnabled, true);
  assert.equal(parsed.ticketSecret, SECRET);
  assert.equal(parsed.tenantId, TENANT);
  assert.equal(parsed.trustedProxyHops, 0);

  for (const [name, env] of [
    ["missing tenant", { ...base, GATEWAY_TENANT_ID: "" }],
    ["missing secret", { ...base, REALTIME_GATEWAY_TICKET_SECRET: "" }],
    ["weak secret", { ...base, REALTIME_GATEWAY_TICKET_SECRET: "smoke-secret" }],
    ["short secret", { ...base, REALTIME_GATEWAY_TICKET_SECRET: "short" }],
    ["origin path", { ...base, CORS_ALLOWED_ORIGINS: `${ORIGIN}/path` }],
    ["origin credentials", { ...base, CORS_ALLOWED_ORIGINS: "https://user:secret@example.org" }],
    ["origin duplicate", { ...base, CORS_ALLOWED_ORIGINS: `${ORIGIN},${ORIGIN}` }],
    ["invalid native switch", { ...base, GATEWAY_ALLOW_MISSING_ORIGIN: "yes" }],
    ["invalid rate switch", { ...base, DISABLE_RATE_LIMIT: "yes" }],
    ["inert hops", { ...base, TRUST_PROXY_HOPS: "1" }],
    ["invalid trust switch", { ...base, TRUST_PROXY_HEADERS: "yes" }],
    ["zero hops", { ...base, TRUST_PROXY_HEADERS: "1", TRUST_PROXY_HOPS: "0" }],
    ["too many hops", { ...base, TRUST_PROXY_HEADERS: "1", TRUST_PROXY_HOPS: "33" }],
  ]) {
    assert.throws(() => parseRealtimeConfig(env), undefined, name);
  }
});

test("only the exact authorized route upgrades before the explicit admission-only fixture closes", async () => {
  await withListeningApp(appOptions(), async (_app, port) => {
    const validPath = `/v1/recitation-sessions/${SESSION}/audio?ticket=${encodeURIComponent(ticket())}&trace_id=trace-real`;
    for (const [name, attempt, expectedStatus] of [
      ["missing ticket", { port, path: `/v1/recitation-sessions/${SESSION}/audio`, origin: ORIGIN }, 401],
      ["bad Origin", { port, path: validPath, origin: "https://evil.example" }, 403],
      ["missing Origin", { port, path: validPath }, 403],
      ["near-miss route", { port, path: `/v1/recitation-sessions/${SESSION}/audio-near?ticket=${encodeURIComponent(ticket())}`, origin: ORIGIN }, 404],
    ]) {
      let result;
      try {
        result = await rawUpgrade(attempt);
      } catch (error) {
        throw new Error(`${name} transport failed: ${error.message}`, { cause: error });
      }
      assert.equal(result.statusCode, expectedStatus, name);
      assert.equal(result.closeCode, null, name);
      assert.equal(result.body, "", name);
      assert.equal(result.headers["content-length"], "0", `${name} must expose no oracle body`);
    }

    const accepted = await rawUpgrade({ port, path: validPath, origin: ORIGIN });
    assert.equal(accepted.statusCode, 101);
    assert.equal(accepted.closeCode, 1013);
  });
});

test("the socket seam receives only frozen claims and nullable trace, never the raw credential", async () => {
  let context;
  const credential = ticket();
  await withListeningApp(appOptions({
    handleAdmittedSocket(socket, admitted) {
      context = admitted;
      socket.close(1013, "temporarily unavailable");
    },
  }), async (_app, port) => {
    const path = `/v1/recitation-sessions/${SESSION}/audio?ticket=${encodeURIComponent(credential)}&trace_id=%20trace-123%20`;
    assert.equal((await rawUpgrade({ port, path, origin: ORIGIN })).statusCode, 101);
  });
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.claims));
  assert.deepEqual(Object.keys(context).sort(), ["accepted", "claims", "traceId"]);
  assert.equal(context.traceId, "trace-123");
  assert.equal("ticket" in context, false);
  assert.equal("ticket" in context.claims, false);
  const serialized = JSON.stringify(
    context,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  assert.equal(serialized.includes(credential), false);
  assert.doesNotMatch(serialized, /rt_v2/);
});

test("direct peers cannot rotate forwarded headers around admission; bounded trust is explicit", async () => {
  const path = `/v1/recitation-sessions/${SESSION}/audio?ticket=${encodeURIComponent(ticket())}`;
  await withListeningApp(appOptions({
    rateLimitOptions: { capacity: 1, refillIntervalMs: 10_000 },
  }), async (app, port) => {
    assert.equal((await rawUpgrade({ port, path, origin: ORIGIN, forwardedFor: "203.0.113.1" })).statusCode, 101);
    const limited = await rawUpgrade({ port, path, origin: ORIGIN, forwardedFor: "203.0.113.2" });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["retry-after"], "10");
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    assert.match(metrics.body, /realtime_admission_total\{outcome="accepted"\} 1/);
    assert.match(metrics.body, /realtime_admission_total\{outcome="rate_rejected"\} 1/);
    assert.doesNotMatch(metrics.body, /203\.0\.113|tenant-w3-3|session-w3-3|learner-w3-3|rt_v2/);
  });

  await withListeningApp(appOptions({
    trustedProxyHops: 1,
    rateLimitOptions: { capacity: 1, refillIntervalMs: 10_000 },
  }), async (_app, port) => {
    assert.equal((await rawUpgrade({ port, path, origin: ORIGIN, forwardedFor: "203.0.113.1" })).statusCode, 101);
    assert.equal((await rawUpgrade({ port, path, origin: ORIGIN, forwardedFor: "203.0.113.2" })).statusCode, 101);
  });
});

test("the supported adapter is an exact production dependency and no second package/image appears", () => {
  const serverPackage = JSON.parse(readFileSync(join(repo, "server/package.json"), "utf8"));
  assert.equal(serverPackage.dependencies["@fastify/websocket"], "11.3.0");
  assert.equal(serverPackage.devDependencies?.["@fastify/websocket"], undefined);
  assert.equal(serverPackage.dependencies.ws, undefined, "ws must remain the adapter's pinned transitive");
  assert.match(serverPackage.scripts.lint, /src\/realtime\/\*\.mjs/);
  const realtimeSource = readFileSync(join(repo, "server/src/realtime/main.mjs"), "utf8");
  assert.match(realtimeSource, /new LogController\(\{ disableRequestLogging:\s*true \}\)/);
  assert.match(realtimeSource, /setNotFoundHandler\([^]*reply\.code\(404\)\.send\(\)/);
  const lock = readFileSync(join(repo, "pnpm-lock.yaml"), "utf8");
  assert.match(lock, /'@fastify\/websocket':\n\s+specifier: 11\.3\.0\n\s+version: 11\.3\.0/);
});
