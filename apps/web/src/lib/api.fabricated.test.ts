// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { predictAlignment, predictTajweed, requestTeacherReview } from "./api";

/**
 * A production build must CALL the services, not answer for them.
 *
 * ── The defect ──────────────────────────────────────────────────────────────────────────────────
 * Six call sites across `api.ts` and `serverAsr.ts` short-circuited on a runtime read of the query
 * string — `new URLSearchParams(window.location.search).has("smoke")` — which survives into the
 * shipped bundle. Appending `?smoke` to a deployed URL made the app answer from hardcoded values:
 * a transcript at confidence 0.95 with nothing recorded, two canned alignments, one canned finding.
 *
 * `persistSessionAlignments` has NO such branch. It always POSTs, and App.tsx hands it exactly what
 * `predictAlignment` returned, under the comment "Persist the real alignment to this session". So
 * the fabricated words went into the real database against a real learner's real session.
 *
 * These tests assert the BEHAVIOUR rather than the predicate: that in a production build each of
 * these functions reaches the network. A predicate assertion would pass against a call site that
 * had been rewired to consult something else.
 */
describe("a production build calls the real services", () => {
  const fetchMock = vi.fn();

  const originalUrl = window.location.href;

  beforeEach(() => {
    vi.stubEnv("MODE", "production");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // jsdom, and `?smoke` actually present. Without both, the old expression
    // (`typeof window !== "undefined" && ...has("smoke")`) is dead in a node environment and these
    // tests pass whether or not the hatch exists — measured: restoring it changed nothing until the
    // URL was set here.
    window.history.replaceState({}, "", "/?smoke");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", originalUrl);
  });

  /** A JSON response good enough for the caller to parse; the assertion is that we got here at all. */
  const ok = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

  it("predictAlignment asks the ML service instead of inventing two words", async () => {
    fetchMock.mockImplementation(() => ok({ alignments: [], confidence: 0 }));

    const result = await predictAlignment({
      tenantId: "hikmah-pilot-erbil",
      userId: "learner-1",
      sessionId: "session-1",
      surahNumber: 1,
      ayahStart: 1,
      ayahEnd: 7,
      recognizedText: ["بِسْمِ"],
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/ml/alignments:predict");
    // And specifically NOT the canned pair. This is what reached persistSessionAlignments.
    expect(result.alignments).not.toContainEqual(
      expect.objectContaining({ wordId: "1:1:2", status: "misread", confidence: 0.85 }),
    );
  });

  it("predictTajweed asks the ML service instead of inventing a Ghunnah finding", async () => {
    fetchMock.mockImplementation(() => ok({ findings: [], confidence: 0 }));

    const result = await predictTajweed({
      tenantId: "hikmah-pilot-erbil",
      userId: "learner-1",
      sessionId: "session-1",
      surahNumber: 1,
      ayahStart: 1,
      ayahEnd: 7,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.findings).toEqual([]);
  });

  it("requestTeacherReview sends the request it reports as sent", async () => {
    // Its own comment records this as a fixed defect: the previous implementation "displayed
    // 'Sent to teacher.' without any request at all (SHIP_PLAN P1.2)". `?smoke` reintroduced it as
    // a localStorage write followed by a resolved promise.
    fetchMock.mockImplementation(() => ok({}));

    await requestTeacherReview({
      tenantId: "hikmah-pilot-erbil",
      userId: "learner-1",
      sessionId: "session-1",
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain("request-teacher-review");
  });
});

describe("the dev server keeps the stubs the browser smokes rely on", () => {
  // The control. Without it, every assertion above is satisfied by deleting the stubs outright,
  // which would break smoke-browser, smoke-a11y and smoke-e2e — all three of which spawn `vite`
  // and therefore run with MODE === "development".
  const originalUrl = window.location.href;
  beforeEach(() => {
    vi.stubEnv("MODE", "development");
    // `?smoke` as well as the mode. The API stubs are selected by the flag and GATED by the mode —
    // a dev page load without the flag must still call the real service, which is what the browser
    // smokes and a developer both expect.
    window.history.replaceState({}, "", "/?smoke");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", originalUrl);
  });

  it("predictAlignment still answers without a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await predictAlignment({
        tenantId: "hikmah-pilot-erbil",
        userId: "learner-1",
        sessionId: "session-1",
        surahNumber: 1,
        ayahStart: 1,
        ayahEnd: 7,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.alignments).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a dev page load without the flag still calls the service", () => {
  // The other half of the gate, and the regression the first attempt at this fix caused: swapping
  // the flag for the mode made every dev load and every vitest run answer from stubs, and two App
  // smoke tests that depend on the default-surah fallback started reading the canned list instead.
  const originalUrl = window.location.href;
  beforeEach(() => {
    vi.stubEnv("MODE", "development");
    window.history.replaceState({}, "", "/");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", originalUrl);
  });

  it("predictAlignment reaches the network", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ alignments: [], confidence: 0 }) } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    await predictAlignment({
      tenantId: "hikmah-pilot-erbil",
      userId: "learner-1",
      sessionId: "session-1",
      surahNumber: 1,
      ayahStart: 1,
      ayahEnd: 7,
    });

    expect(fetchMock).toHaveBeenCalled();
  });
});
