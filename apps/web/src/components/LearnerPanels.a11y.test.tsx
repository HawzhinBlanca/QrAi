// @vitest-environment jsdom
//
// P6.2 — axe automation for the panels a learner reads during practice. These carry the product's
// actual content: the Qur'an text, the mistakes, the tajweed feedback, the progress chart. None had
// ever been scanned.
//
// Where a panel has an empty state AND a populated state, both are audited. The empty state is the
// one a first-session learner sees, and it is a different tree.
import { Suspense } from "react";
import { afterEach, describe, expect, it } from "vitest";

import "../i18n";
import { seriousViolations } from "../test-utils/axe";
import type { TajweedFinding } from "../lib/api";
import type { ProgressBar, QuranVerse, RecitationEvent, SimilarVerse } from "../data/quran";
import type { SurahInfo } from "../lib/api";
import { AudioCoach } from "./AudioCoach";
import { CompletePanel, type SaveState } from "./CompletePanel";
import { IssuePanel } from "./IssuePanel";
import { MutashabihatPanel } from "./MutashabihatPanel";
import { ProgressPanel } from "./ProgressPanel";
import { QuranReader } from "./QuranReader";
import { SurahPicker } from "./SurahPicker";
import { TajweedPanel } from "./TajweedPanel";

afterEach(() => {
  document.body.innerHTML = "";
});

const verses: QuranVerse[] = [
  {
    id: "1:1",
    verseNumber: 1,
    words: [
      { id: "1:1:1", text: "بِسْمِ", status: "good" },
      { id: "1:1:2", text: "ٱللَّهِ", status: "mistake" },
      { id: "1:1:3", text: "ٱلرَّحْمَٰنِ", status: "needs-work" },
      { id: "1:1:4", text: "ٱلرَّحِيمِ", status: "missed" },
    ],
  },
];

const events: RecitationEvent[] = (["mistake", "missed", "needs-work"] as const).map((kind, i) => ({
  id: `event-${i}`,
  kind,
  wordId: `1:1:${i + 1}`,
  word: "ٱللَّهِ",
  expected: "ٱللَّهِ",
  heard: "ٱللَّه",
  timestamp: "2026-08-12T00:00:00Z",
  note: "Lengthen the madd.",
}));

const similar: SimilarVerse[] = [
  { reference: "2:2", arabic: "ذَٰلِكَ ٱلْكِتَٰبُ", reason: "Shared opening" },
];

const weekly: ProgressBar[] = [
  { date: "2026-08-06", accuracy: 82, sessions: 2 },
  // accuracy null is a real state — a day with sessions but no persisted alignments.
  { date: "2026-08-07", accuracy: null, sessions: 1 },
];

const surahs: SurahInfo[] = [
  { surahNumber: 1, ayahCount: 7, name: "Al-Fatihah" },
  { surahNumber: 2, ayahCount: 286, name: "Al-Baqarah" },
];

const eligibleFinding: TajweedFinding = {
  wordId: "1:1:1",
  rule: "Ghunnah",
  analysisBasis: "acoustic",
  arabicName: "غنة",
  category: "ghunnah",
  severity: "warning",
  explanation: "Hold the nasalization.",
  confidence: 0.9,
  reviewStatus: "teacher-reviewed",
  sources: [{ id: "tajweed-source", title: "Tajweed reference", citation: "Rule 1" }],
  withheld: false,
  startMs: 120,
  endMs: 460,
  audioStatus: "available",
  evidenceId: "audio-evidence-1",
  modelVersion: "acoustic-model-v1",
  modelArtifactSha256: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  acousticDatasetVersion: "kurdish-l1-held-out-v1",
  acousticDatasetManifestSha256: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  calibratorId: "tajweed-calibrator-v1",
  calibratorArtifactSha256: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  calibrationStatus: "calibrated",
  evaluationEvidenceId: "evaluation-evidence-v1",
  evaluationEvidenceSha256: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  evaluationEvidenceStatus: "release-trusted",
  auditEventId: "audit-learner-feedback-1",
};

describe("learner panel accessibility (axe automation)", () => {
  it("QuranReader has no serious/critical violations", async () => {
    expect(
      await seriousViolations(
        <QuranReader
          activeWordId="1:1:2"
          selectedWordId="1:1:2"
          verses={verses}
          onSelectWord={() => {}}
          playingVerseNumber={1}
          recitingWordId="1:1:2"
          recitationAttribution="Reciter — CC BY"
          translationByAyah={new Map([[1, "In the name of God."]])}
          translationAttribution="Translator — CC BY"
          showTranslation
          onToggleTranslation={() => {}}
        />,
      ),
    ).toEqual([]);
  });

  // aria-busy + dimmed: the state a learner sees while switching surah. Loading states are where
  // screen-reader announcements are usually forgotten, so it gets its own audit.
  it("QuranReader has no serious/critical violations while loading", async () => {
    expect(
      await seriousViolations(
        <QuranReader
          activeWordId=""
          selectedWordId=""
          verses={[]}
          onSelectWord={() => {}}
          isLoading
        />,
      ),
    ).toEqual([]);
  });

  it("AudioCoach has no serious/critical violations while recording", async () => {
    expect(
      await seriousViolations(
        <AudioCoach
          bars={[0.2, 0.6, 0.9, 0.4]}
          activeIndex={2}
          isRecording
          isAnalyzing={false}
          hasRecording={false}
          isPlayingRecording={false}
          isPlayingReference={false}
          onToggleRecording={() => {}}
          onPlayRecording={() => {}}
          onPlayReference={() => {}}
        />,
      ),
    ).toEqual([]);
  });

  it("AudioCoach has no serious/critical violations while analyzing", async () => {
    expect(
      await seriousViolations(
        <AudioCoach
          bars={[]}
          activeIndex={0}
          isRecording={false}
          isAnalyzing
          hasRecording
          isPlayingRecording={false}
          isPlayingReference={false}
          onToggleRecording={() => {}}
          onPlayRecording={() => {}}
          onPlayReference={() => {}}
        />,
      ),
    ).toEqual([]);
  });

  it("IssuePanel has no serious/critical violations with issues", async () => {
    expect(
      await seriousViolations(
        <IssuePanel events={events} selectedWordId="1:1:1" onSelectWord={() => {}} />,
      ),
    ).toEqual([]);
  });

  it("IssuePanel has no serious/critical violations when empty", async () => {
    expect(
      await seriousViolations(<IssuePanel events={[]} selectedWordId="" onSelectWord={() => {}} />),
    ).toEqual([]);
  });

  it("MutashabihatPanel has no serious/critical violations with verses", async () => {
    expect(await seriousViolations(<MutashabihatPanel verses={similar} />)).toEqual([]);
  });

  it("MutashabihatPanel has no serious/critical violations when empty", async () => {
    expect(await seriousViolations(<MutashabihatPanel verses={[]} />)).toEqual([]);
  });

  it("TajweedPanel has no serious/critical violations with eligible findings", async () => {
    expect(await seriousViolations(<TajweedPanel findings={[eligibleFinding]} />)).toEqual([]);
  });

  // The withheld branch (ADR-0028): findings exist but none clears the learner gate, so the panel
  // says notes are awaiting a teacher. A learner sees this whenever the model is unsure.
  it("TajweedPanel has no serious/critical violations in the awaiting-review state", async () => {
    expect(
      await seriousViolations(
        <TajweedPanel findings={[{ ...eligibleFinding, reviewStatus: "ai-suggested", sources: [] }]} />,
      ),
    ).toEqual([]);
  });

  it("SurahPicker has no serious/critical violations", async () => {
    expect(
      await seriousViolations(
        <SurahPicker surahs={surahs} selected={surahs[0]} onSelect={() => {}} />,
      ),
    ).toEqual([]);
  });

  // Disabled is a real state: the picker renders disabled while the surah list is unavailable.
  it("SurahPicker has no serious/critical violations while disabled", async () => {
    expect(
      await seriousViolations(<SurahPicker surahs={[]} selected={surahs[0]} onSelect={() => {}} />),
    ).toEqual([]);
  });

  for (const saveState of ["idle", "saved", "nothing-recited", "failed"] as SaveState[]) {
    it(`CompletePanel has no serious/critical violations in save state ${saveState}`, async () => {
      expect(
        await seriousViolations(
          <CompletePanel
            onReset={() => {}}
            memorizationPlan={null}
            saveState={saveState}
          />,
        ),
      ).toEqual([]);
    });
  }

  // ProgressPanel is lazy-loaded behind a Suspense boundary in PracticeFlow and is the only
  // consumer of recharts. Rendered directly here so the chart's own markup is audited rather than
  // the fallback — a chart that never resolves is a chart that was never checked.
  it("ProgressPanel has no serious/critical violations", async () => {
    expect(
      await seriousViolations(
        <Suspense fallback={null}>
          <ProgressPanel
            accuracy={82}
            correctWords={41}
            mistakes={9}
            recitations={12}
            streak={4}
            mastery={0.62}
            weeklyProgress={weekly}
          />
        </Suspense>,
      ),
    ).toEqual([]);
  });
});
