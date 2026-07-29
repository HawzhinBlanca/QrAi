import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { tmpdir } from "node:os";

const artifactRoot = process.env.SMOKE_ARTIFACT_DIR ?? join("out", "smoke", new Date().toISOString().replace(/[:.]/g, "-"));
const artifactDir = join(artifactRoot, "e2e");
await mkdir(artifactDir, { recursive: true });

const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const webPort = Number(process.env.WEB_SMOKE_PORT ?? (await getFreePort()));
const web = process.env.WEB_SMOKE_URL ? null : await startWebServer(webPort);
const appUrl = process.env.WEB_SMOKE_URL ?? `http://127.0.0.1:${webPort}/`;

console.log(`Starting E2E Composed Smoke Test...`);
console.log(`App URL: ${appUrl}`);

try {
  const remotePort = await getFreePort();
  const userDataDir = await mkdtemp(join(tmpdir(), "quran-ai-e2e-"));
  
  // Launch headless chrome with remote debugging and fake audio capture flags
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=1280,900`,
      `--remote-debugging-port=${remotePort}`,
      `--user-data-dir=${userDataDir}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      appUrl,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    const page = await waitForDevToolsPage(remotePort, appUrl);
    const client = await connectDevTools(page.webSocketDebuggerUrl);
    
    await client.send("Page.enable");
    await client.send("Runtime.enable");

    // 1. Learner Journey: Start Recitation Practice
    console.log("Step 1: Opening Learner Practice Flow...");
    await client.send("Page.navigate", { url: `${appUrl}?smoke=mic&smokeAutoMic=1` });
    
    // Wait for App to render and learner home to load
    await sleep(2000);

    // Accept consent checkbox by evaluating click
    console.log("Step 1.1: Clicking Consent Checkbox...");
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('input[type="checkbox"]')?.click()`
    });
    await sleep(250);

    // Click "Start Practice"
    console.log("Step 1.2: Clicking Start Practice...");
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('.start-practice-button')?.click()`
    });
    await sleep(1000);

    // Advance from listen to recite mode
    console.log("Step 1.2.1: Advancing from Listen to Recite...");
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('.primary-action')?.click()`
    });
    await sleep(1000);

    // Start recording by clicking the record action
    console.log("Step 1.3: Starting Recording...");
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('.record-btn')?.click()`
    });
    
    // Wait 3 seconds for fake recording stream to capture
    await sleep(3000);

    // Stop recording
    console.log("Step 1.4: Stopping Recording...");
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('.record-btn')?.click()`
    });
    await sleep(1000);

    // Advance from guided-recite to memory-recite mode
    console.log("Step 1.4.1a: Advancing from Guided Recite to Memory Recite...");
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('.primary-action')?.click()`
    });
    await sleep(1000);

    // Advance from memory-recite to correction mode
    console.log("Step 1.4.1b: Advancing from Memory Recite to Correction...");
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('.primary-action')?.click()`
    });
    await sleep(1000);

    // Submit recitation for teacher review in correction mode
    console.log("Step 1.4.2: Requesting Teacher Review...");
    const requestResult = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const banner = document.querySelector('.state-banner');
        const btn = banner ? banner.querySelector('button') : null;
        if (btn) {
          btn.click();
          return "clicked";
        }
        return banner ? "banner-found-no-button: " + banner.outerHTML : "banner-not-found";
      })()`
    });
    console.log("Request result:", requestResult.result?.value);
    await sleep(2000);

    // Advance from correct to complete mode
    console.log("Step 1.4.3: Advancing from Correct to Complete...");
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('.primary-action')?.click()`
    });
    await sleep(1000);

    // Wait for analysis/ASR to run and ASR results to settle (transition to complete stage)
    console.log("Step 1.5: Waiting for Alignment & Session ID...");
    let sessionId = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const probeResult = await client.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const probe = document.querySelector('#browser-smoke-report');
          return probe ? {
            mode: probe.getAttribute('data-mode'),
            sessionId: probe.getAttribute('data-session-id')
          } : null;
        })()`
      });
      const probe = probeResult.result?.value;
      if (probe && (probe.mode === "complete" || probe.sessionId)) {
        sessionId = probe.sessionId;
        console.log(`Analysis complete. Session ID captured: ${sessionId}`);
        break;
      }
      await sleep(500);
    }

    if (!sessionId) {
      throw new Error("E2E Failed: Learner session ASR / alignment timeout.");
    }

    // Capture screenshot of complete state
    const learnerScreenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(join(artifactDir, "1-learner-complete.png"), Buffer.from(learnerScreenshot.data, "base64"));

    // 2. Teacher Journey: Open Teacher View & Submit Review
    console.log("Step 2: Navigating to Teacher View...");
    await client.send("Page.navigate", { url: `${appUrl}?smoke=layout&smokeMode=teacher` });
    await sleep(2000);

    console.log(`Step 2.1: Selecting session ${sessionId} in queue...`);
    const selectSessionResult = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        console.log("Localstorage session-id:", localStorage.getItem("smoke-session-id"));
        console.log("Available buttons data-session-ids:", Array.from(document.querySelectorAll('button')).map(b => b.getAttribute('data-session-id')));
        const sessionBtn = document.querySelector('button[data-session-id="${sessionId}"]');
        if (sessionBtn) {
          sessionBtn.click();
          return true;
        }
        return false;
      })()`
    });
    
    if (!selectSessionResult.result?.value) {
      throw new Error(`E2E Failed: Session ${sessionId} not found in Teacher Queue.`);
    }
    await sleep(1000);

    // Capture screenshot of teacher detail page
    const teacherQueueScreenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(join(artifactDir, "2-teacher-queue.png"), Buffer.from(teacherQueueScreenshot.data, "base64"));

    // Click "Accept Finding" to submit teacher review
    console.log("Step 2.2: Submitting review (Accept)...");
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        const textareas = document.querySelectorAll('textarea');
        if (textareas.length > 0) {
          textareas[0].value = "Pronunciation approved.";
          textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
        }
        const buttons = Array.from(document.querySelectorAll('button'));
        const acceptBtn = buttons.find(b => b.innerText.includes('Accept') || b.textContent.includes('Accept'));
        acceptBtn?.click();
      })()`
    });
    await sleep(2000);

    console.log("E2E Verification Complete: Full loop successfully walked!");
    client.close();
    process.exit(0);
  } catch (error) {
    await writeFile(join(artifactDir, `e2e.chrome.log`), logs.join(""));
    throw error;
  } finally {
    child.kill("SIGTERM");
    await waitForProcessExit(child, 1500);
    await rmWithRetry(userDataDir);
  }
} finally {
  web?.stop();
}

// Helpers
async function getFreePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startWebServer(port) {
  const child = spawn("pnpm", ["dev", "--port", String(port)], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, VITE_REQUIRE_LOGIN: "0" }
  });
  return {
    stop() {
      child.kill("SIGTERM");
    }
  };
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
    await sleep(150);
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
      if (message.method === "Runtime.consoleAPICalled") {
        const args = message.params.args.map(a => a.value ?? a.description).join(" ");
        console.log(`[Browser Console] ${message.params.type}: ${args}`);
      } else if (message.method === "Runtime.exceptionThrown") {
        console.error(`[Browser Exception]`, message.params.exceptionDetails);
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function rmWithRetry(dir) {
  for (let i = 0; i < 3; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(150);
    }
  }
}
