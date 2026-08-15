// @vitest-environment jsdom
//
// The teacher review queue must show the findings of the session on screen, and no others.
//
// `TeacherSurface` fetches findings TENANT-WIDE and then decides which belong to the selected
// session. It used to decide by matching `wordId` against that session's alignments. `wordId` is the
// CANONICAL word id ("1:1:2") — identical for every learner reciting the same passage — so a teacher
// reviewing one learner was shown another learner's findings under this session, and `handleReview`
// submitted their accept/reject against that finding's id. The decision landed on the wrong
// recitation, which is the single thing the review gate exists to get right.
//
// This RENDERS the real component. A first version of this test reimplemented the filter inside the
// test file and asserted against that copy — it passed with the component's buggy filter fully
// restored, which is a test that cannot fail. The two findings below share a wordId precisely so
// that the old predicate cannot tell them apart.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import "../i18n";
import { TeacherSurface } from "./TeacherSurface";

const SESSION_ON_SCREEN = "sess-A";
const OTHER_LEARNERS_SESSION = "sess-B";
const SHARED_WORD_ID = "1:1:2"; // canonical: both learners recited the same word

const session = {
  id: SESSION_ON_SCREEN,
  learnerId: "learner-A",
  reviewStatus: "teacher-review-required",
  startedAt: "2026-08-10T10:00:00Z",
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
  accuracyScore: 0.9,
};

const finding = (id: string, sessionId: string, explanation: string) => ({
  id,
  sessionId,
  wordId: SHARED_WORD_ID,
  rule: "Ghunnah",
  severity: "warning",
  confidence: 0.85,
  explanation,
  reviewStatus: "teacher-review-required",
  sources: [],
});

const MINE = "EXPLANATION-FOR-THE-SESSION-ON-SCREEN";
const THEIRS = "EXPLANATION-BELONGING-TO-ANOTHER-LEARNER";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
    if (url.includes("/alignments")) {
      return json([{ wordId: SHARED_WORD_ID, canonicalText: "بِسْمِ", heardText: "بِسْمِ", status: "matched" }]);
    }
    if (url.includes("/audio")) return Promise.resolve(new Response(null, { status: 404 }));
    if (url.includes("/v1/tajweed-findings")) {
      // Tenant-wide, as the real endpoint is: BOTH learners' findings come back.
      return json([finding("tf-A", SESSION_ON_SCREEN, MINE), finding("tf-B", OTHER_LEARNERS_SESSION, THEIRS)]);
    }
    if (url.includes("/v1/recitation-sessions")) return json([session]);
    return json([]);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows only the open session's findings, never another learner's", async () => {
  await act(async () => {
    root = createRoot(container);
    root.render(<TeacherSurface tenantId="hikmah-pilot-erbil" />);
  });

  // Open the session the teacher is reviewing.
  const open = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Al-Fatihah"),
  );
  expect(open, "the pending session should be listed").toBeTruthy();
  await act(async () => open!.click());

  const shown = container.textContent ?? "";
  expect(shown, "the session's own finding must be shown").toContain(MINE);
  expect(shown, "another learner's finding was attributed to this session").not.toContain(THEIRS);
});
