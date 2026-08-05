// @vitest-environment jsdom
//
// Closes the gap recorded in PracticeFlow.test.tsx: `accuracy`'s divide-by-zero guard
// (`scoredWords > 0 ? ... : 0`) had nothing observing it, so removing it — which renders "NaN%" to
// a learner — passed every test in this repository.
//
// ── Why this file exists separately, and why it mocks ───────────────────────────────────────────
// Accuracy reaches the DOM only through `ProgressPanel`, behind `lazy` + `Suspense`. Three attempts
// to await that boundary failed. Measuring rather than guessing again showed why: it is not
// Suspense, it is the REAL ProgressPanel — it pulls in recharts and never settles under `act`. A
// lightweight stub in its place resolves on the first tick.
//
// So this asserts what PracticeFlow PASSES, not what ProgressPanel draws. That is deliberate and it
// is the right boundary: the guarantee under test is "PracticeFlow never emits NaN", and
// ProgressPanel has its own tests. `vi.mock` is file-scoped, which is why this is a separate file —
// PracticeFlow.test.tsx exercises `correction` mode, where the real panel is never rendered.
//
// The gap note in PracticeFlow.test.tsx proposed "a ProgressPanel-level test taking accuracy={NaN}".
// That was WRONG, and is corrected there: ProgressPanel renders `{accuracy}%` unguarded, so such a
// test would assert the bug rather than pin the guard.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { AlignmentResult, RecitationConsent } from "../lib/api";

/** Every prop set PracticeFlow hands the progress panel, in order. */
const passed: Array<Record<string, unknown>> = [];

vi.mock("./ProgressPanel", () => ({
  ProgressPanel: (props: Record<string, unknown>) => {
    passed.push(props);
    return <div className="stub-progress-panel" />;
  },
}));

const { PracticeFlow } = await import("./PracticeFlow");

const CONSENT: RecitationConsent = {
  recordingConsent: true,
  audioRetention: "discard",
  anonymizedLearning: false,
  externalAsrProcessing: false,
  guardianApproved: true,
  consentVersion: "pilot-v1",
};

const word = (status: AlignmentResult["status"], i: number): AlignmentResult => ({
  wordId: `1:1:${i}`,
  canonicalText: "بِسْمِ",
  heardText: "بِسْمِ",
  confidence: 0.9,
  status,
});

describe("PracticeFlow — the accuracy it hands the progress panel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    passed.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const accuracyFor = async (alignmentResults: AlignmentResult[]) => {
    act(() =>
      root.render(
        <PracticeFlow
          activeStepIndex={1} isRecording={false} micState="ready" mode="guided-recite"
          onAdvance={() => {}} onCheckMic={() => {}} onReset={() => {}} onSelectMode={() => {}}
          onSelectWord={() => {}} onSendToTeacher={() => {}} teacherSendState="idle" saveState="idle"
          needsConsent={false} consent={CONSENT} onConsentChange={() => {}}
          onToggleRecording={() => {}} isPlaying={false} onTogglePlay={() => {}}
          hasRecording={false} isPlayingRecording={false} onPlayRecording={() => {}} liveBars={[]}
          selectedWordId="" surahTitle="Al-Faatiha" quranVerses={[]} playingAyah={null}
          recitingWordId={null} recitationAttribution={null} translationByAyah={new Map()}
          translationAttribution={null} showTranslation={false} onToggleTranslation={() => {}}
          isLoadingVerses={false} recitationEvents={[]} alignmentResults={alignmentResults}
          tajweedResults={[]} weeklyProgress={[]} memorizationPlan={null} progress={null}
          apiError={null} isLoading={false}
        />,
      ),
    );
    for (let tick = 0; tick < 20 && passed.length === 0; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(passed.length, "the progress panel never received props — this test observed nothing").toBeGreaterThan(0);
    return passed.at(-1)!.accuracy as number;
  };

  it("hands 0, never NaN, when nothing was scored", async () => {
    // THE gap. `0/0` is NaN, and ProgressPanel renders `{accuracy}%` unguarded — so a learner who
    // opens the panel before reciting is told their accuracy is "NaN%".
    const accuracy = await accuracyFor([]);
    expect(Number.isNaN(accuracy), "accuracy was NaN — a learner sees NaN%").toBe(false);
    expect(accuracy).toBe(0);
  });

  it("hands the real percentage once words have been scored", async () => {
    // The control. Without it, hardcoding `accuracy = 0` satisfies the assertion above while
    // telling every learner they got nothing right.
    expect(await accuracyFor([word("matched", 1), word("misread", 2)])).toBe(50);
    expect(await accuracyFor([word("matched", 1), word("matched", 2), word("matched", 3), word("missed", 4)])).toBe(75);
  });

  it("hands a whole number, because the panel renders it verbatim", async () => {
    // `{accuracy}%` — an unrounded 66.666...% would reach a learner in full.
    const accuracy = await accuracyFor([word("matched", 1), word("matched", 2), word("extra", 3)]);
    expect(Number.isInteger(accuracy), `accuracy ${accuracy} is not a whole number`).toBe(true);
    expect(accuracy).toBe(67);
  });
});
