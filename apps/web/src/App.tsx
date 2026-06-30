import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, Headphones, Mic, RotateCcw, Send, ShieldCheck, Sparkles } from "lucide-react";
import { AudioCoach } from "./components/AudioCoach";
import { IssuePanel } from "./components/IssuePanel";
import { TajweedPanel } from "./components/TajweedPanel";
import { MutashabihatPanel } from "./components/MutashabihatPanel";
import { PlatformCommand } from "./components/PlatformCommand";
import { ProgressPanel } from "./components/ProgressPanel";
import { QuranReader } from "./components/QuranReader";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { LoginScreen } from "./components/LoginScreen";
import { AuthProvider, useAuth } from "./lib/auth";
import { startAsr, splitTranscript, isAsrSupported, type AsrController } from "./lib/asr";
import { predictAlignment, predictTajweed, type AlignmentResult, type TajweedFinding } from "./lib/api";
import { fetchMemorizationPlan, type MemorizationPlan } from "./data/platform";
import { getQuranVerses, similarVerses, loadSurahVerses, loadWeeklyProgress, getWeeklyProgress, updateVersesWithAlignment, buildRecitationEvents, type QuranVerse, type RecitationEvent, type ProgressBar } from "./data/quran";
import type { SupportedLanguageCode } from "./types/platform";

type AppSection = "learner" | "teacher" | "scholar" | "model-ops" | "trust" | "admin" | "badges" | "teachers" | "settings";
type PracticeMode = "home" | "listen" | "guided-recite" | "memory-recite" | "correction" | "drill" | "complete";
type MicState = "idle" | "checking" | "ready" | "denied" | "unavailable";

const practiceSteps: Array<{ id: Exclude<PracticeMode, "home">; label: string; helper: string }> = [
  { id: "listen", label: "Listen", helper: "Hear the teacher-paced model once." },
  { id: "guided-recite", label: "Guided recite", helper: "Recite with the mushaf visible." },
  { id: "memory-recite", label: "Memory recite", helper: "Try without looking first." },
  { id: "correction", label: "Correction", helper: "Review only the words that need care." },
  { id: "drill", label: "Drill", helper: "Repeat the short phrase three times." },
  { id: "complete", label: "Complete", helper: "Save progress and next review." },
];

const waveformBars = Array.from({ length: 88 }, (_, index) => 28 + ((index * 17) % 54));

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}

function AppInner() {
  const { user, login, loading } = useAuth();

  // In smoke test mode, render the authenticated app directly
  // (bypasses login which requires the platform API to be running)
  const isSmokeMode = typeof window !== "undefined" &&
    (new URLSearchParams(window.location.search).get("smoke") === "layout" ||
     new URLSearchParams(window.location.search).get("smoke") === "mic");

  if (isSmokeMode) {
    return <AuthenticatedApp smokeBypass />;
  }

  if (!user) {
    // While the dev auth bypass establishes a session, show a loader instead of
    // flashing the login screen. In production (no bypass) loading is false here.
    if (loading) {
      return (
        <div className="login-screen">
          <div className="login-card">
            <p className="login-hint">Signing in…</p>
          </div>
        </div>
      );
    }
    return <LoginScreen />;
  }

  return <AuthenticatedApp />;
}

function AuthenticatedApp({ smokeBypass = false }: { smokeBypass?: boolean }) {
  const { user, logout } = useAuth();
  // In smoke bypass mode, use a mock user so the app renders without API
  const effectiveUser = smokeBypass
    ? { userId: "learner-1", tenantId: "hikmah-pilot-erbil", role: "learner", displayName: "Smoke Learner", token: "" }
    : user;
  const [activeLanguage, setActiveLanguage] = useState<SupportedLanguageCode>("ckb");
  const [activeTab, setActiveTab] = useState("recitation");
  const [activeSection, setActiveSection] = useState<AppSection>("learner");
  const [practiceMode, setPracticeMode] = useState<PracticeMode>(getInitialPracticeMode);
  const [selectedWordId, setSelectedWordId] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [micState, setMicState] = useState<MicState>("idle");
  const [smokeReport, setSmokeReport] = useState<LayoutSmokeReport | null>(null);
  const [alignmentResults, setAlignmentResults] = useState<AlignmentResult[]>([]);
  const [tajweedResults, setTajweedResults] = useState<TajweedFinding[]>([]);
  const [asrTranscript, setAsrTranscript] = useState("");
  const [quranVerses, setQuranVerses] = useState<QuranVerse[]>([]);
  const [recitationEvents, setRecitationEvents] = useState<RecitationEvent[]>([]);
  const [weeklyProgress, setWeeklyProgress] = useState<ProgressBar[]>([]);
  const [memorizationPlan, setMemorizationPlan] = useState<MemorizationPlan | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const asrRef = useState<AsrController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const activeStepIndex = Math.max(0, practiceSteps.findIndex((step) => step.id === practiceMode));
  const isLearnerHome = activeSection === "learner" && practiceMode === "home";
  const pageTitle = activeSection === "learner" ? (isLearnerHome ? "Learner Home" : "Practice") : "Internal Platform";

  useEffect(() => {
    void loadSurahVerses(1).then(setQuranVerses);
    if (effectiveUser) {
      void loadWeeklyProgress(effectiveUser.tenantId).then(setWeeklyProgress);
      void fetchMemorizationPlan(effectiveUser.tenantId, effectiveUser.userId).then(setMemorizationPlan);
    }
  }, [effectiveUser]);

  useEffect(() => {
    if (!isBrowserSmokeEnabled()) {
      return;
    }

    const updateSmokeReport = () => {
      const bodyText = document.body.innerText;
      setSmokeReport({
        clientWidth: document.documentElement.clientWidth,
        mode: practiceMode,
        scrollWidth: document.documentElement.scrollWidth,
        hasLearnerHome: bodyText.includes("Learner Home"),
        hasStartPractice: bodyText.includes("Start Practice"),
        hasPractice: bodyText.includes("Practice") && bodyText.includes("Surah Al-Fatihah"),
        hasHiddenInternalsCopy: bodyText.includes("Learner view keeps model and gateway details hidden"),
        hasCommandHero: bodyText.includes("Quran AI intelligence platform"),
        hasMicReady: bodyText.includes("Microphone is ready for guided recite."),
        hasMicDenied: bodyText.includes("Microphone denied. Practice still works in listen and teacher-review mode."),
        hasMicUnavailable: bodyText.includes("Microphone unavailable on this device."),
        micState,
      });
    };

    const frame = requestAnimationFrame(updateSmokeReport);
    window.addEventListener("resize", updateSmokeReport);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateSmokeReport);
    };
  }, [micState, practiceMode]);

  useEffect(() => {
    if (!isMicSmokeAutoCheckEnabled()) {
      return;
    }

    void checkMicPermission();
  }, []);

  async function checkMicPermission() {
    if (isMicSmokeUnavailableEnabled()) {
      setMicState("unavailable");
      setIsRecording(false);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setMicState("unavailable");
      return;
    }

    setMicState("checking");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicState("ready");
    } catch {
      setMicState("denied");
      setIsRecording(false);
    }
  }

  function startPractice() {
    setPracticeMode("listen");
    setSelectedWordId(recitationEvents[0]?.wordId ?? quranVerses[0]?.words[0]?.id ?? selectedWordId);
  }

  function advancePractice() {
    setPracticeMode((currentMode) => {
      if (currentMode === "home") {
        return "listen";
      }

      const currentIndex = practiceSteps.findIndex((step) => step.id === currentMode);
      const nextStep = practiceSteps[Math.min(currentIndex + 1, practiceSteps.length - 1)];
      return nextStep.id;
    });
    setIsRecording(false);
  }

  function resetPractice() {
    setPracticeMode("home");
    setIsRecording(false);
    setMicState("idle");
    setAlignmentResults([]);
    setTajweedResults([]);
    setAsrTranscript("");
    setRecitationEvents([]);
    setApiError(null);
    void loadSurahVerses(1).then(setQuranVerses);
  }

  async function runAlignmentAndTajweed(transcript: string) {
    if (!effectiveUser || !transcript.trim()) return;
    if (isLoading) return; // an alignment is already in flight — don't pile up requests
    setApiError(null);
    setIsLoading(true);
    try {
      const words = splitTranscript(transcript);
      const alignment = await predictAlignment({
        tenantId: effectiveUser.tenantId,
        sessionId: `practice-${Date.now()}`,
        surahNumber: 1,
        ayahStart: 1,
        ayahEnd: 7,
        recognizedText: words,
      });
      setAlignmentResults(alignment.alignments);
      updateVersesWithAlignment(alignment.alignments);
      setRecitationEvents(buildRecitationEvents(alignment.alignments));

      const tajweed = await predictTajweed({
        tenantId: effectiveUser.tenantId,
        sessionId: `practice-${Date.now()}`,
        surahNumber: 1,
        ayahStart: 1,
        ayahEnd: 7,
      });
      setTajweedResults(tajweed.findings);
    } catch (err) {
      const networkFailure = err instanceof TypeError; // e.g. "Failed to fetch"
      setApiError(
        networkFailure
          ? "Could not reach the alignment service (port 8090). Please try again."
          : err instanceof Error
            ? err.message
            : "ML service unreachable. Make sure the ML service is running on port 8090.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  function toggleAsrRecording() {
    if (!isAsrSupported()) {
      setMicState("unavailable");
      return;
    }
    if (isRecording) {
      asrRef[0]?.stop();
      setIsRecording(false);
      if (asrTranscript) {
        void runAlignmentAndTajweed(asrTranscript);
      }
      return;
    }
    stopPlayback();
    asrRef[0]?.stop();
    setIsRecording(true);
    setAsrTranscript("");
    const controller = startAsr({
      language: "ar-SA",
      onResult: (result) => {
        setAsrTranscript((prev) => prev + " " + result.transcript);
        if (result.isFinal) {
          void runAlignmentAndTajweed(result.transcript);
        }
      },
      onStatusChange: () => {},
      onError: () => {
        setIsRecording(false);
        setMicState("denied");
      },
    });
    asrRef[1](controller);
  }

  function stopPlayback() {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audioRef.current = null;
    }
    setIsPlaying(false);
  }

  // "Listen": play Surah Al-Fatihah (global ayahs 1–7) sequentially from the
  // Al Quran Cloud CDN (Mishary Al-Afasy reference recitation).
  function togglePlay() {
    // audioRef is always current (unlike the isPlaying state), so rapid double
    // clicks can't start overlapping playback.
    if (audioRef.current) {
      stopPlayback();
      return;
    }
    setApiError(null);
    setIsPlaying(true);
    const LAST_AYAH = 7;
    const playAyah = (ayah: number) => {
      if (ayah > LAST_AYAH) {
        stopPlayback();
        return;
      }
      const audio = new Audio(`https://cdn.islamic.network/quran/audio/128/ar.alafasy/${ayah}.mp3`);
      audioRef.current = audio;
      audio.onended = () => playAyah(ayah + 1);
      audio.onerror = () => {
        setApiError("Could not load recitation audio. Check your connection.");
        stopPlayback();
      };
      void audio.play().catch((err: unknown) => {
        // AbortError = play() was interrupted by a stop/pause (e.g. rapid toggling
        // or starting a recording). Benign — don't surface it as an error.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setApiError("Audio was blocked — tap play again to allow playback.");
        stopPlayback();
      });
    };
    playAyah(1);
  }

  return (
    <div className="app-shell">
      <Sidebar activeSection={activeSection} onSectionChange={(section) => setActiveSection(section as AppSection)} />
      <main className="workspace">
        <TopBar title={pageTitle} trustLabel={activeSection === "learner" ? "Teacher-reviewed" : "Scholar-gated"} />
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className={activeSection === "learner" ? "learner-stage" : "platform-stage"}
          initial={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        >
          {activeSection === "learner" ? (
            practiceMode === "home" ? (
              <LearnerHome onStartPractice={startPractice} onCheckMic={checkMicPermission} micState={micState} memorizationPlan={memorizationPlan} />
            ) : (
              <PracticeFlow
                activeStepIndex={activeStepIndex}
                isRecording={isRecording}
                micState={micState}
                mode={practiceMode}
                onAdvance={advancePractice}
                onCheckMic={checkMicPermission}
                onReset={resetPractice}
                onSelectMode={setPracticeMode}
                onSelectWord={setSelectedWordId}
                onSendToTeacher={() => setPracticeMode("drill")}
                onToggleRecording={toggleAsrRecording}
                isPlaying={isPlaying}
                onTogglePlay={togglePlay}
                selectedWordId={selectedWordId}
                quranVerses={quranVerses}
                recitationEvents={recitationEvents}
                alignmentResults={alignmentResults}
                tajweedResults={tajweedResults}
                weeklyProgress={weeklyProgress}
                memorizationPlan={memorizationPlan}
                apiError={apiError}
                isLoading={isLoading}
              />
            )
          ) : (
            <InternalSurface
              activeLanguage={activeLanguage}
              activeSection={activeSection}
              activeTab={activeTab}
              onLanguageChange={setActiveLanguage}
              onTabChange={setActiveTab}
            />
          )}
        </motion.div>
        {smokeReport ? <LayoutSmokeProbe report={smokeReport} /> : null}
      </main>
    </div>
  );
}

interface LayoutSmokeReport {
  clientWidth: number;
  mode: PracticeMode;
  scrollWidth: number;
  hasLearnerHome: boolean;
  hasStartPractice: boolean;
  hasPractice: boolean;
  hasHiddenInternalsCopy: boolean;
  hasCommandHero: boolean;
  hasMicReady: boolean;
  hasMicDenied: boolean;
  hasMicUnavailable: boolean;
  micState: MicState;
}

function getInitialPracticeMode(): PracticeMode {
  if (typeof window === "undefined") {
    return "home";
  }

  const params = new URLSearchParams(window.location.search);
  const smokeMode = params.get("smokeMode");
  if (smokeMode === "practice") {
    return "listen";
  }

  return "home";
}

function isLayoutSmokeEnabled(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("smoke") === "layout";
}

function isBrowserSmokeEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const smoke = new URLSearchParams(window.location.search).get("smoke");
  return smoke === "layout" || smoke === "mic";
}

function isMicSmokeAutoCheckEnabled(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("smokeAutoMic") === "1";
}

function isMicSmokeUnavailableEnabled(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("smokeMic") === "unavailable";
}

function LayoutSmokeProbe({ report }: { report: LayoutSmokeReport }) {
  return (
    <output
      data-client-width={report.clientWidth}
      data-has-command-hero={String(report.hasCommandHero)}
      data-has-hidden-internals-copy={String(report.hasHiddenInternalsCopy)}
      data-has-learner-home={String(report.hasLearnerHome)}
      data-has-mic-denied={String(report.hasMicDenied)}
      data-has-mic-ready={String(report.hasMicReady)}
      data-has-mic-unavailable={String(report.hasMicUnavailable)}
      data-has-practice={String(report.hasPractice)}
      data-has-start-practice={String(report.hasStartPractice)}
      data-mic-state={report.micState}
      data-mode={report.mode}
      data-scroll-width={report.scrollWidth}
      hidden
      id="browser-smoke-report"
    >
      browser-smoke-report
    </output>
  );
}

function LearnerHome({
  micState,
  onCheckMic,
  onStartPractice,
  memorizationPlan,
}: {
  micState: MicState;
  onCheckMic: () => void;
  onStartPractice: () => void;
  memorizationPlan: MemorizationPlan | null;
}) {
  return (
    <section className="learner-home" aria-label="Learner home">
      <div className="mission-hero">
        <div className="mission-copy">
          <p className="quiet-label">Today's mission</p>
          <h1>Strengthen Surah Al-Fatihah with a calm mastery loop.</h1>
          <p>
            Listen once, recite with guidance, try from memory, then repeat only the words that need attention.
          </p>
          <div className="mission-actions">
            <button className="primary-action start-practice-button" onClick={onStartPractice} type="button">
              <Mic size={18} />
              Start Practice
            </button>
            <button className="secondary-action" onClick={onCheckMic} type="button">
              Check microphone
            </button>
          </div>
          <MicNotice micState={micState} />
        </div>
        <div className="mission-card" aria-label="Mastery summary">
          <div className="mastery-ring" style={{ "--score": "281deg" } as React.CSSProperties}>
            <strong>78%</strong>
            <span>Mastery</span>
          </div>
          <dl>
            <div>
              <dt>Next review</dt>
              <dd>{memorizationPlan?.nextReviewAt ?? "Not scheduled"}</dd>
            </div>
            <div>
              <dt>Focus</dt>
              <dd>3 words</dd>
            </div>
            <div>
              <dt>Streak</dt>
              <dd>12 days</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="learner-summary-grid">
        <article className="summary-tile">
          <Headphones size={20} />
          <span>Practice mode</span>
          <strong>Listen first, then recite</strong>
        </article>
        <article className="summary-tile">
          <Clock3 size={20} />
          <span>Estimated time</span>
          <strong>8 minutes</strong>
        </article>
        <article className="summary-tile">
          <ShieldCheck size={20} />
          <span>Trust state</span>
          <strong>Teacher review available</strong>
        </article>
      </div>
    </section>
  );
}

function PracticeFlow({
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
  onToggleRecording,
  isPlaying,
  onTogglePlay,
  selectedWordId,
  quranVerses,
  recitationEvents,
  alignmentResults,
  tajweedResults,
  weeklyProgress,
  memorizationPlan,
  apiError,
  isLoading,
}: {
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
  onToggleRecording: () => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  selectedWordId: string;
  quranVerses: QuranVerse[];
  recitationEvents: RecitationEvent[];
  alignmentResults: AlignmentResult[];
  tajweedResults: TajweedFinding[];
  weeklyProgress: ProgressBar[];
  memorizationPlan: MemorizationPlan | null;
  apiError: string | null;
  isLoading: boolean;
}) {
  const activeWordId = quranVerses.flatMap((verse) => verse.words)[Math.min(activeStepIndex + 3, 12)]?.id ?? selectedWordId;
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
    <section className="practice-flow" aria-label="Learner practice">
      <header className="learner-practice-header">
        <div>
          <button className="text-link" onClick={onReset} type="button">
            <RotateCcw size={15} />
            Back to home
          </button>
          <h1>Surah Al-Fatihah</h1>
          <p>{selectedStep.helper}</p>
        </div>
        <button className="primary-action" disabled={isComplete} onClick={onAdvance} type="button">
          {isComplete ? <CheckCircle2 size={18} /> : <ArrowRight size={18} />}
          {isComplete ? "Practice complete" : "Next step"}
        </button>
      </header>

      <nav className="practice-stepper" aria-label="Practice steps">
        {practiceSteps.map((step, index) => (
          <button
            aria-current={mode === step.id ? "step" : undefined}
            className={index <= activeStepIndex ? "step-chip active" : "step-chip"}
            key={step.id}
            onClick={() => onSelectMode(step.id)}
            type="button"
          >
            <span>{index + 1}</span>
            {step.label}
          </button>
        ))}
      </nav>

      <div className="practice-main-grid">
        <div className="learner-reader-column">
          <ModeBanner mode={mode} micState={micState} onCheckMic={onCheckMic} onSendToTeacher={onSendToTeacher} />
          {isLoading && (
            <div className="state-banner calm" role="status">
              <Sparkles size={18} />
              Analyzing your recitation with Whisper ASR...
            </div>
          )}
          {apiError && (
            <div className="state-banner warning" role="alert">
              <AlertTriangle size={18} />
              {apiError}
            </div>
          )}
          <QuranReader activeWordId={activeWordId} onSelectWord={onSelectWord} selectedWordId={selectedWordId} verses={quranVerses} />
          <AudioCoach
            activeIndex={isRecording ? 58 : activeStepIndex * 12}
            bars={waveformBars}
            isRecording={isRecording}
            isPlaying={isPlaying}
            onToggleRecording={onToggleRecording}
            onTogglePlay={onTogglePlay}
          />
        </div>
        <aside className="learner-insight-column" aria-label="Practice guidance">
          {isComplete ? (
            <CompletePanel onReset={onReset} memorizationPlan={memorizationPlan} />
          ) : needsTeacherReview ? (
            <IssuePanel events={recitationEvents} onSelectWord={onSelectWord} selectedWordId={selectedWordId} />
          ) : (
            <ProgressPanel
              accuracy={accuracy}
              correctWords={correctWords}
              mistakes={mistakes}
              weeklyProgress={weeklyProgress}
            />
          )}
          {tajweedResults.length > 0 && <TajweedPanel findings={tajweedResults} />}
          <MutashabihatPanel verses={similarVerses.slice(0, 2)} />
        </aside>
      </div>
    </section>
  );
}

function ModeBanner({
  micState,
  mode,
  onCheckMic,
  onSendToTeacher,
}: {
  micState: MicState;
  mode: Exclude<PracticeMode, "home">;
  onCheckMic: () => void;
  onSendToTeacher: () => void;
}) {
  if (micState === "denied") {
    return (
      <div className="state-banner warning" role="status">
        <AlertTriangle size={18} />
        Microphone access is denied. You can still listen and practice, then ask a teacher to review in class.
        <button onClick={onCheckMic} type="button">Try again</button>
      </div>
    );
  }

  if (micState === "unavailable") {
    return (
      <div className="state-banner warning" role="status">
        <AlertTriangle size={18} />
        Microphone capture is unavailable on this device. Continue with listen mode or teacher review.
      </div>
    );
  }

  if (mode === "correction") {
    return (
      <div className="state-banner low-confidence" role="status">
        <Sparkles size={18} />
        Low-confidence guidance: three words need a gentle review before feedback is shown as final.
        <button onClick={onSendToTeacher} type="button">
          <Send size={15} />
          Send to teacher
        </button>
      </div>
    );
  }

  if (mode === "drill") {
    return (
      <div className="state-banner teacher" role="status">
        <ShieldCheck size={18} />
        Sent to teacher. For now, repeat the short phrase slowly three times.
      </div>
    );
  }

  return (
    <div className="state-banner calm" role="status">
      <Headphones size={18} />
      Learner view keeps model and gateway details hidden. Focus on the verse, pacing, and review.
    </div>
  );
}

function MicNotice({ micState }: { micState: MicState }) {
  const copyByState: Record<MicState, string> = {
    idle: "Microphone is optional until guided recite.",
    checking: "Checking microphone permission...",
    ready: "Microphone is ready for guided recite.",
    denied: "Microphone denied. Practice still works in listen and teacher-review mode.",
    unavailable: "Microphone unavailable on this device.",
  };

  return <p className={`mic-notice ${micState}`}>{copyByState[micState]}</p>;
}

function CompletePanel({ onReset, memorizationPlan }: { onReset: () => void; memorizationPlan: MemorizationPlan | null }) {
  return (
    <section className="panel complete-panel" aria-label="Complete state">
      <div className="complete-mark">
        <CheckCircle2 size={34} />
      </div>
      <h2>Practice complete</h2>
      <p>Progress saved. Your next review stays scheduled for {memorizationPlan?.nextReviewAt ?? "your next session"}.</p>
      <button className="secondary-action" onClick={onReset} type="button">Return home</button>
    </section>
  );
}

function InternalSurface({
  activeLanguage,
  activeSection,
  activeTab,
  onLanguageChange,
  onTabChange,
}: {
  activeLanguage: SupportedLanguageCode;
  activeSection: AppSection;
  activeTab: string;
  onLanguageChange: (language: SupportedLanguageCode) => void;
  onTabChange: (tab: string) => void;
}) {
  if (activeSection !== "admin") {
    return (
      <section className="internal-placeholder" aria-label="Internal surface">
        <h1>{internalTitle(activeSection)}</h1>
        <p>Internal review tools stay out of the learner path. Use Internal Command for the full platform console.</p>
        <button className="secondary-action" onClick={() => onTabChange(activeSection === "model-ops" ? "model-ops" : "review")} type="button">
          Open related command tab
        </button>
      </section>
    );
  }

  return (
    <PlatformCommand
      activeLanguage={activeLanguage}
      activeTab={activeTab}
      onLanguageChange={onLanguageChange}
      onTabChange={onTabChange}
    />
  );
}

function internalTitle(section: AppSection): string {
  switch (section) {
    case "teacher":
      return "Teacher Review";
    case "scholar":
      return "Scholar Review";
    case "model-ops":
      return "Model Ops";
    case "trust":
      return "Trust Ledger";
    case "badges":
      return "Learner Badges";
    case "teachers":
      return "Teachers";
    case "settings":
      return "Settings";
    case "admin":
      return "Internal Command";
    case "learner":
      return "Learner";
  }
}
