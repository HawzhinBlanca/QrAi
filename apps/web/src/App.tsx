import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Send } from "lucide-react";
import { InternalSurface } from "./components/InternalSurface";
import { LearnerHome } from "./components/LearnerHome";
import { PracticeFlow } from "./components/PracticeFlow";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { OfflineBanner } from "./components/OfflineBanner";
const LoginScreen = lazy(() => import("./components/LoginScreen").then(m => ({ default: m.LoginScreen })));
import { AuthProvider, useAuth } from "./lib/auth";
import { startAsr, splitTranscript, isAsrSupported, type AsrController } from "./lib/asr";
import { startLocalAudioRecording, startServerAsr, isServerAsrSupported, type ServerAsrController } from "./lib/serverAsr";
import { canRecordRecitation, canUseExternalSpeechFallback } from "./lib/consent";
import { startMicVisualizer, type MicVisualizerStop } from "./lib/micVisualizer";
import {
  predictAlignment,
  predictTajweed,
  createRecitationSession,
  persistSessionAlignments,
  fetchSurahList,
  type AlignmentResult,
  type TajweedFinding,
  type RecitationConsent,
  type SurahInfo,
} from "./lib/api";
import {
  DEFAULT_SURAH,
  practiceRange,
  globalAyahOffset,
  progressKey,
  surahLabel,
} from "./lib/surah";
import {
  fetchMemorizationPlan,
  fetchLearnerProgress,
  updateLearnerProgress,
  type MemorizationPlan,
  type LearnerProgress,
} from "./data/platform";
import { getQuranVerses, loadSurahVerses, loadWeeklyProgress, getWeeklyProgress, updateVersesWithAlignment, buildRecitationEvents, type QuranVerse, type RecitationEvent, type ProgressBar } from "./data/quran";
import type { AppSection, PracticeMode, MicState } from "./types/practice";
import { practiceSteps } from "./types/practice";
import type { SupportedLanguageCode } from "./types/platform";

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
    <ErrorBoundary>
      <AuthProvider>
        <AppInner />
      </AuthProvider>
    </ErrorBoundary>
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
    return <Suspense fallback={<div className="login-screen"><div className="login-card"><p className="login-hint">Loading…</p></div></div>}><LoginScreen /></Suspense>;
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
  const [surahList, setSurahList] = useState<SurahInfo[]>([]);
  const [selectedSurah, setSelectedSurah] = useState<SurahInfo>(DEFAULT_SURAH);
  // Privacy-preserving defaults; the learner opts in explicitly before practice.
  const [consent, setConsent] = useState<RecitationConsent>({
    recordingConsent: false,
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

  // Revoke the recorded-audio object URL on change/unmount so it never leaks.
  useEffect(() => {
    return () => {
      if (recordedAudioUrl) URL.revokeObjectURL(recordedAudioUrl);
    };
  }, [recordedAudioUrl]);

  const activeStepIndex = Math.max(0, practiceSteps.findIndex((step) => step.id === practiceMode));
  const isLearnerHome = activeSection === "learner" && practiceMode === "home";
  const pageTitle = activeSection === "learner" ? (isLearnerHome ? "Learner Home" : "Practice") : "Internal Platform";

  // Load the full surah list once so the learner can pick any of the 114 surahs. On
  // failure the picker stays on the default surah (still fully usable).
  useEffect(() => {
    void fetchSurahList()
      .then((list) => {
        if (list.length === 0) return;
        setSurahList(list);
        // Keep the selection's metadata in sync with the API record (same surah number).
        setSelectedSurah((current) => list.find((s) => s.surahNumber === current.surahNumber) ?? current);
      })
      .catch(() => {});
  }, []);

  // (Re)load the reader verses whenever the selected surah changes (and on first mount).
  useEffect(() => {
    void loadSurahVerses(selectedSurah.surahNumber).then(setQuranVerses).catch(() => {});
  }, [selectedSurah.surahNumber]);

  useEffect(() => {
    if (effectiveUser) {
      void loadWeeklyProgress(effectiveUser.tenantId, effectiveUser.userId, authToken).then(setWeeklyProgress).catch(() => {});
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
        hasPractice: bodyText.includes("Practice") && bodyText.includes("Back to home"),
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
      const range = practiceRange(selectedSurah);
      void createRecitationSession({
        tenantId: effectiveUser.tenantId,
        userId: effectiveUser.userId,
        authToken,
        learnerId: effectiveUser.userId,
        surahNumber: selectedSurah.surahNumber,
        ayahStart: range.ayahStart,
        ayahEnd: range.ayahEnd,
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
    const ayahRef = progressKey(selectedSurah.surahNumber, practiceRange(selectedSurah));
    try {
      await updateLearnerProgress(effectiveUser.tenantId, effectiveUser.userId, ayahRef, quality, authToken);
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
    void loadSurahVerses(selectedSurah.surahNumber).then(setQuranVerses).catch(() => {});
  }

  async function runAlignmentAndTajweed(transcript: string) {
    if (!effectiveUser || !transcript.trim()) return;
    if (isLoading) return; // an alignment is already in flight — don't pile up requests
    setApiError(null);
    setIsLoading(true);
    try {
      const words = splitTranscript(transcript);
      const activeSessionId = sessionId || `practice-${Date.now()}`;
      const range = practiceRange(selectedSurah);
      const alignment = await predictAlignment({
        tenantId: effectiveUser.tenantId,
        userId: effectiveUser.userId,
        authToken,
        sessionId: activeSessionId,
        surahNumber: selectedSurah.surahNumber,
        ayahStart: range.ayahStart,
        ayahEnd: range.ayahEnd,
        recognizedText: words,
      });
      setAlignmentResults(alignment.alignments);
      setQuranVerses((prev) => updateVersesWithAlignment(prev, alignment.alignments));
      setRecitationEvents(buildRecitationEvents(alignment.alignments));

      // Persist the real alignment to this session so it appears in the Command console
      // (only for a real persisted session — not the `practice-<ts>` offline fallback).
      // Best-effort: a failure here must not disrupt the learner's practice.
      if (sessionId && effectiveUser) {
        void persistSessionAlignments({
          tenantId: effectiveUser.tenantId,
          userId: effectiveUser.userId,
          authToken,
          sessionId,
          alignments: alignment.alignments,
        }).catch(() => {});
      }

      const tajweed = await predictTajweed({
        tenantId: effectiveUser.tenantId,
        userId: effectiveUser.userId,
        authToken,
        sessionId: activeSessionId,
        surahNumber: selectedSurah.surahNumber,
        ayahStart: range.ayahStart,
        ayahEnd: range.ayahEnd,
      });
      setTajweedResults(tajweed.findings);
    } catch (err) {
      const networkFailure = err instanceof TypeError; // e.g. "Failed to fetch"
      setApiError(
        networkFailure
          ? "Could not reach the platform API. Please try again."
          : err instanceof Error
            ? err.message
            : "ML analysis unavailable. Make sure the platform API and ML service are running.",
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

    // START — gate on explicit consent to record & analyze. The primary (first-party Quran ASR) path
    // still processes the audio and it may be stored per the retention consent, so recording must not
    // begin until the learner has affirmatively consented (previously this path recorded ungated).
    if (!canRecordRecitation(consent)) {
      setApiError(
        "Please consent to recording and analysis in the consent panel before recording your recitation.",
      );
      return;
    }
    stopPlayback();
    stopRecordingPlayback();
    setAsrTranscript("");
    setApiError(null);

    // Live mic waveform (real signal) for the whole recording, regardless of ASR path.
    void startMicVisualizer(setLiveBars)
      .then((stop) => {
        visualizerStopRef.current = stop;
      })
      .catch(() => {
        // visualizer is best-effort — never let it break recording
      });

    // The Quran ASR runs locally, so recitation feedback works by default. Browser
    // Web Speech is treated as external processing and is gated below.
    if (isServerAsrSupported()) {
      const controller = await startServerAsr({
        language: "ar",
        // Authenticate the transcription request: the browser posts audio to the platform-api ASR
        // proxy (which holds the ASR key), never to the ASR service directly.
        auth: effectiveUser
          ? { tenantId: effectiveUser.tenantId, userId: effectiveUser.userId, authToken }
          : undefined,
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

    // Fallback: browser Web Speech API (generic ar-SA recognition). Browsers may
    // process speech remotely, so this path requires explicit external-ASR consent.
    if (isAsrSupported()) {
      if (!canUseExternalSpeechFallback(consent)) {
        setApiError(
          "Local Quran ASR is unavailable. Browser speech recognition may use external processing; enable external ASR consent and guardian approval to use it.",
        );
      } else {
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

  // "Listen": play the selected surah's practice passage sequentially from the Al Quran
  // Cloud CDN (Mishary Al-Afasy reference recitation). The CDN uses the standard 6236
  // numbering, so we map the surah's local ayahs to global ayah numbers.
  function togglePlay() {
    // audioRef is always current (unlike the isPlaying state), so rapid double
    // clicks can't start overlapping playback.
    if (audioRef.current) {
      stopPlayback();
      return;
    }
    setApiError(null);
    setIsPlaying(true);
    const range = practiceRange(selectedSurah);
    const offset = globalAyahOffset(surahList, selectedSurah.surahNumber);
    const firstGlobal = offset + range.ayahStart;
    const lastGlobal = offset + range.ayahEnd;
    const playAyah = (ayah: number) => {
      if (ayah > lastGlobal) {
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
    playAyah(firstGlobal);
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
      <a href="#main-content" className="skip-link">Skip to content</a>
      <OfflineBanner />
      <Sidebar activeSection={activeSection} onSectionChange={(section) => setActiveSection(section as AppSection)} />
      <main className="workspace" id="main-content">
        <TopBar title={pageTitle} trustLabel={activeSection === "learner" ? "Teacher-reviewed" : "Scholar-gated"} />
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className={activeSection === "learner" ? "learner-stage" : "platform-stage"}
          initial={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        >
          {activeSection === "learner" ? (
            practiceMode === "home" ? (
              <LearnerHome onStartPractice={startPractice} onCheckMic={checkMicPermission} micState={micState} memorizationPlan={memorizationPlan} progress={progress} consent={consent} onConsentChange={setConsent} surahList={surahList} selectedSurah={selectedSurah} onSelectSurah={setSelectedSurah} />
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
                surahTitle={surahLabel(selectedSurah)}
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

// ConsentPanel has been extracted to src/components/ConsentPanel.tsx.


// LearnerHome and PracticeFlow have been extracted to their own files under src/components/.

// ModeBanner, MicNotice, CompletePanel, InternalSurface, and internalTitle have been
// extracted to their own files under src/components/ and src/types/practice.ts.
