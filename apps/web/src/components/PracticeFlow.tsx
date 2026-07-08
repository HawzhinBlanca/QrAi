import { lazy, Suspense } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, RotateCcw, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AudioCoach } from "./AudioCoach";
import { CompletePanel } from "./CompletePanel";
import { IssuePanel } from "./IssuePanel";
import { ModeBanner, type TeacherSendState } from "./ModeBanner";
import { MutashabihatPanel } from "./MutashabihatPanel";
import { QuranReader } from "./QuranReader";
import { TajweedPanel } from "./TajweedPanel";
import type { MicState, PracticeMode } from "../types/practice";
import { practiceSteps, waveformBars } from "../types/practice";
import type { AlignmentResult, TajweedFinding } from "../lib/api";
import type { MemorizationPlan, LearnerProgress } from "../data/platform";
import type { QuranVerse, RecitationEvent, ProgressBar } from "../data/quran";
import { similarVerses } from "../data/quran";

// Lazy: ProgressPanel is the only consumer of `recharts` (a substantial charting library) in the
// core learner practice flow, which is eagerly bundled (unlike LoginScreen/PlatformCommand, which
// already lazy-load). Splitting it into its own chunk keeps recharts out of the initial payload
// every learner pays for, even though ProgressPanel itself renders on most practice sessions.
const ProgressPanel = lazy(() => import("./ProgressPanel").then((m) => ({ default: m.ProgressPanel })));

export interface PracticeFlowProps {
  activeStepIndex: number;
  isRecording: boolean;
  micState: MicState;
  mode: Exclude<PracticeMode, "home">;
  onAdvance: () => void;
  onCheckMic: () => void;
  onReset: () => void;
  onSelectMode: (mode: PracticeMode) => void;
  onSelectWord: (wordId: string) => void;
  onSendToTeacher: () => void;
  teacherSendState: TeacherSendState;
  onToggleRecording: () => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  hasRecording: boolean;
  isPlayingRecording: boolean;
  onPlayRecording: () => void;
  liveBars: number[];
  selectedWordId: string;
  surahTitle: string;
  quranVerses: QuranVerse[];
  recitationEvents: RecitationEvent[];
  alignmentResults: AlignmentResult[];
  tajweedResults: TajweedFinding[];
  weeklyProgress: ProgressBar[];
  memorizationPlan: MemorizationPlan | null;
  progress: LearnerProgress | null;
  apiError: string | null;
  isLoading: boolean;
}

export function PracticeFlow({
  activeStepIndex,
  isRecording,
  micState,
  mode,
  onAdvance,
  onCheckMic,
  onReset,
  onSelectMode,
  onSelectWord,
  onSendToTeacher,
  teacherSendState,
  onToggleRecording,
  isPlaying,
  onTogglePlay,
  hasRecording,
  isPlayingRecording,
  onPlayRecording,
  liveBars,
  selectedWordId,
  surahTitle,
  quranVerses,
  recitationEvents,
  alignmentResults,
  tajweedResults,
  weeklyProgress,
  memorizationPlan,
  progress,
  apiError,
  isLoading,
}: PracticeFlowProps) {
  const { t } = useTranslation();
  const selectedStep = practiceSteps.find((step) => step.id === mode) ?? practiceSteps[0];
  const isComplete = mode === "complete";
  const needsTeacherReview = mode === "correction" || mode === "drill";

  // Real accuracy from live alignment results (replaces the old hardcoded 78/32/3).
  const correctWords = alignmentResults.filter((a) => a.status === "matched").length;
  const mistakes = alignmentResults.filter(
    (a) =>
      a.status === "misread" ||
      a.status === "missed" ||
      a.status === "needs-review" ||
      a.status === "extra",
  ).length;
  const scoredWords = correctWords + mistakes;
  const accuracy = scoredWords > 0 ? Math.round((correctWords / scoredWords) * 100) : 0;

  return (
    <section className="practice-flow" aria-label={t("practiceFlow.ariaLabel")}>
      <header className="learner-practice-header">
        <div>
          <button className="text-link" onClick={onReset} type="button">
            <RotateCcw size={15} />
            {t("practiceFlow.backToHome")}
          </button>
          <h1>{surahTitle}</h1>
          <p>{t(selectedStep.helperKey)}</p>
        </div>
        <button className="primary-action" disabled={isComplete} onClick={onAdvance} type="button">
          {isComplete ? <CheckCircle2 size={18} /> : <ArrowRight size={18} />}
          {isComplete ? t("practiceFlow.practiceComplete") : t("practiceFlow.nextStep")}
        </button>
      </header>

      <nav className="practice-stepper" aria-label={t("practiceFlow.stepperAriaLabel")}>
        {practiceSteps.map((step, index) => (
          <button
            aria-current={mode === step.id ? "step" : undefined}
            className={index <= activeStepIndex ? "step-chip active" : "step-chip"}
            key={step.id}
            onClick={() => onSelectMode(step.id)}
            type="button"
          >
            <span>{index + 1}</span>
            {t(step.labelKey)}
          </button>
        ))}
      </nav>

      <div className="practice-main-grid">
        <div className="learner-reader-column">
          <ModeBanner mode={mode} micState={micState} mistakes={mistakes} teacherSendState={teacherSendState} onCheckMic={onCheckMic} onSendToTeacher={onSendToTeacher} />
          {isLoading && (
            <div className="state-banner calm" role="status">
              <Sparkles size={18} />
              {t("practiceFlow.analyzing")}
            </div>
          )}
          {apiError && (
            <div className="state-banner warning" role="alert">
              <AlertTriangle size={18} />
              {apiError}
            </div>
          )}
          <QuranReader activeWordId={selectedWordId} onSelectWord={onSelectWord} selectedWordId={selectedWordId} verses={quranVerses} />
          <AudioCoach
            activeIndex={isRecording ? liveBars.length - 1 : activeStepIndex * 12}
            bars={isRecording && liveBars.length > 0 ? liveBars : waveformBars}
            isRecording={isRecording}
            isAnalyzing={isLoading}
            hasRecording={hasRecording}
            isPlayingRecording={isPlayingRecording}
            isPlayingReference={isPlaying}
            onToggleRecording={onToggleRecording}
            onPlayRecording={onPlayRecording}
            onPlayReference={onTogglePlay}
          />
        </div>
        <aside className="learner-insight-column" aria-label={t("practiceFlow.guidanceAriaLabel")}>
          {isComplete ? (
            <CompletePanel onReset={onReset} memorizationPlan={memorizationPlan} />
          ) : needsTeacherReview ? (
            <IssuePanel events={recitationEvents} onSelectWord={onSelectWord} selectedWordId={selectedWordId} />
          ) : (
            <Suspense fallback={<div className="panel progress-panel" aria-label={t("practiceFlow.progressAriaLabel")} aria-busy="true" />}>
              <ProgressPanel
                accuracy={accuracy}
                correctWords={correctWords}
                mistakes={mistakes}
                recitations={progress?.totalSessions ?? 0}
                streak={progress?.streak ?? 0}
                mastery={progress?.mastery ?? 0}
                weeklyProgress={weeklyProgress}
              />
            </Suspense>
          )}
          {tajweedResults.length > 0 && <TajweedPanel findings={tajweedResults} />}
          <MutashabihatPanel verses={similarVerses.slice(0, 2)} />
        </aside>
      </div>
    </section>
  );
}
