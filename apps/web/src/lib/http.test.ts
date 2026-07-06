import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "./http";

afterEach(() => {
  vi.unstubAllGlobals();
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
});
