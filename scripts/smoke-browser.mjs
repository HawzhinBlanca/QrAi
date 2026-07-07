import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { tmpdir } from "node:os";

const artifactRoot = process.env.SMOKE_ARTIFACT_DIR ?? join("out", "smoke", new Date().toISOString().replace(/[:.]/g, "-"));
const artifactDir = join(artifactRoot, "browser");
const smokeTraceId = process.env.SMOKE_TRACE_ID ?? `smoke-trace-${randomUUID()}`;
await mkdir(artifactDir, { recursive: true });

const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const webPort = Number(process.env.WEB_SMOKE_PORT ?? (await getFreePort()));
const web = process.env.WEB_SMOKE_URL ? null : await startWebServer(webPort);
const appUrl = process.env.WEB_SMOKE_URL ?? `http://127.0.0.1:${webPort}/`;

try {
  const cases = [
    { name: "mobile-home", width: 390, height: 844, path: "?smoke=layout" },
    { name: "mobile-practice", width: 390, height: 844, path: "?smoke=layout&smokeMode=practice" },
    // 1280px falls in the gap between the mobile breakpoints and the 1440px desktop case above —
    // practice-main-grid drops to a single column at <=1320px (a common laptop width), which
    // previously overflowed because .reader-panel/.audio-coach lacked min-width:0 as direct
    // grid children. Neither existing case caught it since 1440 stays two-column and 390 already
    // had the mobile min-width:0 fix.
    { name: "laptop-practice", width: 1280, height: 900, path: "?smoke=layout&smokeMode=practice" },
    // 1321px is the exact width that overflowed on Internal Command: .command-grid's base
    // (non-media) column minimums (440+300+280px + 2*18px gaps = 1056px) plus sidebar/padding
    // overhead only fit starting at ~1330px, but the layout's 1320px breakpoint switched to the
    // safe 2-column fallback one pixel too early to cover it. No prior case exercised Internal
    // Command's own layout at any width — this closes that gap too.
    { name: "laptop-admin", width: 1321, height: 900, path: "?smoke=layout&smokeMode=admin", expectAdmin: true },
    { name: "desktop-home", width: 1440, height: 1100, path: "?smoke=layout" },
    { name: "desktop-practice", width: 1440, height: 1100, path: "?smoke=layout&smokeMode=practice" },
    {
      name: "desktop-mic-allowed",
      width: 1024,
      height: 900,
      path: "?smoke=mic&smokeAutoMic=1",
      chromeFlags: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
      expectedMicState: "ready",
    },
    {
      name: "desktop-mic-denied",
      width: 1024,
      height: 900,
      path: "?smoke=mic&smokeAutoMic=1",
      chromeFlags: ["--deny-permission-prompts"],
      expectedMicState: "denied",
    },
    {
      name: "desktop-mic-unavailable",
      width: 1024,
      height: 900,
      path: "?smoke=mic&smokeAutoMic=1&smokeMic=unavailable",
      expectedMicState: "unavailable",
    },
  ];
  const results = [];

  for (const testCase of cases) {
    const url = `${appUrl}${testCase.path}`;
    const screenshotPath = join(artifactDir, `${testCase.name}.png`);
    const dom = testCase.expectedMicState || testCase.expectAdmin
      ? await runChromeWithDevTools(testCase, url, screenshotPath)
      : runChrome(testCase, url, screenshotPath).stdout;
    const report = parseSmokeReport(dom, testCase.name);

    assert(report.scrollWidth <= report.clientWidth + 1, `${testCase.name}: horizontal overflow ${report.scrollWidth} > ${report.clientWidth}`);
    if (testCase.expectAdmin) {
      assert(report.hasCommandHero === true, `${testCase.name}: Internal Command console did not render`);
    } else {
      assert(report.hasCommandHero === false, `${testCase.name}: platform command leaked into learner screen`);
      if (testCase.name.endsWith("home") || testCase.expectedMicState) {
        assert(report.mode === "home", `${testCase.name}: expected home mode`);
        assert(report.hasLearnerHome, `${testCase.name}: learner home missing`);
        assert(report.hasStartPractice, `${testCase.name}: start practice missing`);
      } else {
        assert(report.mode === "listen", `${testCase.name}: expected practice listen mode`);
        assert(report.hasPractice, `${testCase.name}: practice screen missing`);
        assert(report.hasHiddenInternalsCopy, `${testCase.name}: hidden internals learner copy missing`);
      }
    }
    if (testCase.expectedMicState) {
      assert(report.micState === testCase.expectedMicState, `${testCase.name}: expected mic ${testCase.expectedMicState}, got ${report.micState}`);
      if (testCase.expectedMicState === "ready") {
        assert(report.hasMicReady, `${testCase.name}: ready mic notice missing`);
      }
      if (testCase.expectedMicState === "denied") {
        assert(report.hasMicDenied, `${testCase.name}: denied mic notice missing`);
      }
      if (testCase.expectedMicState === "unavailable") {
        assert(report.hasMicUnavailable, `${testCase.name}: unavailable mic notice missing`);
      }
    }

    results.push({ ...testCase, screenshotPath, report });
  }

  const summary = { appUrl, traceId: smokeTraceId, results };
  await writeFile(join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  web?.stop();
}

function runChrome(testCase, url, screenshotPath) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${testCase.width},${testCase.height}`,
    // PlatformCommand is React.lazy-loaded (Suspense); admin-section cases need a beat longer
    // than the default budget for that chunk's dynamic import to resolve before dump-dom fires.
    `--virtual-time-budget=${testCase.expectAdmin ? 6000 : 3000}`,
    `--screenshot=${screenshotPath}`,
    "--dump-dom",
    ...(testCase.chromeFlags ?? []),
    url,
  ];
  let result = spawnSync(chromePath, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.signal === "SIGKILL") {
    result = spawnSync(chromePath, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  if (result.status !== 0) {
    throw new Error(
      `Chrome failed for ${testCase.name}: status=${result.status} signal=${result.signal} error=${result.error?.message ?? "none"} stderr=${result.stderr} stdout=${result.stdout}`,
    );
  }

  return result;
}

async function runChromeWithDevTools(testCase, url, screenshotPath) {
  const remotePort = await getFreePort();
  const userDataDir = await mkdtemp(join(tmpdir(), "quran-ai-browser-smoke-"));
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${testCase.width},${testCase.height}`,
      `--remote-debugging-port=${remotePort}`,
      `--user-data-dir=${userDataDir}`,
      ...(testCase.chromeFlags ?? []),
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
      const report = testCase.expectAdmin
        ? await waitForSmokeReport(client, (r) => r.hasCommandHero === "true", "Internal Command console to render")
        : await waitForSmokeReport(client, (r) => r.micState === testCase.expectedMicState, `mic state ${testCase.expectedMicState}`);
      const screenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
      return report.outerHTML;
    } finally {
      client.close();
    }
  } catch (error) {
    await writeFile(join(artifactDir, `${testCase.name}.chrome.log`), logs.join(""));
    throw error;
  } finally {
    child.kill("SIGTERM");
    await waitForProcessExit(child, 1500);
    await rmWithRetry(userDataDir);
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
        if (page?.webSocketDebuggerUrl) {
          return page;
        }
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
    if (!message.id) {
      return;
    }
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message));
    } else {
      request.resolve(message.result ?? {});
    }
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome DevTools WebSocket did not open")), 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((requestResolve, requestReject) => {
            pending.set(id, { resolve: requestResolve, reject: requestReject });
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Chrome DevTools WebSocket error"));
    });
  });
}

// Polls the #browser-smoke-report probe until `isReady` passes — used both for mic-permission
// smoke (waiting on data-mic-state) and for the admin/Internal Command case (waiting on
// data-has-command-hero), whose React.lazy-loaded PlatformCommand chunk needs a real polling
// wait rather than the fixed --virtual-time-budget the non-DevTools runChrome() path uses (that
// budget accelerates JS timers but not the real dev-server round-trip for an as-yet-uncompiled
// lazy chunk on a cold Vite server, so a fixed budget can expire before it resolves).
async function waitForSmokeReport(client, isReady, describeExpectation) {
  const deadline = Date.now() + 12_000;
  let lastReport;
  while (Date.now() < deadline) {
    const result = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const probe = document.querySelector('#browser-smoke-report');
        if (!probe) return null;
        return {
          micState: probe.getAttribute('data-mic-state'),
          hasCommandHero: probe.getAttribute('data-has-command-hero'),
          outerHTML: probe.outerHTML,
          bodyText: document.body.innerText
        };
      })()`,
    });
    lastReport = result.result?.value ?? null;
    if (lastReport && isReady(lastReport)) {
      return lastReport;
    }
    await sleep(150);
  }

  throw new Error(`browser smoke expected ${describeExpectation}, last report ${JSON.stringify(lastReport)}`);
}

function parseSmokeReport(dom, name) {
  const match = dom.match(/<output[^>]*id="browser-smoke-report"[^>]*>/);
  if (!match) {
    throw new Error(`${name}: browser smoke report missing`);
  }

  const tag = match[0];
  return {
    clientWidth: Number(attr(tag, "data-client-width")),
    hasCommandHero: attr(tag, "data-has-command-hero") === "true",
    hasHiddenInternalsCopy: attr(tag, "data-has-hidden-internals-copy") === "true",
    hasLearnerHome: attr(tag, "data-has-learner-home") === "true",
    hasMicDenied: attr(tag, "data-has-mic-denied") === "true",
    hasMicReady: attr(tag, "data-has-mic-ready") === "true",
    hasMicUnavailable: attr(tag, "data-has-mic-unavailable") === "true",
    hasPractice: attr(tag, "data-has-practice") === "true",
    hasStartPractice: attr(tag, "data-has-start-practice") === "true",
    micState: attr(tag, "data-mic-state"),
    mode: attr(tag, "data-mode"),
    scrollWidth: Number(attr(tag, "data-scroll-width")),
  };
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  if (!match) {
    throw new Error(`missing ${name} in browser smoke report`);
  }
  return match[1];
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
  throw new Error(`${url} did not become healthy: ${lastError?.message ?? "timeout"}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    server.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs),
  ]);
}

async function rmWithRetry(path) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await sleep(150 * (attempt + 1));
    }
  }
  throw lastError;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
