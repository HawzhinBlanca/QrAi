// @vitest-environment jsdom
//
// P2.6 — "there is no work" and "we could not find out" must never look the same.
//
// `TeacherSurface.loadQueue` caught a failed fetch, wrote it to `console.error`, and left
// `sessions` at `[]`. The render then fell through to the empty branch, so a teacher whose backend
// was unreachable was shown:
//
//     No pending recitations.
//
// which is not a degraded state — it is a confident, wrong answer. The teacher closes the tab
// believing they are done. By `docs/readiness/JOURNEYS.md` that is worse than an error: silence
// outranks a failure, because nothing downstream can tell the difference. The same shape applied to
// the word alignments, where an unreadable response rendered as a recitation containing no words —
// "the learner said nothing".
//
// These tests pin the DISTINCTION, not the wording. An implementation that shows the same message
// for both states fails here regardless of what that message says.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { TeacherSurface } from "./TeacherSurface";
import en from "../locales/en.json";

const SESSION = {
  id: "sess-degraded",
  learnerId: "learner-A",
  reviewStatus: "teacher-review-required",
  startedAt: "2026-08-12T10:00:00Z",
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
  accuracyScore: 0.9,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(<TeacherSurface tenantId="hikmah-pilot-erbil" />);
  });
}

/** Answer every read normally except the ones named in `fail`. */
function stubFetch(fail: string[] = [], sessions: unknown[] = [SESSION]) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (fail.some((f) => url.includes(f))) return Promise.reject(new Error("network down"));
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
    if (url.includes("/alignments")) return json([]);
    if (url.includes("/v1/tajweed-findings")) return json([]);
    if (url.includes("/v1/recitation-sessions")) return json(sessions);
    return json([]);
  });
}

describe("teacher queue — unavailable is not empty", () => {
  it("says the queue could not be loaded when the service does not answer", async () => {
    // console.error is the OLD behaviour, still there for the operator; silenced so the test output
    // reflects assertions rather than the component doing the right thing.
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(["/v1/recitation-sessions"]);
    await mount();

    const text = container.textContent ?? "";
    expect(text).toContain(en.teacherSurface.queueUnavailable);
    expect(
      text,
      "the failure must not be reported as an empty queue — that is a wrong answer, not a degraded one",
    ).not.toContain(en.teacherSurface.noPending);
  });

  it("offers a control that actually retries, and succeeds when the service comes back", async () => {
    // A message with no way forward is the same dead end as no message. This asserts the button
    // ACTS: the second load returns the session, and the error state clears.
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempt = 0;
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
      if (url.includes("/v1/recitation-sessions") && !url.includes("/alignments")) {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("network down"));
        return json([SESSION]);
      }
      return json([]);
    });
    await mount();

    const retry = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === en.teacherSurface.queueRetry,
    );
    expect(retry, "the unavailable state must offer a retry control").toBeTruthy();

    await act(async () => retry!.click());

    const text = container.textContent ?? "";
    expect(text).not.toContain(en.teacherSurface.queueUnavailable);
    expect(text, "after a successful retry the queue must show the waiting session").toContain(
      "Al-Fatihah",
    );
  });

  it("still says the queue is empty when it genuinely is", async () => {
    // The other direction. Without this, an implementation that showed the unavailable message
    // unconditionally would pass the first test — and would be a new instance of the same defect,
    // pointing the other way.
    stubFetch([], []);
    await mount();

    const text = container.textContent ?? "";
    expect(text).toContain(en.teacherSurface.noPending);
    expect(text).not.toContain(en.teacherSurface.queueUnavailable);
  });

  it("announces the failure to a screen reader rather than only drawing it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(["/v1/recitation-sessions"]);
    await mount();

    const alert = container.querySelector('[role="alert"]');
    expect(alert, "an unreachable service must be announced, not just rendered").toBeTruthy();
    expect(alert?.textContent).toContain(en.teacherSurface.queueUnavailable);
  });
});

describe("session words — unreadable is not silent", () => {
  it("says the words could not be loaded rather than showing a recitation with none", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(["/alignments"]);
    await mount();

    const open = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Al-Fatihah"),
    );
    expect(open, "the queue should list the session so it can be opened").toBeTruthy();
    await act(async () => open!.click());

    expect(container.textContent ?? "").toContain(en.teacherSurface.alignmentsUnavailable);
  });
});
