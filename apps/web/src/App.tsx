import { useEffect, useMemo, useRef, useState } from "react";
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
import { startLocalAudioRecording, startServerAsr, isServerAsrSupported, type ServerAsrController } from "./lib/serverAsr";
import { startMicVisualizer, type MicVisualizerStop } from "./lib/micVisualizer";
import {
  predictAlignment,
  predictTajweed,
  createRecitationSession,
  type AlignmentResult,
  type TajweedFinding,
  type RecitationConsent,
} from "./lib/api";
import {
  fetchMemorizationPlan,
  fetchLearnerProgress,
  updateLearnerProgress,
  type MemorizationPlan,
  type LearnerProgress,
} from "./data/platform";
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

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN IS INTENTIONALLY DISABLED until the product owner enables it for production.
// Per explicit instruction: NO login screen for general users until told otherwise.
// The whole app renders directly with a default learner — no `?smoke` param needed.
//
// To RE-ENABLE login (production only, when the owner says so): set the build-time env
// `VITE_REQUIRE_LOGIN=1` (see apps/web/README, docs/DECISIONS.md, AGENTS.md).
// Do NOT flip this without the owner's go-ahead.
// ─────────────────────────────────────────────────────────────────────────────
const LOGIN_ENABLED = import.meta.env.VITE_REQUIRE_LOGIN === "1";

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}

function AppInner() {
  const { user, loading } = useAuth();

  // Login disabled (default): render the app directly with a default learner. No login
  // screen, no query param. Re-enable only via VITE_REQUIRE_LOGIN=1.
  if (!LOGIN_ENABLED) {
    return <AuthenticatedApp bypassLogin />;
  }

  if (!user) {
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

function AuthenticatedApp({ bypassLogin = false }: { bypassLogin?: boolean }) {
  const { user, logout } = useAuth();
  // Login-disabled mode (default): use a default learner so the app runs without a
  // login step. Swapped for the real authenticated user once VITE_REQUIRE_LOGIN=1.
  // Memoized so the reference is stable — it's a dependency of the data-loading effect,
  // and a fresh object each render would loop it.
  const effectiveUser = useMemo(
    () =>
      bypassLogin
        ? { userId: "learner-1", tenantId: "hikmah-pilot-erbil", role: "learner", displayName: "Learner", token: "" }
        : user,
    [bypassLogin, user],
  );
  const authToken = effectiveUser?.token || undefined;
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
  const [progress, setProgress] = useState<LearnerProgress | null>(null);
  const [sessionId, setSessionId] = useState<string>("");
  // Privacy-preserving defaults; the learner opts in explicitly before practice.
  const [consent, setConsent] = useState<RecitationConsent>({
    audioRetention: "discard",
    anonymizedLearning: false,
    externalAsrProcessing: false,
    guardianApproved: false,
    consentVersion: "pilot-consent-v1",
  });
  const [apiError, setApiError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const asrRef = useRef<AsrController | null>(null);
  const serverAsrRef = useRef<ServerAsrController | null>(null);
  const visualizerStopRef = useRef<MicVisualizerStop | null>(null);
  const [liveBars, setLiveBars] = useState<number[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // The learner's own recorded recitation, kept for playback.
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string>("");
  const recordingAudioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlayingRecording, setIsPlayingRecording] = useState(false);

  function setRecordedAudio(blob: Blob) {
    setRecordedAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(blob);
    });
  }

  const activeStepIndex = Math.max(0, practiceSteps.findIndex((step) => step.id === practiceMode));
  const isLearnerHome = activeSection === "learner" && practiceMode === "home";
  const pageTitle = activeSection === "learner" ? (isLearnerHome ? "Learner Home" : "Practice") : "Internal Platform";

  useEffect(() => {
    void loadSurahVerses(1).then(setQuranVerses).catch(() => {});
    if (effectiveUser) {
      void loadWeeklyProgress(effectiveUser.tenantId).then(setWeeklyProgress).catch(() => {});
      void fetchMemorizationPlan(effectiveUser.tenantId, effectiveUser.userId, authToken)
        .then(setMemorizationPlan)
        .catch(() => {});
      void fetchLearnerProgress(effectiveUser.tenantId, effectiveUser.userId, authToken)
        .then(setProgress)
        .catch(() => {});
    }
  }, [authToken, effectiveUser]);

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
    // Create a real, consent-bound recitation session; alignment/tajweed reference its id.
    if (effectiveUser) {
      void createRecitationSession({
        tenantId: effectiveUser.tenantId,
        userId: effectiveUser.userId,
        authToken,
        learnerId: effectiveUser.userId,
        surahNumber: 1,
        ayahStart: 1,
        ayahEnd: 7,
        language: activeLanguage,
        consent,
      })
        .then((session) => setSessionId(session.id))
        .catch(() => setSessionId(""));
    }
  }

  function advancePractice() {
    // Detect the transition into the final "complete" step so we can persist progress.
    const fromIndex = practiceSteps.findIndex((step) => step.id === practiceMode);
    const enteringComplete =
      practiceMode !== "home" &&
      practiceSteps[Math.min(fromIndex + 1, practiceSteps.length - 1)].id === "complete";

    setPracticeMode((currentMode) => {
      if (currentMode === "home") {
        return "listen";
      }

      const currentIndex = practiceSteps.findIndex((step) => step.id === currentMode);
      const nextStep = practiceSteps[Math.min(currentIndex + 1, practiceSteps.length - 1)];
      return nextStep.id;
    });
    setIsRecording(false);

    if (enteringComplete) {
      void saveProgressFromPractice();
    }
  }

  /**
   * On practice completion, persist a real SM-2 review (mastery/streak accumulate) from
   * the actual alignment accuracy. Skipped when the learner didn't recite, so we never
   * record a fabricated (quality-0) review.
   */
  async function saveProgressFromPractice() {
    if (!effectiveUser || alignmentResults.length === 0) return;
    const correct = alignmentResults.filter((a) => a.status === "matched").length;
    const scored = alignmentResults.filter(
      (a) =>
        a.status === "matched" ||
        a.status === "misread" ||
        a.status === "missed" ||
        a.status === "needs-review" ||
        a.status === "extra",
    ).length;
    const accuracy = scored > 0 ? correct / scored : 0;
    const quality = Math.round(accuracy * 5); // SM-2 quality 0-5
    try {
      await updateLearnerProgress(effectiveUser.tenantId, effectiveUser.userId, "1:1-7", quality, authToken);
      const fresh = await fetchLearnerProgress(effectiveUser.tenantId, effectiveUser.userId, authToken);
      setProgress(fresh);
    } catch {
      // Keep the prior progress if the update fails; don't block the completion UI.
    }
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
    stopPlayback();
    stopRecordingPlayback();
    setRecordedAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    void loadSurahVerses(1).then(setQuranVerses).catch(() => {});
  }

  async function runAlignmentAndTajweed(transcript: string) {
    if (!effectiveUser || !transcript.trim()) return;
    if (isLoading) return; // an alignment is already in flight — don't pile up requests
    setApiError(null);
    setIsLoading(true);
    try {
      const words = splitTranscript(transcript);
      const activeSessionId = sessionId || `practice-${Date.now()}`;
      const alignment = await predictAlignment({
        tenantId: effectiveUser.tenantId,
        sessionId: activeSessionId,
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
        sessionId: activeSessionId,
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

  async function toggleAsrRecording() {
    // STOP
    if (isRecording) {
      setIsRecording(false);
      // Stop the live mic waveform — must NEVER throw and abort saving the recording.
      try {
        visualizerStopRef.current?.();
      } catch {
        // ignore visualizer cleanup errors
      }
      visualizerStopRef.current = null;
      setLiveBars([]);
      // Real trained-Quran-model path: transcribe the captured audio on the ASR service.
      if (serverAsrRef.current) {
        const controller = serverAsrRef.current;
        serverAsrRef.current = null;
        setIsLoading(true);
        try {
          const result = await controller.stopAndTranscribe();
          // Keep the recording playable regardless of what the ASR service does.
          setRecordedAudio(result.audioBlob);
          setAsrTranscript(result.transcript);
          if (result.error === "external-asr-consent-required") {
            setApiError("Recording saved in this browser. Enable ASR processing consent to run automatic analysis.");
          } else if (result.error) {
            setApiError("Saved your recitation — you can play it back. Analysis is offline right now.");
          } else if (result.transcript.trim()) {
            await runAlignmentAndTajweed(result.transcript);
          } else {
            setApiError("We couldn't hear clear speech. Your recording is saved — try reciting a little louder.");
          }
        } catch {
          setApiError("Could not process the recording. Please try again.");
        } finally {
          setIsLoading(false);
        }
        return;
      }
      // Web Speech fallback path (streaming transcript already accumulated).
      asrRef.current?.stop();
      if (asrTranscript) {
        void runAlignmentAndTajweed(asrTranscript);
      }
      return;
    }

    // START
    stopPlayback();
    stopRecordingPlayback();
    setAsrTranscript("");
    setApiError(null);

    // Live mic waveform (real signal) for the whole recording, regardless of ASR path.
    void startMicVisualizer(setLiveBars).then((stop) => {
      visualizerStopRef.current = stop;
    });

    // The Quran ASR runs LOCALLY on this machine, so recitation feedback works by default.
    // consent.externalAsrProcessing is recorded on the session and reserved for any future
    // TRUE third-party / cloud processing — it does not gate the on-device model.
    if (isServerAsrSupported()) {
      const controller = await startServerAsr({
        language: "ar",
        onStatusChange: () => {},
        onError: (message) => {
          setIsRecording(false);
          setMicState("denied");
          setApiError(message);
        },
      });
      if (controller) {
        serverAsrRef.current = controller;
        setIsRecording(true);
        return;
      }
      // Could not start server ASR — fall through.
    }

    // Fallback: browser Web Speech API (generic ar-SA recognition) for feedback.
    if (isAsrSupported()) {
      setIsRecording(true);
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
      asrRef.current = controller;
      return;
    }

    // Last resort: record locally so the learner can at least play their recitation back.
    const localController = await startLocalAudioRecording({
      onStatusChange: () => {},
      onError: (message) => {
        setIsRecording(false);
        setMicState("denied");
        setApiError(message);
      },
    });
    if (localController) {
      serverAsrRef.current = localController;
      setIsRecording(true);
      return;
    }
    setMicState("unavailable");
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

  function stopRecordingPlayback() {
    const audio = recordingAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      recordingAudioRef.current = null;
    }
    setIsPlayingRecording(false);
  }

  // Play back the learner's OWN recording (local blob — always works, no network).
  function playRecording() {
    if (!recordedAudioUrl) return;
    if (recordingAudioRef.current) {
      stopRecordingPlayback();
      return;
    }
    stopPlayback();
    setApiError(null);
    const audio = new Audio(recordedAudioUrl);
    recordingAudioRef.current = audio;
    setIsPlayingRecording(true);
    audio.onended = () => stopRecordingPlayback();
    audio.onerror = () => {
      setApiError("Couldn't play that recording.");
      stopRecordingPlayback();
    };
    void audio.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      stopRecordingPlayback();
    });
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
              <LearnerHome onStartPractice={startPractice} onCheckMic={checkMicPermission} micState={micState} memorizationPlan={memorizationPlan} progress={progress} consent={consent} onConsentChange={setConsent} />
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
                hasRecording={!!recordedAudioUrl}
                isPlayingRecording={isPlayingRecording}
                onPlayRecording={playRecording}
                liveBars={liveBars}
                selectedWordId={selectedWordId}
                quranVerses={quranVerses}
                recitationEvents={recitationEvents}
                alignmentResults={alignmentResults}
                tajweedResults={tajweedResults}
                weeklyProgress={weeklyProgress}
                memorizationPlan={memorizationPlan}
                progress={progress}
                apiError={apiError}
                isLoading={isLoading}
              />
            )
          ) : (
            <InternalSurface
              tenantId={effectiveUser?.tenantId ?? "hikmah-pilot-erbil"}
              authToken={authToken}
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

function ConsentPanel({
  consent,
  onConsentChange,
}: {
  consent: RecitationConsent;
  onConsentChange: (consent: RecitationConsent) => void;
}) {
  return (
    <div className="consent-panel" aria-label="Recording consent">
      <p className="quiet-label">Recording consent</p>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.audioRetention === "teacher-review"}
          onChange={(event) =>
            onConsentChange({
              ...consent,
              audioRetention: event.target.checked ? "teacher-review" : "discard",
            })
          }
        />
        <span>Keep my recitation for teacher review (otherwise it is discarded after analysis).</span>
      </label>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.anonymizedLearning}
          onChange={(event) => onConsentChange({ ...consent, anonymizedLearning: event.target.checked })}
        />
        <span>Help improve the model with anonymized data.</span>
      </label>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={consent.guardianApproved}
          onChange={(event) => onConsentChange({ ...consent, guardianApproved: event.target.checked })}
        />
        <span>A parent/guardian approves this (required for learners under 13).</span>
      </label>
    </div>
  );
}

function LearnerHome({
  micState,
  onCheckMic,
  onStartPractice,
  memorizationPlan,
  progress,
  consent,
  onConsentChange,
}: {
  micState: MicState;
  onCheckMic: () => void;
  onStartPractice: () => void;
  memorizationPlan: MemorizationPlan | null;
  progress: LearnerProgress | null;
  consent: RecitationConsent;
  onConsentChange: (consent: RecitationConsent) => void;
}) {
  const masteryPct = Math.round((progress?.mastery ?? 0) * 100);
  return (
    <section className="learner-home" aria-label="Learner home">
      <div className="mission-hero">
        <div className="mission-copy">
          <p className="quiet-label">Today's mission</p>
          <h1>Strengthen Surah Al-Fatihah with a calm mastery loop.</h1>
          <p>
            Listen once, recite with guidance, try from memory, then repeat only the words that need attention.
          </p>
          <ConsentPanel consent={consent} onConsentChange={onConsentChange} />
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
          <div className="mastery-ring" style={{ "--score": `${masteryPct * 3.6}deg` } as React.CSSProperties}>
            <strong>{masteryPct}%</strong>
            <span>Mastery</span>
          </div>
          <dl>
            <div>
              <dt>Next review</dt>
              <dd>{memorizationPlan?.nextReviewAt ?? "Not scheduled"}</dd>
            </div>
            <div>
              <dt>Due today</dt>
              <dd>{memorizationPlan?.intervals?.[0]?.dueCount ?? 0}</dd>
            </div>
            <div>
              <dt>Streak</dt>
              <dd>{progress?.streak ?? 0} days</dd>
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
  hasRecording,
  isPlayingRecording,
  onPlayRecording,
  liveBars,
  selectedWordId,
  quranVerses,
  recitationEvents,
  alignmentResults,
  tajweedResults,
  weeklyProgress,
  memorizationPlan,
  progress,
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
  hasRecording: boolean;
  isPlayingRecording: boolean;
  onPlayRecording: () => void;
  liveBars: number[];
  selectedWordId: string;
  quranVerses: QuranVerse[];
  recitationEvents: RecitationEvent[];
  alignmentResults: AlignmentResult[];
  tajweedResults: TajweedFinding[];
  weeklyProgress: ProgressBar[];
  memorizationPlan: MemorizationPlan | null;
  progress: LearnerProgress | null;
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
              recitations={progress?.totalSessions ?? 0}
              streak={progress?.streak ?? 0}
              mastery={progress?.mastery ?? 0}
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
  tenantId,
  authToken,
  activeLanguage,
  activeSection,
  activeTab,
  onLanguageChange,
  onTabChange,
}: {
  tenantId: string;
  authToken?: string;
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
      tenantId={tenantId}
      authToken={authToken}
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
