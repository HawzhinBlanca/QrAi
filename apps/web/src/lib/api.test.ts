import { afterEach, describe, expect, it, vi } from "vitest";

import { exportMyData, deleteMyData } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Learner privacy self-service (P2.8): the export/delete helpers must target the right endpoint
// and request ONLY the caller's own learnerId — the backend authz (require_self_or_any) permits a
// learner to act on their own id alone, so the client must send userId as learnerId.
describe("privacy self-service API", () => {
  it("exportMyData POSTs the caller's own learnerId to /v1/privacy/export and returns the job", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      expect(String(input)).toContain("/v1/privacy/export");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ learnerId: "learner-1" });
      return new Response(
        JSON.stringify({ kind: "export", includedRecords: ["a", "b", "c"], deletedRecords: [], audioObjectKeysDeleted: [] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await exportMyData({ tenantId: "t1", userId: "learner-1" });
    expect(result.includedRecords).toHaveLength(3);
    expect(result.deletedRecords).toHaveLength(0);
  });

  it("deleteMyData POSTs to /v1/privacy/delete and surfaces the erased counts", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/v1/privacy/delete");
      return new Response(
        JSON.stringify({ kind: "delete", includedRecords: [], deletedRecords: ["s1", "s2"], audioObjectKeysDeleted: ["k1"] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteMyData({ tenantId: "t1", userId: "learner-1" });
    expect(result.deletedRecords).toHaveLength(2);
    expect(result.audioObjectKeysDeleted).toHaveLength(1);
  });

  it("throws on a non-OK response so the UI can show an honest error instead of a false success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));
    await expect(deleteMyData({ tenantId: "t1", userId: "learner-1" })).rejects.toThrow();
  });
});

// T3 forced alignment: the web sends the recorded audio + canonical transcript to the ASR
// force-align proxy, then persists the REAL per-word start/end (not the old hardcoded 0/0).
describe("forced alignment (T3) API", () => {
  it("forceAlign POSTs audio + transcript to /v1/asr/force-align and returns the word spans", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      expect(String(input)).toContain("/v1/asr/force-align");
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body));
      expect(body.audioBase64).toBe("QUJD");
      expect(body.transcript).toBe("بِسْمِ ٱللَّهِ");
      return new Response(
        JSON.stringify({ words: [{ word: "بِسْمِ", start: 0.06, end: 0.61, score: 0.9 }], duration: 0.61 }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { forceAlign } = await import("./api");
    const words = await forceAlign({
      tenantId: "t1",
      userId: "learner-1",
      audioBase64: "QUJD",
      audioFormat: "webm",
      transcript: "بِسْمِ ٱللَّهِ",
    });
    expect(words).toHaveLength(1);
    expect(words[0].start).toBe(0.06);
  });

  it("persistSessionAlignments writes the real timing for a mapped word and 0/0 for an unmapped one", async () => {
    let sent: any = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      expect(String(input)).toContain("/alignments");
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ persisted: 2, skippedInvalidStatus: 0, skippedUnknownWord: 0 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { persistSessionAlignments } = await import("./api");
    await persistSessionAlignments({
      tenantId: "t1",
      userId: "learner-1",
      sessionId: "session-1",
      alignments: [
        { wordId: "1:1:1", canonicalText: "بِسْمِ", heardText: "بِسْمِ", status: "matched", confidence: 0.9 },
        { wordId: "1:1:2", canonicalText: "ٱللَّهِ", heardText: "ٱللَّهِ", status: "matched", confidence: 0.9 },
      ],
      timingsByWordId: new Map([["1:1:1", { startMs: 60, endMs: 610 }]]),
    });

    expect(sent.alignments[0]).toMatchObject({ wordId: "1:1:1", startMs: 60, endMs: 610 });
    expect(sent.alignments[1]).toMatchObject({ wordId: "1:1:2", startMs: 0, endMs: 0 });
  });

  it("buildTimingsByWordId maps spans to word ids by position and converts seconds to ms", async () => {
    const { buildTimingsByWordId } = await import("./api");
    const recited = [{ wordId: "1:1:1" }, { wordId: "1:1:2" }];
    const aligned = [
      { word: "بِسْمِ", start: 0.06, end: 0.61, score: 0.9 },
      { word: "ٱللَّهِ", start: 0.7, end: 1.2, score: 0.9 },
    ];
    const map = buildTimingsByWordId(recited, aligned);
    expect(map).toBeDefined();
    expect(map!.get("1:1:1")).toEqual({ startMs: 60, endMs: 610 });
    expect(map!.get("1:1:2")).toEqual({ startMs: 700, endMs: 1200 });
  });

  it("buildTimingsByWordId BAILS (undefined) on a count mismatch so no misattributed timing is persisted", async () => {
    const { buildTimingsByWordId } = await import("./api");
    // 2 recited words but the aligner returned 3 spans (e.g. a canonicalText tokenized to two) —
    // positional mapping is no longer trustworthy, so the whole map must be dropped.
    const recited = [{ wordId: "1:1:1" }, { wordId: "1:1:2" }];
    const aligned = [
      { word: "a", start: 0, end: 0.3, score: 0.9 },
      { word: "b", start: 0.3, end: 0.6, score: 0.9 },
      { word: "c", start: 0.6, end: 0.9, score: 0.9 },
    ];
    expect(buildTimingsByWordId(recited, aligned)).toBeUndefined();
  });

  it("buildTimingsByWordId skips a zero/negative-length span but keeps the rest", async () => {
    const { buildTimingsByWordId } = await import("./api");
    const recited = [{ wordId: "1:1:1" }, { wordId: "1:1:2" }];
    const aligned = [
      { word: "a", start: 0.5, end: 0.5, score: 0.9 }, // zero-length -> skipped
      { word: "b", start: 0.7, end: 1.2, score: 0.9 },
    ];
    const map = buildTimingsByWordId(recited, aligned);
    expect(map!.has("1:1:1")).toBe(false);
    expect(map!.get("1:1:2")).toEqual({ startMs: 700, endMs: 1200 });
  });
});
