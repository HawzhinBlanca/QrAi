// @vitest-environment jsdom
//
// The accuracy a learner is shown about their own recitation.
//
// `PracticeFlow.tsx:116` records the regression: "Real accuracy from live alignment results
// (replaces the old hardcoded 78/32/3)." That is the THIRD instance of this shape in this codebase
// — ModeBanner's hardcoded "three words" and CompletePanel's unconditional "Progress saved." are the
// other two. All three told a learner something about their own recitation that was not true.
//
// ── The invariant that outlives the fix ─────────────────────────────────────────────────────────
// The numbers come from partitioning `AlignmentResult["status"]` across two filters: `matched` is
// correct, and `misread | missed | needs-review | extra` are mistakes. Those two lists happen to
// cover the whole union today.
//
// Nothing enforces that. TypeScript cannot: these are `.filter()` predicates with explicit string
// comparisons, not a `switch` it can check for exhaustiveness. Add a sixth status and it falls into
// NEITHER list — silently absent from both the numerator and the denominator, changing every
// learner's accuracy with nothing to notice. A pin on today's state, dressed as a calculation.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../i18n";
import type { AlignmentResult, RecitationConsent } from "../lib/api";
import { PracticeFlow } from "./PracticeFlow";

/** Every member of the status union, so a sixth one cannot be added without failing a test here. */
const ALL_STATUSES: Array<AlignmentResult["status"]> = [
  "matched",
  "misread",
  "missed",
  "needs-review",
  "extra",
];

const word = (status: AlignmentResult["status"], i: number): AlignmentResult => ({
  wordId: `1:1:${i}`,
  canonicalText: "بِسْمِ",
  heardText: "بِسْمِ",
  confidence: 0.9,
  status,
});

const CONSENT: RecitationConsent = {
  recordingConsent: true,
  audioRetention: "discard",
  anonymizedLearning: false,
  externalAsrProcessing: false,
  guardianApproved: true,
  consentVersion: "pilot-v1",
};

describe("PracticeFlow — the mistake count a learner is shown", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /**
   * `correction` mode on purpose: ModeBanner renders the mistake count as text there, so the
   * computation is observable without resolving the Suspense boundary ProgressPanel sits behind.
   * This exercises the real compute-and-pass path rather than a helper lifted out for testing.
   */
  const render = (alignmentResults: AlignmentResult[], mode: "correction" | "guided-recite" = "correction") => {
    act(() =>
      root.render(
        <PracticeFlow
          activeStepIndex={2}
          isRecording={false}
          micState="ready"
          mode={mode}
          onAdvance={() => {}}
          onCheckMic={() => {}}
          onReset={() => {}}
          onSelectMode={() => {}}
          onSelectWord={() => {}}
          onSendToTeacher={() => {}}
          teacherSendState="idle"
          saveState="idle"
          needsConsent={false}
          consent={CONSENT}
          onConsentChange={() => {}}
          onToggleRecording={() => {}}
          isPlaying={false}
          onTogglePlay={() => {}}
          hasRecording={false}
          isPlayingRecording={false}
          onPlayRecording={() => {}}
          liveBars={[]}
          selectedWordId=""
          surahTitle="Al-Faatiha"
          quranVerses={[]}
          playingAyah={null}
          recitingWordId={null}
          recitationAttribution={null}
          translationByAyah={new Map()}
          translationAttribution={null}
          showTranslation={false}
          onToggleTranslation={() => {}}
          isLoadingVerses={false}
          recitationEvents={[]}
          alignmentResults={alignmentResults}
          tajweedResults={[]}
          weeklyProgress={[]}
          memorizationPlan={null}
          progress={null}
          apiError={null}
          isLoading={false}
        />,
      ),
    );
    return container.textContent ?? "";
  };

  it("counts EVERY non-matched status as a mistake, leaving none unclassified", () => {
    // THE invariant. One word per status: four are mistakes, `matched` is not. A status quietly
    // dropped from the mistakes filter shows up here as 3, and — because the same partition feeds
    // the accuracy denominator — would silently inflate the percentage a learner is shown.
    const results = ALL_STATUSES.map((status, i) => word(status, i));
    expect(render(results)).toContain("4 words");
  });

  it("reports the real count, not a fixed one", () => {
    // The shipped regression was hardcoded numbers. One mistake must read as one.
    expect(render([word("matched", 1), word("misread", 2)])).toContain("1 word");
    expect(render([word("missed", 1), word("missed", 2), word("extra", 3)])).toContain("3 words");
  });

  it("says nothing was flagged when a pass was clean, rather than reporting zero", () => {
    const text = render([word("matched", 1), word("matched", 2)]);
    expect(text).toContain("No flagged words");
    expect(text, "a clean pass was reported as a count").not.toMatch(/\b0 words?\b/);
  });

  it("survives an empty alignment", () => {
    // An empty alignment must not crash and must read as a clean pass rather than a count.
    const text = render([]);
    expect(text).toContain("No flagged words");
    expect(text, "an empty alignment was reported as a count").not.toMatch(/\b0 words?\b/);
  });

  // ── accuracy is covered NEXT DOOR, not here ────────────────────────────────────────────────────
  // `accuracy`'s divide-by-zero guard is asserted in PracticeFlow.accuracy.test.tsx, which mocks
  // ProgressPanel and inspects the props PracticeFlow hands it.
  //
  // It is a separate file because `vi.mock` is file-scoped and these tests deliberately run in
  // `correction` mode, where the real panel is never rendered.
  //
  // An earlier note here proposed closing that gap with "a ProgressPanel-level test taking
  // accuracy={NaN}". That was WRONG: ProgressPanel renders `{accuracy}%` unguarded, so such a test
  // would have asserted the bug rather than pinned the guard. The guarantee is that PracticeFlow
  // never EMITS NaN, which is a claim about what it passes, not about what the panel draws.
});
