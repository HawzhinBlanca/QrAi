// @vitest-environment jsdom
//
// A teacher must be able to HEAR the recitation they are judging, and must be told the truth when
// they cannot.
//
// `TeacherSurface` fetched `/v1/recitation-sessions/{id}/audio` on every session selection — the
// realtime GATEWAY's WebSocket path, against the PLATFORM-API base, over plain HTTP. platform-api
// registers `/v1/tajweed-findings/{id}/audio` and nothing like it, so this 404'd every time and the
// catch rendered "No audio available for this session". Teachers reviewed with no audio at all, and
// the failure was indistinguishable from a learner having exercised their right to have the
// recording destroyed.
//
// These RENDER the real component. The first test asserts the request goes to a route that EXISTS
// and never to the one that does not; the rest assert the four ADR-0037 outcomes stay distinct,
// because collapsing them is the actual defect — not the 404.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import "../i18n";
import { TeacherSurface } from "./TeacherSurface";

const SESSION = "sess-A";

const session = {
  id: SESSION,
  learnerId: "learner-A",
  reviewStatus: "teacher-review-required",
  startedAt: "2026-08-11T10:00:00Z",
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
  accuracyScore: 0.9,
};

const finding = (audioStatus: string) => ({
  id: "tf-A",
  sessionId: SESSION,
  wordId: "1:1:2",
  rule: "Ghunnah",
  severity: "warning",
  confidence: 0.85,
  explanation: "EXPLANATION",
  reviewStatus: "teacher-review-required",
  sources: [],
  audioStatus,
});

let container: HTMLDivElement;
let root: Root;
let requested: string[];

/** Mount, open the pending session, and return the rendered text. */
async function openSession() {
  await act(async () => {
    root = createRoot(container);
    root.render(<TeacherSurface tenantId="hikmah-pilot-erbil" />);
  });
  const open = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Al-Fatihah"),
  );
  expect(open, "the pending session should be listed").toBeTruthy();
  await act(async () => open!.click());
}

function install(audioStatus: string, audioResponse: () => Response) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
    if (url.includes("/audio")) return Promise.resolve(audioResponse());
    if (url.includes("/alignments")) return json([]);
    if (url.includes("/v1/tajweed-findings")) return json([finding(audioStatus)]);
    if (url.includes("/v1/recitation-sessions")) return json([session]);
    return json([]);
  });
}

beforeEach(() => {
  requested = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  // jsdom has no audio device; HTMLMediaElement.play is not implemented and throws unhandled.
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  window.URL.createObjectURL = vi.fn(() => "blob:stub");
  window.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("never requests the session audio route, which does not exist", async () => {
  install("available", () => new Response(JSON.stringify({ audioBase64: "AAAA" })));
  await openSession();

  // The click MATTERS. A first version of this test asserted the absence without clicking listen,
  // and audio is now only fetched on click — so it passed with the ghost route fully restored.
  // Found by putting the bad URL back and watching this test stay green.
  const listen = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Listen to this word"),
  );
  expect(listen, "an available recording must offer a control to click").toBeTruthy();
  await act(async () => listen!.click());

  expect(requested.some((u) => u.includes("/audio")), "no audio was requested at all").toBe(true);
  const ghost = requested.filter((u) => /\/v1\/recitation-sessions\/[^/]+\/audio/.test(u));
  expect(ghost, "requested a route platform-api does not register").toEqual([]);
});

it("opening a session does not fetch audio — listening is an audited act", async () => {
  // Fetching on selection would write "a teacher listened to this child" into the audit log for
  // every session merely opened to read the text. The request must follow the click.
  install("available", () => new Response(JSON.stringify({ audioBase64: "AAAA" })));
  await openSession();
  expect(requested.filter((u) => u.includes("/audio"))).toEqual([]);
});

it("clicking listen fetches the audited per-finding route", async () => {
  install("available", () => new Response(JSON.stringify({ audioBase64: "AAAA" })));
  await openSession();

  const listen = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Listen to this word"),
  );
  expect(listen, "an available recording must offer a control").toBeTruthy();
  await act(async () => listen!.click());

  expect(requested.some((u) => u.includes("/v1/tajweed-findings/tf-A/audio"))).toBe(true);
});

it("an erased recording says so, and is not offered as a broken button", async () => {
  // The distinction the old code destroyed. "Erased at the learner's request" is a privacy outcome
  // the teacher must see as such — not a fault, and not something to retry.
  install("discarded", () => new Response(null, { status: 410 }));
  await openSession();

  const shown = container.textContent ?? "";
  expect(shown).toContain("Recording erased at the learner's request");
  expect(shown, "an erasure must not be reported as a missing file").not.toContain(
    "No audio available for this session",
  );

  const listen = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Recording erased"),
  );
  expect(listen?.disabled, "asking for erased audio would write a pointless audit row").toBe(true);
});

it("a session that never captured audio is distinguishable from one that was erased", async () => {
  install("not-captured", () => new Response(null, { status: 404 }));
  await openSession();

  const shown = container.textContent ?? "";
  expect(shown).toContain("No recording was captured");
  expect(shown, "the two outcomes must not share a message").not.toContain("erased at the learner's request");
});
