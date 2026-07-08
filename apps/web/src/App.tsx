import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Send } from "lucide-react";
import { useTranslation } from "react-i18next";
// App.tsx is the common entry point for BOTH main.tsx (real app) and App.smoke.test.tsx (which
// renders <App /> directly via createRoot, bypassing main.tsx entirely) -- importing i18n's
// init here, not just in main.tsx, is what makes useTranslation() work in both.
import i18n from "./i18n";
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
  requestTeacherReview,
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
  supportedLanguages,
  type MemorizationPlan,
  type LearnerProgress,
} from "./data/platform";
import { getQuranVerses, getQuranLoadError, loadSurahVerses, loadWeeklyProgress, updateVersesWithAlignment, buildRecitationEvents, type QuranVerse, type RecitationEvent, type ProgressBar } from "./data/quran";
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
  const { t } = useTranslation();
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
  const [activeSection, setActiveSection] = useState<AppSection>(getInitialSection);
  const [practiceMode, setPracticeMode] = useState<PracticeMode>(getInitialPracticeMode);
  const [selectedWordId, setSelectedWordId] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [micState, setMicState] = useState<MicState>("idle");
  const [smokeReport, setSmokeReport] = useState<LayoutSmokeReport | null>(null);
  const [alignmentResults, setAlignmentResults] = useState<AlignmentResult[]>([]);
  const [tajweedResults, setTajweedResults] = useState<TajweedFinding[]>([]);
  const [asrTranscript, setAsrTranscript] = useState("");
  // Seeded with getQuranVerses() (the static Al-Fatihah bundle) rather than [] — otherwise the
  // reader renders fully blank for the entire time before the first fetch resolves.
  const [quranVerses, setQuranVerses] = useState<QuranVerse[]>(getQuranVerses());
  const [recitationEvents, setRecitationEvents] = useState<RecitationEvent[]>([]);
  const [weeklyProgress, setWeeklyProgress] = useState<ProgressBar[]>([]);
  const [memorizationPlan, setMemorizationPlan] = useState<MemorizationPlan | null>(null);
  const [progress, setProgress] = useState<LearnerProgress | null>(null);
  const [sessionId, setSessionId] = useState<string>("");
  // Truthful completion state: CompletePanel claims "Progress saved" ONLY when a real SM-2 review
  // was persisted. A learner can reach "complete" via the stepper chip without ever reciting, and
  // the save can fail — the panel must reflect what actually happened, not assert success blindly.
  const [saveState, setSaveState] = useState<"idle" | "saved" | "nothing-recited" | "failed">("idle");
  // Show inline consent controls in the practice view when the learner tries to record without
  // having consented — auto-dismissed the moment consent becomes sufficient (see the effect below).
  const [needsConsent, setNeedsConsent] = useState(false);
  // Ensures the completion save fires at most once per practice session, whether "complete" is
  // reached by advancing through the steps or by tapping the stepper chip directly.
  const completedSaveRef = useRef(false);
  // Truthful "send to teacher" state: idle until tried; the drill banner claims "sent" ONLY
  // when the backend confirmed the session entered the teacher review pipeline.
  const [teacherSendState, setTeacherSendState] = useState<"idle" | "sent" | "failed" | "nothing-to-send">("idle");
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
  // Guards the START path of toggleAsrRecording against a double-tap/double-click race: the START
  // branch is async and only flips `isRecording` to true after getUserMedia/startServerAsr resolves,
  // so a second tap while the first is still starting would pass the `isRecording` check too, call
  // getUserMedia a second time, and orphan the first MediaStream's mic tracks (only the second
  // controller ends up in serverAsrRef, so the first is never `.stop()`-ed). Set synchronously
  // (before any `await`) so two taps in the same tick can't both pass the check.
  const startingAsrRef = useRef(false);
  // startMicVisualizer opens its OWN separate getUserMedia stream (for the waveform), resolved
  // asynchronously into visualizerStopRef.current via a `.then()` — independent of, and not
  // necessarily faster than, the ASR path's own getUserMedia call. If the user hits Stop before
  // this particular promise resolves, the STOP branch's `visualizerStopRef.current?.()` call hits
  // `null` (nothing to stop yet), and the visualizer's `.then()` would go on to store its stop
  // function into the ref *after* cleanup already ran — orphaning that mic stream + AudioContext
  // indefinitely (never `.stop()`-ed by anything afterward). This ref lets the `.then()` check
  // whether a stop was already requested and immediately tear down instead of storing a
  // now-orphaned handle.
  const stopRequestedRef = useRef(false);
  const [liveBars, setLiveBars] = useState<number[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // Local ayah number of the reference recitation currently playing (or paused), so the reader can
  // highlight and scroll to the verse the learner is hearing — audio-text sync for the Listen step.
  const [playingAyah, setPlayingAyah] = useState<number | null>(null);
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

  // Auto-dismiss the inline consent prompt the instant consent becomes sufficient, so the learner
  // can tap Record and go — no separate "done" step, no navigating back to Learner Home.
  useEffect(() => {
    if (needsConsent && canRecordRecitation(consent)) {
      setNeedsConsent(false);
    }
  }, [needsConsent, consent]);

  // Drive i18next from the same activeLanguage state already threaded through TopBar/
  // PlatformCommand's <select> — previously activeLanguage only picked which native name to
  // display in the dropdown itself and tagged session metadata; it never actually changed any
  // rendered UI text. Only "en" has real translated content today (see i18n/index.ts); switching
  // to any other language falls back to the same English strings via i18next's fallbackLng, so
  // this never breaks rendering, it just doesn't show translated content yet.
  useEffect(() => {
    void i18n.changeLanguage(activeLanguage);
    // Flip the whole document to the active language's writing direction. The pilot's default
    // (Kurdish Sorani) and Arabic/Urdu are RTL — the chrome must mirror, not just the Arabic text
    // blocks that already carry their own dir="rtl". styles.css uses CSS logical properties so this
    // single dir flip mirrors padding/margins/positioning correctly (P2.4).
    const language = supportedLanguages.find((l) => l.code === activeLanguage);
    document.documentElement.dir = language?.direction ?? "ltr";
    document.documentElement.lang = activeLanguage;
  }, [activeLanguage]);

  const activeStepIndex = Math.max(0, practiceSteps.findIndex((step) => step.id === practiceMode));
  const isLearnerHome = activeSection === "learner" && practiceMode === "home";
  const pageTitle =
    activeSection === "learner" ? (isLearnerHome ? t("app.titleLearnerHome") : t("app.titlePractice")) : t("app.titleInternal");

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
    void refreshQuranVerses(selectedSurah.surahNumber);
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
        captureStateWidth: document.querySelector(".capture-state")?.getBoundingClientRect().width ?? null,
      });
    };

    const frame = requestAnimationFrame(updateSmokeReport);
    window.addEventListener("resize", updateSmokeReport);
    // Recomputing only on [micState, practiceMode]/resize misses async DOM changes with no
    // corresponding React state change here — e.g. navigating to Internal Command changes
    // activeSection (not tracked in this effect's deps) and PlatformCommand is React.lazy, so its
    // content lands well after this effect's initial requestAnimationFrame already fired,
    // leaving hasCommandHero permanently stuck at a stale `false`. A MutationObserver reacts to
    // the actual DOM settling regardless of which state caused it.
    const observer = new MutationObserver(() => requestAnimationFrame(updateSmokeReport));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateSmokeReport);
      observer.disconnect();
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
    setSaveState("idle");
    setNeedsConsent(false);
    completedSaveRef.current = false;
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
    // Detect the transition into the final "complete" step INSIDE the functional updater, so
    // detection is atomic with the actual state change React applies. Computing it from the
    // `practiceMode` closure instead (its value at call time, not at commit time) let two
    // advancePractice() calls dispatched before a re-render both see the pre-transition mode and
    // both fire saveProgressFromPractice for the same completion — double-recording one SM-2
    // review. Only the FIRST call to actually transition into "complete" should persist progress.
    let enteringComplete = false;

    setPracticeMode((currentMode) => {
      if (currentMode === "home") {
        return "listen";
      }

      const currentIndex = practiceSteps.findIndex((step) => step.id === currentMode);
      const nextStep = practiceSteps[Math.min(currentIndex + 1, practiceSteps.length - 1)];
      enteringComplete = currentMode !== "complete" && nextStep.id === "complete";
      return nextStep.id;
    });
    setIsRecording(false);

    if (enteringComplete) {
      triggerCompletionSave();
    }
  }

  // Fire the completion save at most once per practice session. Both advancePractice (stepping to
  // the last step) and selectMode (tapping the "complete" stepper chip directly) route through
  // here, so completing either way persists progress — previously only advancePractice did, so a
  // learner who tapped the chip got "Progress saved" with nothing actually saved.
  function triggerCompletionSave() {
    if (completedSaveRef.current) return;
    completedSaveRef.current = true;
    void saveProgressFromPractice();
  }

  // Stepper-chip handler: jumping straight to "complete" must still persist progress.
  function selectMode(target: PracticeMode) {
    setPracticeMode(target);
    if (target === "complete") {
      triggerCompletionSave();
    }
  }

  /**
   * On practice completion, persist a real SM-2 review (mastery/streak accumulate) from
   * the actual alignment accuracy. Records the honest saveState: "nothing-recited" when there is
   * no recitation to score (never a fabricated quality-0 review), "saved" on success, "failed" if
   * the backend write fails.
   */
  async function saveProgressFromPractice() {
    if (!effectiveUser || alignmentResults.length === 0) {
      setSaveState("nothing-recited");
      return;
    }
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
      setSaveState("saved");
    } catch {
      // Keep the prior progress if the update fails; don't block the completion UI — but say so.
      setSaveState("failed");
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
    setTeacherSendState("idle");
    setSaveState("idle");
    setNeedsConsent(false);
    completedSaveRef.current = false;
    stopPlayback();
    stopRecordingPlayback();
    setRecordedAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return "";
    });
    void refreshQuranVerses(selectedSurah.surahNumber);
  }

  // Real "send to teacher": the drill banner may only claim "sent" after the backend confirms
  // the session's review_status flipped to teacher-review-required. A previous version of this
  // action just switched the local UI step and displayed "Sent to teacher." — nothing was sent.
  async function sendToTeacher() {
    setPracticeMode("drill");
    if (!sessionId || !effectiveUser) {
      // No analyzed session exists (e.g. the learner never recorded, or analysis is offline) —
      // there is nothing a teacher could receive. Say so instead of pretending.
      setTeacherSendState("nothing-to-send");
      return;
    }
    try {
      await requestTeacherReview({
        tenantId: effectiveUser.tenantId,
        userId: effectiveUser.userId,
        authToken,
        sessionId,
      });
      setTeacherSendState("sent");
    } catch {
      setTeacherSendState("failed");
    }
  }

  // loadSurahVerses never rejects on a fetch failure — it catches internally and resolves to []
  // (see data/quran.ts). A naive `.then(setQuranVerses)` therefore replaces a working reader with
  // a blank one the moment the backend is slow/unreachable, with no error shown either. Fall back
  // to getQuranVerses() (cached data, or the static Al-Fatihah bundle) and surface why.
  async function refreshQuranVerses(surahNumber: number) {
    const verses = await loadSurahVerses(surahNumber).catch(() => []);
    if (verses.length > 0) {
      setQuranVerses(verses);
    } else {
      setQuranVerses(getQuranVerses());
      setApiError(getQuranLoadError() ?? "Couldn't load Quran verses from the server; showing offline data.");
    }
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
          ? t("app.errors.platformApiUnreachable")
          : err instanceof Error
            ? err.message
            : t("app.errors.mlAnalysisUnavailable"),
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function toggleAsrRecording() {
    // STOP
    if (isRecording) {
      setIsRecording(false);
      // Tell a still-pending startMicVisualizer() to tear itself down on arrival instead of
      // being stored into visualizerStopRef (see stopRequestedRef's declaration comment).
      stopRequestedRef.current = true;
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
            setApiError(t("app.errors.asrConsentRequired"));
          } else if (result.error) {
            setApiError(t("app.errors.recitationSavedOffline"));
          } else if (result.transcript.trim()) {
            await runAlignmentAndTajweed(result.transcript);
          } else {
            setApiError(t("app.errors.noClearSpeech"));
          }
        } catch {
          setApiError(t("app.errors.processingFailed"));
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

    // START — a double-tap/double-click before the first tap's getUserMedia/startServerAsr call
    // resolves would otherwise pass the `isRecording` check twice (it only flips true after this
    // async work settles) and open a second real microphone stream, orphaning the first (see
    // startingAsrRef's declaration comment). Set synchronously, before any await, so two taps in
    // the same tick can't both pass.
    if (startingAsrRef.current) {
      return;
    }
    startingAsrRef.current = true;
    try {
      await startAsrRecording();
    } finally {
      startingAsrRef.current = false;
    }
  }

  async function startAsrRecording() {
    // Gate on explicit consent to record & analyze. The primary (first-party Quran ASR) path
    // still processes the audio and it may be stored per the retention consent, so recording must not
    // begin until the learner has affirmatively consented (previously this path recorded ungated).
    if (!canRecordRecitation(consent)) {
      // Show the consent controls INLINE at the point of failure instead of only a dead-end error
      // banner — the top first-session failure was a learner tapping Record without consent, then
      // having to navigate all the way back to Learner Home to find the consent panel (P2.1).
      setNeedsConsent(true);
      return;
    }
    stopPlayback();
    stopRecordingPlayback();
    setAsrTranscript("");
    setApiError(null);
    stopRequestedRef.current = false;

    // Live mic waveform (real signal) for the whole recording, regardless of ASR path. Guard
    // against Stop landing before this resolves (see stopRequestedRef's declaration comment): if
    // so, tear the visualizer down immediately instead of storing an orphaned stop handle.
    void startMicVisualizer(setLiveBars)
      .then((stop) => {
        if (stopRequestedRef.current) {
          stop?.();
          return;
        }
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
    setPlayingAyah(null);
  }

  // "Listen": play the selected surah's practice passage sequentially from the Al Quran
  // Cloud CDN (Mishary Al-Afasy reference recitation). The CDN uses the standard 6236
  // numbering, so we map the surah's local ayahs to global ayah numbers. The reader highlights
  // the ayah currently playing (playingAyah = the LOCAL ayah number) for audio-text sync.
  function togglePlay() {
    const current = audioRef.current;
    // Already loaded: pause/resume in place (keeps the highlight and position) rather than tearing
    // down and restarting from the first ayah.
    if (current) {
      if (current.paused) {
        setIsPlaying(true);
        void current.play().catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setApiError(t("app.errors.audioPlaybackBlocked"));
          stopPlayback();
        });
      } else {
        current.pause();
        setIsPlaying(false); // keep audioRef + playingAyah so Resume continues where it paused
      }
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
      setPlayingAyah(ayah - offset); // local ayah number for the reader highlight
      const audio = new Audio(`https://cdn.islamic.network/quran/audio/128/ar.alafasy/${ayah}.mp3`);
      audioRef.current = audio;
      audio.onended = () => playAyah(ayah + 1);
      audio.onerror = () => {
        setApiError(t("app.errors.recitationAudioLoadFailed"));
        stopPlayback();
      };
      void audio.play().catch((err: unknown) => {
        // AbortError = play() was interrupted by a stop/pause (e.g. rapid toggling
        // or starting a recording). Benign — don't surface it as an error.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setApiError(t("app.errors.audioPlaybackBlocked"));
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
      setApiError(t("app.errors.recordingPlaybackFailed"));
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
      {/* tabindex={-1} makes this programmatically focusable (without adding it to the normal
          Tab order) so the "Skip to content" link above actually moves keyboard focus here —
          a plain <main> with no tabindex is not focusable at all, so activating the skip link
          would scroll the page but leave focus on the link itself (or fall back to <body>),
          defeating the entire purpose of a skip link for keyboard/screen-reader users. */}
      <main className="workspace" id="main-content" tabIndex={-1}>
        <TopBar
          title={pageTitle}
          trustLabel={activeSection === "learner" ? t("topBar.trustLabelTeacherReviewed") : t("topBar.trustLabelDefault")}
          activeLanguage={activeLanguage}
          onLanguageChange={setActiveLanguage}
          displayName={effectiveUser?.displayName}
          roleLabel={effectiveUser?.role}
          onLogout={bypassLogin ? undefined : logout}
        />
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
                onSelectMode={selectMode}
                onSelectWord={setSelectedWordId}
                onSendToTeacher={sendToTeacher}
                teacherSendState={teacherSendState}
                saveState={saveState}
                needsConsent={needsConsent}
                consent={consent}
                onConsentChange={setConsent}
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
                playingAyah={playingAyah}
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
              onOpenCommand={(tab) => {
                setActiveSection("admin");
                setActiveTab(tab);
              }}
              onSectionChange={(section) => setActiveSection(section as AppSection)}
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
  // The live-recitation gateway status text (.capture-state/.gateway-state) doesn't overflow
  // the page when squeezed too narrow — it just wraps unreadably, one character per line — so
  // scrollWidth/clientWidth can't catch that regression. captureStateWidth lets a smoke case
  // assert a minimum legible width directly. null when the Internal Command console isn't open.
  captureStateWidth: number | null;
}

function getInitialSection(): AppSection {
  if (typeof window === "undefined") {
    return "learner";
  }

  const smokeMode = new URLSearchParams(window.location.search).get("smokeMode");
  if (smokeMode === "admin") {
    return "admin";
  }

  return "learner";
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
      data-capture-state-width={report.captureStateWidth ?? ""}
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
