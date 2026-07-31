import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";

import { buildServer } from "../../services/node-api/server.mjs";

/**
 * N2/N3 — the strangler shell: proxy transparency (§3), CORS (§2.4), middleware order (§2.5).
 * specs/node-backend-port/plan.md
 *
 * Hermetic: a stub upstream, no Rust binary, no database. The composite behaviour against the real
 * service is covered by running the whole Phase 6 parity suite with PARITY_THROUGH_SHELL=1.
 */

let upstream;
let upstreamUrl;
const received = [];
let respondWith = () => ({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' });

before(async () => {
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const { status, headers, body } = respondWith(req, raw);
      res.writeHead(status, headers);
      res.end(body);
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
});

after(() => new Promise((r) => upstream.close(r)));

const start = async (config = {}) => {
  const app = buildServer({ upstream: upstreamUrl, logger: false, ...config });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address();
  return { app, url: `http://127.0.0.1:${port}`, close: () => app.close() };
};

// --- §3 proxy transparency: the shell must be indistinguishable from the origin ---

test("an unported route is forwarded with method, path, query and body intact", async () => {
  const s = await start();
  received.length = 0;
  await fetch(`${s.url}/v1/anything?a=1&b=two`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-role": "admin" },
    body: JSON.stringify({ hello: "world" }),
  });
  await s.close();

  const [seen] = received;
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/anything?a=1&b=two", "query string must survive");
  assert.equal(seen.headers["x-user-role"], "admin", "identity headers must survive");
  assert.deepEqual(JSON.parse(seen.body), { hello: "world" });
});

test("MULTIPLE Set-Cookie headers survive as separate headers", async () => {
  // Iterating `Headers` collapses them into one comma-joined value, which corrupts any cookie whose
  // Expires attribute contains a comma — and __Host-qrai-pilot is exactly the cookie that breaks.
  respondWith = () => ({
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": [
        "__Host-qrai-pilot=abc; Path=/; Secure; HttpOnly; SameSite=Strict",
        "other=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
      ],
    },
    body: "{}",
  });
  const s = await start();
  const res = await fetch(`${s.url}/v1/cookies`);
  await s.close();
  respondWith = () => ({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' });

  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 2, "both cookies must arrive as separate headers");
  assert.ok(cookies[0].includes("Secure") && cookies[0].includes("HttpOnly"), "attributes preserved");
  assert.ok(cookies[1].includes("Expires=Wed, 21 Oct 2026"), "a comma inside Expires must not split the cookie");
});

test("a response with NO content-type does not gain one", async () => {
  // Fastify stamps a content-type on anything it serializes. The Phase 5 differ caught this as
  // `keys differ ... got [.., content-type]` on the /metrics 404 — a header the origin never sent.
  respondWith = () => ({ status: 404, headers: {}, body: "" });
  const s = await start();
  const res = await fetch(`${s.url}/metrics`);
  await s.close();
  respondWith = () => ({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' });

  assert.equal(res.status, 404);
  assert.equal(res.headers.get("content-type"), null, "the proxy must not invent a content-type");
});

test("a non-JSON upstream body is returned byte-for-byte", async () => {
  // /metrics is Prometheus text. A proxy that re-serialized it as JSON would corrupt every scrape.
  const prom = 'http_requests_total{method="GET",path="/health",status="200"} 3\n';
  respondWith = () => ({ status: 200, headers: { "content-type": "text/plain; version=0.0.4" }, body: prom });
  const s = await start();
  const res = await fetch(`${s.url}/metrics`);
  const text = await res.text();
  await s.close();
  respondWith = () => ({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' });

  assert.equal(text, prom);
  assert.match(res.headers.get("content-type"), /^text\/plain/);
});

test("an upstream error STATUS is preserved, not translated", async () => {
  for (const status of [400, 401, 403, 404, 500, 502, 503]) {
    respondWith = () => ({ status, headers: { "content-type": "application/json" }, body: '{"error":"x"}' });
    const s = await start();
    const res = await fetch(`${s.url}/v1/whatever`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    await s.close();
    assert.equal(res.status, status);
  }
  respondWith = () => ({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' });
});

test("a GET carrying content-type: application/json but NO body is forwarded, not 400'd", async () => {
  // Every Phase 6 request sends that header. Fastify's default JSON parser rejects an empty body as
  // malformed — a 400 the Rust service never returns, and it would have failed 29 tests at once.
  const s = await start();
  const res = await fetch(`${s.url}/v1/quran/surahs`, { headers: { "content-type": "application/json" } });
  await s.close();
  assert.equal(res.status, 200);
});

// --- §2.4 CORS: the port is wrong in the CSRF-enabling direction ---

test("with no allowlist the shell emits the LITERAL '*', never a reflected Origin", async () => {
  // tower-http emits `*`, which browsers refuse to combine with credentials — that refusal is what
  // stops a cross-origin page sending the __Host-qrai-pilot cookie today. `origin: true` reflects
  // the request Origin, which IS valid with credentials, and is strictly weaker.
  const s = await start({ corsAllowedOrigins: null });
  const res = await fetch(`${s.url}/v1/x`, { headers: { origin: "https://evil.example" } });
  await s.close();
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.notEqual(res.headers.get("access-control-allow-origin"), "https://evil.example");
});

test("with an allowlist, a disallowed Origin gets NO header and the allowed one is echoed", async () => {
  const s = await start({ corsAllowedOrigins: "https://allowed.example.com" });
  const bad = await fetch(`${s.url}/v1/x`, { headers: { origin: "https://disallowed.example.com" } });
  const good = await fetch(`${s.url}/v1/x`, { headers: { origin: "https://allowed.example.com" } });
  await s.close();
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  assert.equal(good.headers.get("access-control-allow-origin"), "https://allowed.example.com");
});

test("access-control-allow-credentials is absent from EVERY response", async () => {
  // The hard ban. Reflected Origin + credentials is full CSRF against every pilot learner, and
  // `credentials: true` is what a developer reaches for the first time cookie auth "doesn't work".
  for (const corsAllowedOrigins of [null, "https://allowed.example.com"]) {
    const s = await start({ corsAllowedOrigins });
    for (const path of ["/health", "/v1/x", "/metrics"]) {
      const res = await fetch(`${s.url}${path}`, { headers: { origin: "https://allowed.example.com" } });
      assert.equal(
        res.headers.get("access-control-allow-credentials"),
        null,
        `${path} must not allow credentials`,
      );
    }
    await s.close();
  }
});

test("configuring CORS credentials is refused at BOOT, not at review time", async () => {
  assert.throws(() => buildServer({ upstream: upstreamUrl, corsCredentials: true }), /hard-banned/);
});

// --- §2.5 middleware order is a security invariant ---

test("CORS is outermost: a 4xx/5xx from upstream still carries CORS headers", async () => {
  // If CORS were inside the error path, a 429 or 503 would arrive without CORS headers and the
  // browser would report a network error instead of the real status.
  respondWith = () => ({ status: 503, headers: { "content-type": "application/json" }, body: '{"error":"maintenance"}' });
  const s = await start({ corsAllowedOrigins: "https://allowed.example.com" });
  const res = await fetch(`${s.url}/v1/x`, { headers: { origin: "https://allowed.example.com" } });
  await s.close();
  respondWith = () => ({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' });

  assert.equal(res.status, 503);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://allowed.example.com");
});

test("a preflight is answered by the shell and never reaches upstream", async () => {
  // Preflight must not be rate-limited or proxied — it is the outermost layer's job.
  const s = await start({ corsAllowedOrigins: "https://allowed.example.com" });
  received.length = 0;
  const res = await fetch(`${s.url}/v1/x`, {
    method: "OPTIONS",
    headers: {
      origin: "https://allowed.example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  await s.close();
  assert.ok(res.status === 204 || res.status === 200, `preflight status was ${res.status}`);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://allowed.example.com");
  assert.equal(received.length, 0, "a preflight must not be forwarded upstream");
});

// --- the strangler contract itself ---

test("nothing is served locally unless it is explicitly ported", async () => {
  const s = await start();
  assert.deepEqual(s.app.portedRoutes, [], "the default must be a pure proxy");
  received.length = 0;
  await fetch(`${s.url}/v1/learner/progress?learnerId=learner-1`, {
    headers: { "x-tenant-id": "t1", "x-user-id": "learner-1", "x-user-role": "learner" },
  });
  await s.close();
  assert.equal(received.length, 1, "an unported route must reach upstream");
});

test("buildServer refuses to start with no upstream", () => {
  assert.throws(() => buildServer({}), /upstream is required/);
});
