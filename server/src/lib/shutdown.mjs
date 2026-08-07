const DEFAULT_SHUTDOWN_GRACE_SECONDS = 8;
const MAX_SHUTDOWN_GRACE_MS = 300_000;

function assertGraceMs(graceMs) {
  if (!Number.isSafeInteger(graceMs) || graceMs <= 0 || graceMs > MAX_SHUTDOWN_GRACE_MS) {
    throw new TypeError("shutdown grace must be a positive whole number no greater than 300 seconds");
  }
}

/** Strict process configuration: never turn a typo into an unbounded deploy. */
export function parseShutdownGraceSeconds(raw = String(DEFAULT_SHUTDOWN_GRACE_SECONDS)) {
  if (!/^[0-9]+$/.test(raw)) {
    throw new TypeError("SHUTDOWN_GRACE_SECS must be a whole number of seconds");
  }
  const graceMs = Number(raw) * 1_000;
  if (!Number.isSafeInteger(graceMs) || graceMs <= 0 || graceMs > MAX_SHUTDOWN_GRACE_MS) {
    throw new TypeError("SHUTDOWN_GRACE_SECS must be between 1 and 300 seconds");
  }
  return graceMs;
}

/** Reserve the final fifth of one outer budget for Fastify onClose resource teardown. */
export function shutdownPhases(graceMs) {
  assertGraceMs(graceMs);
  const resourceCloseMs = Math.max(1, Math.floor(graceMs / 5));
  return Object.freeze({
    forceAfterMs: graceMs - resourceCloseMs,
    graceMs,
    resourceCloseMs,
  });
}

/**
 * Install one idempotent process shutdown boundary around Fastify's native close lifecycle.
 *
 * Fastify closes admission, drains active HTTP, then runs onClose. Node's
 * closeAllConnections deliberately excludes upgraded sockets, so the raw socket set is the final
 * fallback at the force phase. The hard timer stays referenced until cleanup finishes: a pending
 * Promise alone does not keep Node alive and must never let resource teardown disappear silently.
 */
export function installProcessShutdown(
  app,
  {
    graceMs,
    processRef = process,
    log = (message) => processRef.stderr.write(`${message}\n`),
    signals = ["SIGINT", "SIGTERM"],
  } = {},
) {
  assertGraceMs(graceMs);
  if (typeof app?.close !== "function" || typeof app?.server?.on !== "function") {
    throw new TypeError("installProcessShutdown requires a Fastify application");
  }
  if (
    typeof processRef?.on !== "function" ||
    typeof processRef?.removeListener !== "function" ||
    typeof processRef?.exit !== "function"
  ) {
    throw new TypeError("installProcessShutdown requires a process-like object");
  }
  if (typeof log !== "function") throw new TypeError("shutdown log must be a function");
  if (!Array.isArray(signals) || signals.length === 0) {
    throw new TypeError("shutdown signals must be a non-empty array");
  }

  const phases = shutdownPhases(graceMs);
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  /** @type {Set<import("node:net").Socket>} */
  const upgradedSockets = new Set();
  /** @type {Map<import("node:net").Socket, number>} */
  const activeRequests = new Map();
  let closingStarted = false;
  const onConnection = (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      upgradedSockets.delete(socket);
      activeRequests.delete(socket);
    });
  };
  const onUpgrade = (_request, socket) => upgradedSockets.add(socket);
  const onRequest = (request, response) => {
    const { socket } = request;
    activeRequests.set(socket, (activeRequests.get(socket) ?? 0) + 1);
    let complete = false;
    const onComplete = () => {
      if (complete) return;
      complete = true;
      const remaining = Math.max(0, (activeRequests.get(socket) ?? 1) - 1);
      if (remaining === 0) activeRequests.delete(socket);
      else activeRequests.set(socket, remaining);
      // An in-flight HTTP/1.1 response can finish onto a keep-alive socket after server.close()
      // began. End only after its complete response is on the wire so the close Promise need not
      // wait for the force phase. Protocol-upgraded sockets remain for their owner or force phase.
      if (closingStarted && remaining === 0 && !upgradedSockets.has(socket)) socket.end();
    };
    response.once("finish", onComplete);
    response.once("close", onComplete);
  };
  app.server.on("connection", onConnection);
  // Run before Fastify's handler so even an immediately-finished response cannot outrun tracking.
  app.server.prependListener("request", onRequest);
  app.server.on("upgrade", onUpgrade);

  let shutdownPromise = null;
  let requestedExitCode = 0;
  let forceLogged = false;
  let hardTimer = null;
  let forceTimer = null;

  function forceConnections(reason) {
    if (!forceLogged) {
      forceLogged = true;
      log(`node api shutdown force-closing connections reason=${reason}`);
    }
    // app.close() is always started before this function, matching Node's documented ordering and
    // avoiding a new-connection race between closeAllConnections() and server.close().
    app.server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
  }

  function clearTimers() {
    if (forceTimer !== null) clearTimeout(forceTimer);
    if (hardTimer !== null) clearTimeout(hardTimer);
    forceTimer = null;
    hardTimer = null;
  }

  function shutdown(reason, { exitCode = 0 } = {}) {
    if (!Number.isInteger(exitCode) || exitCode < 0) {
      throw new TypeError("shutdown exitCode must be a non-negative integer");
    }
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (shutdownPromise !== null) {
      forceConnections("repeated-signal");
      return shutdownPromise;
    }

    log(`node api shutdown started reason=${reason} grace_ms=${graceMs}`);
    closingStarted = true;
    hardTimer = setTimeout(() => {
      forceConnections("hard-deadline");
      log("node api shutdown hard deadline exceeded");
      processRef.exit(1);
    }, graceMs);
    forceTimer = setTimeout(() => forceConnections("grace-reserve"), phases.forceAfterMs);

    shutdownPromise = (async () => {
      try {
        const closing = app.close();
        // `server.close()` has now started, so ending already-idle sockets cannot race with a newly
        // accepted connection. Active and upgraded sockets are deliberately excluded.
        for (const socket of sockets) {
          if (!activeRequests.has(socket) && !upgradedSockets.has(socket)) socket.end();
        }
        await closing;
        log("node api shutdown resources closed");
        clearTimers();
        processRef.exitCode = requestedExitCode;
        log(`node api shutdown complete exit_code=${requestedExitCode}`);
      } catch {
        requestedExitCode = 1;
        processRef.exitCode = 1;
        forceConnections("close-failure");
        log("node api shutdown resource close failed");
        // Keep the referenced hard timer: it guarantees exit if the failed close left a handle.
      }
    })();
    return shutdownPromise;
  }

  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => void shutdown(signal);
    handlers.set(signal, handler);
    processRef.on(signal, handler);
  }

  return Object.freeze({
    dispose() {
      for (const [signal, handler] of handlers) processRef.removeListener(signal, handler);
      app.server.removeListener("connection", onConnection);
      app.server.removeListener("request", onRequest);
      app.server.removeListener("upgrade", onUpgrade);
    },
    get isShuttingDown() {
      return shutdownPromise !== null;
    },
    phases,
    shutdown,
  });
}
