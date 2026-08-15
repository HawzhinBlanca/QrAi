import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { createApplication } from "../../server/src/app.mjs";

/**
 * N-7 — THE node-api SHALL NOT log audio bytes, bearer tokens, cookie values, password hashes, or
 * learner PII at any level.  `specs/migration-completion/impact-map.md`
 *
 * ── Why this exists when the logger is OFF ──────────────────────────────────────────────────────
 * `server.mjs`'s entry point never passes `logger`, so it defaults to `false` and Fastify emits
 * nothing. That makes N-7 vacuously true today and silently false the day anyone turns logging on.
 * A test that asserted the criterion in the shipped configuration would be green because the
 * subject is switched off — the "green that cannot go red" this spec's every wave is built against.
 *
 * So the HOSTILE configuration is what gets tested: the Fastify logger forced on at `trace`, driven
 * with real credentials in a real request. The code-authored `console.*` lines are captured
 * separately because they are emitted whether or not that logger is on — and that is where the one
 * real leak was: `forward()` interpolated a caught `SyntaxError` whose message quotes the first ten
 * characters of the input it failed to parse. On the ASR path that input is a transcript.
 *
 * Hermetic: stub upstreams, no Rust binary, no database — the same shape as `shell.test.mjs`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const nodeApi = join(here, "..", "..", "server", "src");

// Distinctive enough that a substring match cannot be a coincidence, and shaped like the real thing.
const BEARER = "eyJhbGciOiJIUzI1NiJ9.CANARYtokenPAYLOAD8f21.CANARYsigNATURE";
const COOKIE = "CANARYpilotCookieValue-4d7a";
const PASSWORD = "CANARYpassword-correct-horse";
const HASH = "$2b$12$CANARYbcryptHASHvalue0000000000000000000000000000000";
const DEVICE_ACCESS = `qrai_at_v1.${"A".repeat(43)}`;
const DEVICE_REFRESH = `qrai_rt_v1.${"R".repeat(43)}`;
const DEVICE_INVITATION = `qrai_inv_v1.${"I".repeat(43)}`;

/**
 * The upstream body that fails to parse. The canary sits at the START on purpose: Node quotes the
 * first ~10 characters of the offending input in the SyntaxError message, so a canary placed later
 * would make this test pass for the wrong reason. Measured on node v22 —
 *   JSON.parse('not json: leak') → `Unexpected token 'o', "not json: l"... is not valid JSON`
 */
const ASR_BODY = "bismillah-transcript-canary-8f21 was never valid json";
const ECHOED = ASR_BODY.slice(0, 10);

let asr;
let asrUrl;
let upstream;
let upstreamUrl;

before(async () => {
  // Answers 200 with a body that is NOT json, which is what drives `forward()` into its parse-error
  // branch. A 502 to the caller either way; the question is what reaches the log on the way.
  asr = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(ASR_BODY);
  });
  await new Promise((r) => asr.listen(0, "127.0.0.1", r));
  asrUrl = `http://127.0.0.1:${asr.address().port}`;

  upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
});

after(async () => {
  await new Promise((r) => asr.close(r));
  await new Promise((r) => upstream.close(r));
});

/**
 * Run `body` with every log sink captured, and return everything written as one string.
 *
 * Both sinks matter and neither subsumes the other: `console.*` is what the handlers call directly,
 * and the pino stream is what a future operator switching `logger` on would collect.
 */
async function withCapturedLogs(config, body) {
  const lines = [];
  const original = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    original[level] = console[level];
    console[level] = (...args) => lines.push(args.map(String).join(" "));
  }
  const app = createApplication({
    upstream: upstreamUrl,
    logger: { level: "trace", stream: { write: (s) => lines.push(s) } },
    ...config,
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    await body(`http://127.0.0.1:${app.server.address().port}`);
  } finally {
    await app.close();
    for (const [level, fn] of Object.entries(original)) console[level] = fn;
  }
  return lines.join("\n");
}

test("an upstream body that fails to parse is never echoed into the log", async () => {
  const logs = await withCapturedLogs(
    {
      compatibilityRouteKeys: new Set(["POST /v1/asr/transcribe"]),
      allowHeaderAuth: true,
      asrInferenceUrl: asrUrl,
    },
    async (url) => {
      const res = await fetch(`${url}/v1/asr/transcribe`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-id": "tenant-1",
          "x-user-id": "learner-1",
          "x-user-role": "learner",
        },
        body: JSON.stringify({ audio: "…" }),
      });
      // The 502 is the point of the branch; without it this test would be asserting about a code
      // path that never ran.
      assert.equal(res.status, 502, "a non-json upstream body must still be a 502 to the caller");
    },
  );

  assert.ok(
    logs.includes("parse error") || logs.includes("ASR proxy transcribe"),
    `the parse-error branch must still say which stage failed — an operator needs that.\n${logs}`,
  );
  assert.ok(
    !logs.includes(ECHOED),
    `the upstream body reached the log. On the ASR path that is transcript content.\n` +
      `looked for ${JSON.stringify(ECHOED)} in:\n${logs}`,
  );
});

test("credentials in a request never reach any log sink, even at trace level", async () => {
  // Both halves of the surface: a PORTED route that authenticates, and a proxied one that forwards
  // the same headers verbatim. A leak in either is the same disclosure.
  for (const path of ["/v1/asr/transcribe", "/v1/anything-unported"]) {
    const logs = await withCapturedLogs(
      {
        compatibilityRouteKeys: new Set(["POST /v1/asr/transcribe"]),
        allowHeaderAuth: true,
        asrInferenceUrl: asrUrl,
      },
      async (url) => {
        await fetch(`${url}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${BEARER}`,
            cookie: `__Host-qrai-pilot=${COOKIE}`,
            "x-tenant-id": "tenant-1",
            "x-user-id": "learner-1",
            "x-user-role": "learner",
          },
          body: JSON.stringify({ password: PASSWORD, passwordHash: HASH }),
        });
      },
    );

    for (const [what, canary] of [
      ["a bearer token", BEARER],
      ["a pilot cookie value", COOKIE],
      ["a password", PASSWORD],
      ["a password hash", HASH],
    ]) {
      assert.ok(!logs.includes(canary), `${what} reached the log via ${path}:\n${logs}`);
    }
  }
});

test("device invitation, access, and refresh credentials never reach any log sink", async () => {
  const probes = [
    {
      path: "/v1/device-enrollments:exchange",
      options: { method: "POST", body: JSON.stringify({ invitationToken: DEVICE_INVITATION }) },
    },
    {
      path: "/v1/device-sessions:refresh",
      options: { method: "POST", body: JSON.stringify({ refreshToken: DEVICE_REFRESH }) },
    },
    {
      path: "/v1/learner/progress",
      options: { method: "GET", headers: { authorization: `Bearer ${DEVICE_ACCESS}` } },
    },
  ];
  for (const probe of probes) {
    const logs = await withCapturedLogs(
      { deviceIdentityEnabled: true, rateLimitEnabled: false },
      async (url) => {
        await fetch(`${url}${probe.path}`, {
          headers: { "content-type": "application/json", ...(probe.options.headers ?? {}) },
          ...probe.options,
        });
      },
    );
    for (const credential of [DEVICE_ACCESS, DEVICE_REFRESH, DEVICE_INVITATION]) {
      assert.ok(!logs.includes(credential), `device credential reached logs via ${probe.path}:\n${logs}`);
    }
  }
});

test("no log line names a learner, a user or a tenant", () => {
  // The identifiers a log line must not carry. `sessionId` is deliberately NOT here: it identifies a
  // recitation session rather than a person, and `session-writes.mjs` needs it to make an ML
  // data-quality problem greppable without reproducing against the database. Drawing the line at
  // "identifies a human" is the judgement; naming it here is so the next person can disagree with
  // it explicitly instead of by accident.
  const forbidden = /\$\{(?:actor\.)?(learnerId|userId|tenantId|learner_id|user_id|tenant_id)\}/;
  const sources = globSync("**/*.mjs", { cwd: nodeApi }).sort();
  assert.ok(sources.length > 5, "the glob found nothing; this test would pass vacuously");

  const offenders = [];
  for (const rel of sources) {
    const src = readFileSync(join(nodeApi, rel), "utf8");
    // From each `console.` to the end of that statement. Over-matching would fail loudly; the
    // failure mode this avoids is a multi-line template literal scanned one line at a time.
    for (const m of src.matchAll(/console\.\w+\([\s\S]{0,600}?\);/g)) {
      const hit = forbidden.exec(m[0]);
      if (hit) offenders.push(`${rel}: \${${hit[1]}}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these log lines name a person:\n  ${offenders.join("\n  ")}\n` +
      `N-7 forbids it. Log the trace id, or nothing — see routes/privacy.mjs for the trade.`,
  );
});

test("no sibling copy of the parse-error echo survives elsewhere in node-api", () => {
  // `privacy.mjs` carries its own copy of the same three-stage forward, and its parse branch is
  // only reachable with a database and a real learner — out of reach of a hermetic test. This pins
  // the exact phrase a copy-paste would carry. It is a regression pin for a known shape, NOT a
  // general proof: renaming the message defeats it, which is why the behavioural case above is the
  // load-bearing one.
  for (const file of ["routes/ml-proxy.mjs", "routes/privacy.mjs"]) {
    const src = readFileSync(join(nodeApi, file), "utf8");
    assert.ok(
      !/parse error: \$\{/.test(src),
      `${file} interpolates the caught parse error into its log line; that message quotes the ` +
        `bytes it failed to parse`,
    );
  }
});
