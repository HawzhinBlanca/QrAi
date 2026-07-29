import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapPilotSession } from "./api";
import { fetchWithTimeout } from "./http";
import { isPilotMode, setPilotIdentity } from "./pilotSession";

afterEach(() => {
  vi.unstubAllGlobals();
  setPilotIdentity(null);
});

describe("fetchWithTimeout", () => {
  it("passes an abort signal to fetch and returns the response on success", async () => {
    const response = new Response("ok");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      // The request is armed with an abort signal even on the happy path.
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithTimeout("https://api.test/health", {}, 1000)).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the request once the timeout elapses (a hung backend can't freeze the UI)", async () => {
    // fetch that never resolves on its own — it settles only when the signal aborts.
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // A short real timeout keeps the test fast and deterministic.
    await expect(fetchWithTimeout("https://api.test/slow", {}, 10)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("does not abort a request that completes before the timeout", async () => {
    const response = new Response("done");
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init: RequestInit = {}) =>
        new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          setTimeout(() => resolve(response), 5);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // 5ms fetch under a 200ms timeout resolves cleanly; the timer is cleared in the finally block.
    await expect(fetchWithTimeout("https://api.test/quick", {}, 200)).resolves.toBe(response);
  });

  it("still enforces its own timeout when the caller also passes a signal", async () => {
    // Regression test: `init.signal ?? controller.signal` used to DISCARD the timeout's own
    // signal whenever a caller passed one, silently defeating this function's whole stated
    // purpose for any caller-provided signal. A fetch that only settles on abort must still be
    // aborted by the timeout even when the caller's own (never-firing) signal is also present.
    const callerController = new AbortController();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithTimeout("https://api.test/slow", { signal: callerController.signal }, 10),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts immediately if the caller's signal is already aborted before the call", async () => {
    const callerController = new AbortController();
    callerController.abort();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithTimeout("https://api.test/already-aborted", { signal: callerController.signal }, 5000),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("also aborts on the caller's own signal, independent of the timeout", async () => {
    const callerController = new AbortController();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithTimeout(
      "https://api.test/caller-cancels",
      { signal: callerController.signal },
      60000,
    );
    callerController.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("fetchWithTimeout credentials (pilot cookie auth)", () => {
  function captureCredentials(): { get: () => RequestCredentials | undefined } {
    let seen: RequestCredentials | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen = init.credentials;
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetchMock);
    return { get: () => seen };
  }

  it("does NOT send credentials when not in pilot mode (dev-header / bearer path)", async () => {
    const cap = captureCredentials();
    await fetchWithTimeout("https://api.test/v1/x", {}, 1000);
    // Undefined => browser default (same-origin); the HttpOnly cookie is not force-sent.
    expect(cap.get()).toBeUndefined();
  });

  it("sends credentials:'include' in pilot mode so the __Host-qrai-pilot cookie rides along", async () => {
    setPilotIdentity({
      userId: "learner-1",
      tenantId: "hikmah-pilot-erbil",
      displayName: "L",
      role: "learner",
      csrfToken: "csrf-x",
    });
    const cap = captureCredentials();
    await fetchWithTimeout("https://api.test/v1/learner/progress", {}, 1000);
    expect(cap.get()).toBe("include");
  });

  it("lets an explicit caller credentials value win over the pilot default", async () => {
    setPilotIdentity({
      userId: "learner-1",
      tenantId: "hikmah-pilot-erbil",
      displayName: "L",
      role: "learner",
      csrfToken: "csrf-x",
    });
    const cap = captureCredentials();
    await fetchWithTimeout("https://api.test/v1/x", { credentials: "omit" }, 1000);
    expect(cap.get()).toBe("omit");
  });
});

describe("bootstrapPilotSession (invite redemption fault path)", () => {
  it("throws and does NOT establish a pilot session on a non-2xx response (bad/expired invite)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    await expect(bootstrapPilotSession("bad-or-expired-token")).rejects.toThrow(/401/);
    // A failed redemption must never leave the app falsely authenticated.
    expect(isPilotMode()).toBe(false);
  });

  it("establishes the pilot session on a successful redemption", async () => {
    const body = {
      userId: "learner-9",
      tenantId: "hikmah-pilot-erbil",
      displayName: "Nine",
      role: "learner",
      csrfToken: "csrf-9",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const identity = await bootstrapPilotSession("good-token");
    expect(identity.userId).toBe("learner-9");
    expect(isPilotMode()).toBe(true);
  });
});
