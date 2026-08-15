// @vitest-environment jsdom
//
// P6.2 — axe automation for the four composed surfaces: the whole screens, not the panels.
//
// These fetch, so each audit stubs the network. Auditing them only in their empty/loading state
// would scan a spinner and call the product accessible, so every one is audited with real data
// loaded — a populated teacher queue, a populated console, a practice flow mid-session.
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { seriousViolations } from "../test-utils/axe";
import type { AlignmentResult, RecitationConsent, TajweedFinding } from "../lib/api";
import type { QuranVerse } from "../data/quran";
import { InternalSurface } from "./InternalSurface";
import { PlatformCommand } from "./PlatformCommand";
import { PracticeFlow, type PracticeFlowProps } from "./PracticeFlow";
import { TeacherSurface } from "./TeacherSurface";

const SESSION = "sess-audit";

const session = {
  id: SESSION,
  learnerId: "learner-A",
  reviewStatus: "teacher-review-required",
  startedAt: "2026-08-11T10:00:00Z",
  quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Al-Fatihah 1:1-7" },
  accuracyScore: 0.9,
};

const findingSummary = {
  id: "tf-audit",
  sessionId: SESSION,
  wordId: "1:1:2",
  rule: "Ghunnah",
  severity: "warning",
  confidence: 0.85,
  explanation: "Hold the nasalization.",
  reviewStatus: "teacher-review-required",
  sources: [],
  audioStatus: "available",
};

/** Answer every platform read with something shaped like the contract, so no surface renders empty. */
function stubPlatform() {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
    if (url.includes("/alignments")) return json([]);
    if (url.includes("/v1/tajweed-findings")) return json([findingSummary]);
    if (url.includes("/v1/recitation-sessions")) return json([session]);
    return json([]);
  });
}

beforeEach(() => {
  stubPlatform();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CONSENT: RecitationConsent = {
  recordingConsent: true,
  audioRetention: "discard",
  anonymizedLearning: false,
  externalAsrProcessing: false,
  guardianApproved: true,
  consentVersion: "pilot-v1",
};

const verses: QuranVerse[] = [
  {
    id: "1:1",
    verseNumber: 1,
    words: [
      { id: "1:1:1", text: "بِسْمِ", status: "good" },
      { id: "1:1:2", text: "ٱللَّهِ", status: "mistake" },
    ],
  },
];

const alignments: AlignmentResult[] = [
  { wordId: "1:1:1", canonicalText: "بِسْمِ", heardText: "بِسْمِ", confidence: 0.95, status: "matched" },
  { wordId: "1:1:2", canonicalText: "ٱللَّهِ", heardText: "ٱللَّه", confidence: 0.4, status: "misread" },
];

const tajweed: TajweedFinding[] = [
  {
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
},
];

function practiceProps(overrides: Partial<PracticeFlowProps> = {}): PracticeFlowProps {
  return {
    activeStepIndex: 2,
    isRecording: false,
    micState: "ready",
    mode: "guided-recite",
    onAdvance: () => {},
    onCheckMic: () => {},
    onReset: () => {},
    onSelectMode: () => {},
    onSelectWord: () => {},
    onSendToTeacher: () => {},
    teacherSendState: "idle",
    saveState: "idle",
    needsConsent: false,
    consent: CONSENT,
    onConsentChange: () => {},
    onToggleRecording: () => {},
    isPlaying: false,
    onTogglePlay: () => {},
    hasRecording: true,
    isPlayingRecording: false,
    onPlayRecording: () => {},
    liveBars: [0.3, 0.7],
    selectedWordId: "1:1:2",
    surahTitle: "Al-Fatihah",
    quranVerses: verses,
    playingAyah: null,
    recitingWordId: null,
    recitationAttribution: null,
    translationByAyah: new Map(),
    translationAttribution: null,
    showTranslation: false,
    onToggleTranslation: () => {},
    isLoadingVerses: false,
    recitationEvents: [],
    alignmentResults: alignments,
    tajweedResults: tajweed,
    weeklyProgress: [],
    memorizationPlan: null,
    progress: null,
    apiError: null,
    isLoading: false,
    ...overrides,
  };
}

describe("composed surface accessibility (axe automation)", () => {
  // Every practice mode, because PracticeFlow renders a different panel set per step. Auditing one
  // step would leave the rest of the learner's session unscanned.
  for (const mode of ["guided-recite", "listen", "correction", "drill", "complete"] as const) {
    it(`PracticeFlow has no serious/critical violations in mode ${mode}`, async () => {
      expect(
        await seriousViolations(
          <Suspense fallback={null}>
            <PracticeFlow {...practiceProps({ mode })} />
          </Suspense>,
        ),
      ).toEqual([]);
    });
  }

  // The consent gate: the first thing a new learner sees, and a hard block on recording.
  it("PracticeFlow has no serious/critical violations at the consent gate", async () => {
    expect(
      await seriousViolations(
        <Suspense fallback={null}>
          <PracticeFlow {...practiceProps({ needsConsent: true })} />
        </Suspense>,
      ),
    ).toEqual([]);
  });

  // The error state. A surface that is accessible only when the backend is healthy is accessible
  // only when it does not matter.
  it("PracticeFlow has no serious/critical violations with an API error", async () => {
    expect(
      await seriousViolations(
        <Suspense fallback={null}>
          <PracticeFlow {...practiceProps({ apiError: "The service is unavailable." })} />
        </Suspense>,
      ),
    ).toEqual([]);
  });

  it("TeacherSurface has no serious/critical violations with a loaded queue", async () => {
    expect(
      await seriousViolations(<TeacherSurface tenantId="hikmah-pilot-erbil" />),
    ).toEqual([]);
  });

  // InternalSurface only renders its console for the admin section; every other section is a title
  // shell. Both branches are audited.
  it("InternalSurface has no serious/critical violations in the admin section", async () => {
    expect(
      await seriousViolations(
        <Suspense fallback={null}>
          <InternalSurface
            tenantId="hikmah-pilot-erbil"
            activeLanguage="en"
            activeSection="admin"
            activeTab="overview"
            onLanguageChange={() => {}}
            onTabChange={() => {}}
            onOpenCommand={() => {}}
            onSectionChange={() => {}}
          />
        </Suspense>,
      ),
    ).toEqual([]);
  });

  it("InternalSurface has no serious/critical violations in a non-admin section", async () => {
    expect(
      await seriousViolations(
        <Suspense fallback={null}>
          <InternalSurface
            tenantId="hikmah-pilot-erbil"
            activeLanguage="en"
            activeSection="scholar"
            activeTab="overview"
            onLanguageChange={() => {}}
            onTabChange={() => {}}
            onOpenCommand={() => {}}
            onSectionChange={() => {}}
          />
        </Suspense>,
      ),
    ).toEqual([]);
  });

  it("PlatformCommand has no serious/critical violations", async () => {
    expect(
      await seriousViolations(
        <PlatformCommand
          tenantId="hikmah-pilot-erbil"
          activeLanguage="en"
          activeTab="overview"
          onLanguageChange={() => {}}
          onTabChange={() => {}}
          activeSection="admin"
          onSectionChange={() => {}}
        />,
      ),
    ).toEqual([]);
  });
});
