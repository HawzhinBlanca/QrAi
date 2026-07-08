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
