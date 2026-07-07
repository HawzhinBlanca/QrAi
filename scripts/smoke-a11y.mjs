// Automated accessibility audit (docs/SHIP_READINESS.md F17) using axe-core against the real
// running app in headless Chrome — the same DevTools-protocol pattern scripts/smoke-browser.mjs
// already uses for mic-permission smoke, reused here rather than hand-rolled contrast/focus
// checks (which proved unreliable: gradients, :focus-visible, and scroll position all produced
// false positives in manual testing).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createRequire } from "node:module";

// axe-core is a devDependency of @quran-ai/web (this repo's only pnpm-workspace-installed
// consumer), not hoisted to the repo root, so a plain require.resolve("axe-core/...") from this
// root-level script fails — resolve from that package's own node_modules instead.
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const artifactRoot = process.env.SMOKE_ARTIFACT_DIR ?? join("out", "smoke", new Date().toISOString().replace(/[:.]/g, "-"));
const artifactDir = join(artifactRoot, "a11y");
await mkdir(artifactDir, { recursive: true });

const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const webPort = Number(process.env.WEB_SMOKE_PORT ?? (await getFreePort()));
const web = process.env.WEB_SMOKE_URL ? null : await startWebServer(webPort);
const appUrl = process.env.WEB_SMOKE_URL ?? `http://127.0.0.1:${webPort}/`;

// Only screens with no learner-facing AI content are audited from a static ?smoke=layout render
// (matches smoke-browser.mjs's own cases) — this checks structural a11y (labels, roles, contrast,
// landmarks), not runtime behavior.
const cases = [
  { name: "learner-home", path: "?smoke=layout" },
  { name: "practice-listen", path: "?smoke=layout&smokeMode=practice" },
  { name: "internal-command", path: "?smoke=layout&smokeMode=admin" },
];

// axe rules that fire only because this is a static, backend-less smoke render (no live region
// announcing content, or a landmark that's legitimately empty without seeded data) — not real
// defects. Keep this list short and documented; anything else found is a real finding to fix.
const knownFalsePositiveRuleIds = [];

let hadFailures = false;
try {
  for (const testCase of cases) {
    const url = `${appUrl}${testCase.path}`;
    const result = await runAxeAgainst(testCase.name, url);
    const violations = result.violations.filter((v) => !knownFalsePositiveRuleIds.includes(v.id));
    await writeFile(join(artifactDir, `${testCase.name}.json`), JSON.stringify(result, null, 2));

    if (violations.length > 0) {
      hadFailures = true;
      console.error(`\n=== ${testCase.name}: ${violations.length} axe violation(s) ===`);
      for (const v of violations) {
        console.error(`[${v.impact}] ${v.id}: ${v.help} (${v.helpUrl})`);
        for (const node of v.nodes) {
          console.error(`  - ${node.target.join(" ")}`);
          console.error(`    ${node.failureSummary?.replace(/\n/g, "\n    ")}`);
        }
      }
    } else {
      console.log(`${testCase.name}: 0 violations (${result.passes.length} rules passed)`);
    }
  }
} finally {
  web?.stop();
}

if (hadFailures) {
  console.error("\naccessibility smoke FAILED — see violations above");
  process.exit(1);
}
console.log("\naccessibility smoke passed");

async function runAxeAgainst(name, url) {
  const remotePort = await getFreePort();
  const userDataDir = await mkdtemp(join(tmpdir(), "quran-ai-a11y-smoke-"));
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,1000",
      `--remote-debugging-port=${remotePort}`,
      `--user-data-dir=${userDataDir}`,
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    const page = await waitForDevToolsPage(remotePort, url);
    const client = await connectDevTools(page.webSocketDebuggerUrl);
    try {
      await client.send("Page.enable");
      await client.send("Runtime.enable");
      // Give the SPA a moment to render past its mount animation before auditing.
      await sleep(700);
      await client.send("Runtime.evaluate", { expression: axeSource });
      const result = await client.send("Runtime.evaluate", {
        expression: "axe.run(document, { resultTypes: ['violations', 'passes'] })",
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`axe.run failed for ${name}: ${JSON.stringify(result.exceptionDetails)}`);
      }
      return result.result.value;
    } finally {
      client.close();
    }
  } catch (error) {
    await writeFile(join(artifactDir, `${name}.chrome.log`), logs.join(""));
    throw error;
  } finally {
    child.kill("SIGTERM");
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForDevToolsPage(port, expectedUrl) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((item) => item.type === "page" && item.url.startsWith(expectedUrl.split("?")[0]));
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Chrome DevTools page did not appear: ${lastError?.message ?? "timeout"}`);
}

function connectDevTools(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result ?? {});
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome DevTools WebSocket did not open")), 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(new Error(`DevTools WebSocket error: ${event.message ?? "unknown"}`));
    });
  });
}

async function startWebServer(port) {
  const logPath = join(artifactDir, "web.log");
  const child = spawn("pnpm", ["--filter", "@quran-ai/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  await waitForHttp(`http://127.0.0.1:${port}/`);
  return {
    stop() {
      child.kill("SIGTERM");
      void writeFile(logPath, logs.join(""));
    },
  };
}

async function waitForHttp(url) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`Web server did not become ready at ${url}: ${lastError?.message ?? "timeout"}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
