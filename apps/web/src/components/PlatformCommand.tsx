import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  DatabaseZap,
  FileCheck2,
  Gauge,
  Languages,
  LockKeyhole,
  Mic,
  MicOff,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Timer,
  UsersRound,
} from "lucide-react";
import {
  DEPLOYED_MODEL_VERSION,
  fetchAgentRuns,
  fetchBenchmarkMetrics,
  fetchMemorizationPlan,
  fetchRecitationSessions,
  fetchScholarApprovals,
  fetchSessionAlignments,
  fetchTajweedFindings,
  fetchTeacherReviewQueue,
  governanceItems,
  getSelectableInterfaceLanguages,
  platformApps,
  platformTabs,
  supportedLanguages,
  type AgentRunSummary,
  type BenchmarkMetric,
  type MemorizationPlan,
  type RecitationSessionSummary,
  type ScholarApprovalSummary,
  type SessionAlignment,
  type TajweedFindingSummary,
  type TeacherReviewItem,
} from "../data/platform";
import { getQuranVerses } from "../data/quran";
import { fetchRealtimeTicket } from "../lib/api";
import {
  getConfiguredRealtimeAudioUrl,
  startGatewayAudioUpload,
  startBrowserMicCapture,
  summarizeLiveCapture,
  type BrowserAudioChunk,
  type GatewayAudioAck,
  type GatewayUploader,
  type GatewayUploadStatus,
  type MicCaptureController,
  type MicCaptureStatus,
} from "../lib/liveRecitation";
import {
  canShowLearnerFacingAnswer,
  formatPercent,
  getSourceCoverage,
  requiresHumanReview,
  summarizeScholarQueue,
} from "../lib/platform";
import type { SupportedLanguageCode } from "../types/platform";

interface PlatformCommandProps {
  tenantId: string;
  authToken?: string;
  activeLanguage: SupportedLanguageCode;
  onLanguageChange: (language: SupportedLanguageCode) => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
  activeSection: string;
  onSectionChange: (section: string) => void;
}

interface ConsoleData {
  agentRuns: AgentRunSummary[];
  scholarApprovals: ScholarApprovalSummary[];
  teacherReviews: TeacherReviewItem[];
  tajweedFindings: TajweedFindingSummary[];
  benchmarkMetrics: BenchmarkMetric[];
  memorizationPlan: MemorizationPlan | null;
  activeSession: RecitationSessionSummary | null;
  sessionAlignments: SessionAlignment[];
}

const EMPTY_CONSOLE: ConsoleData = {
  agentRuns: [],
  scholarApprovals: [],
  teacherReviews: [],
  tajweedFindings: [],
  benchmarkMetrics: [],
  memorizationPlan: null,
  activeSession: null,
  sessionAlignments: [],
};

export function PlatformCommand({
  tenantId,
  authToken,
  activeLanguage,
  activeTab,
  onLanguageChange,
  onTabChange,
  activeSection,
  onSectionChange,
}: PlatformCommandProps) {
  const selectedLanguage =
    supportedLanguages.find((language) => language.code === activeLanguage) ?? supportedLanguages[0];
  const [data, setData] = useState<ConsoleData>(EMPTY_CONSOLE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);

    async function load() {
      try {
        const [agentRuns, scholarApprovals, teacherReviews, tajweedFindings, benchmarkMetrics, memorizationPlan, sessions] =
          await Promise.all([
            fetchAgentRuns(tenantId, authToken),
            fetchScholarApprovals(tenantId, authToken),
            fetchTeacherReviewQueue(tenantId, authToken),
            fetchTajweedFindings(tenantId, authToken),
            fetchBenchmarkMetrics(tenantId, authToken),
            fetchMemorizationPlan(tenantId, "learner-1", authToken),
            fetchRecitationSessions(tenantId, authToken),
          ]);

        const activeSession = sessions[0] ?? null;
        const sessionAlignments = activeSession
          ? await fetchSessionAlignments(tenantId, activeSession.id, authToken)
          : [];

        if (cancelled) return;
        setData({
          agentRuns,
          scholarApprovals,
          teacherReviews,
          tajweedFindings,
          benchmarkMetrics,
          memorizationPlan,
          activeSession,
          sessionAlignments,
        });
      } catch {
        // A failed console fetch must not crash the surface — fall back to empty state.
        if (!cancelled) setData(EMPTY_CONSOLE);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [authToken, tenantId]);

  // Live refresh: while the console is open, poll the active session's alignment so a
  // learner's freshly-persisted recitation appears without a manual reload. Only the
  // (small) alignment list is re-fetched, not the whole console.
  useEffect(() => {
    const sessionId = data.activeSession?.id;
    if (!sessionId) return;
    let cancelled = false;
    const interval = setInterval(() => {
      void fetchSessionAlignments(tenantId, sessionId, authToken)
        .then((sessionAlignments) => {
          if (!cancelled) setData((prev) => ({ ...prev, sessionAlignments }));
        })
        .catch(() => {});
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [data.activeSession?.id, tenantId, authToken]);

  const { t } = useTranslation();
  const scholarSummary = summarizeScholarQueue(data.scholarApprovals);

  return (
    <section className="platform-command" aria-label={t("platformCommand.ariaLabel")}>
      <header className="command-hero">
        <div className="command-title">
          <span className="status-dot" />
          <div>
            <p>{t("platformCommand.title")}</p>
            <h1>{t("platformCommand.heading")}</h1>
          </div>
        </div>
        <div className="command-controls">
          <label className="language-select">
            <Languages size={16} />
            <span className="sr-only">{t("platformCommand.language")}</span>
            <select value={activeLanguage} onChange={(event) => onLanguageChange(event.target.value as SupportedLanguageCode)}>
              {(() => {
                const isTestOrSmoke =
                  import.meta.env.MODE === "test" ||
                  (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke"));
                const offeredLanguages = isTestOrSmoke
                  ? supportedLanguages
                  : getSelectableInterfaceLanguages();
                return offeredLanguages.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.nativeName}
                  </option>
                ));
              })()}
            </select>
          </label>
          <div className="trust-chip">
            <ShieldCheck size={16} />
            {t("platformCommand.humanReviewed")}
          </div>
          <div className="trust-chip model">
            <Gauge size={16} />
            {DEPLOYED_MODEL_VERSION}
          </div>
        </div>
      </header>

      <nav className="platform-apps" aria-label={t("platformCommand.appsAriaLabel")}>
        {platformApps.map((app) => {
          const Icon = app.icon;
          return (
            <button
              aria-current={activeSection === app.id ? "page" : undefined}
              className={activeSection === app.id ? "platform-app active" : "platform-app"}
              key={app.id}
              onClick={() => onSectionChange(app.id)}
              type="button"
            >
              <Icon size={18} />
              <span>{t(app.labelKey)}</span>
              <small>{t(app.descriptionKey)}</small>
            </button>
          );
        })}
      </nav>

      {/* role="group"/aria-pressed, not role="tablist"/role="tab"/aria-selected: the WAI-ARIA
          Tab pattern requires each tab to control a corresponding tabpanel whose content changes
          on selection. Nothing here does — activeTab is tracked and highlighted correctly, but
          command-grid/command-bottom-grid below render the same fixed set of cards regardless of
          which "tab" is active. The prior tablist/tab roles told screen reader users a content
          switch would happen that never did. This corrects the semantics to match actual
          behavior (a toggle-button group) without deciding whether the tabs *should* filter
          content — that's a real product/design question, tracked separately, not something to
          decide as an accessibility fix. */}
      <div className="platform-tabs" role="group" aria-label={t("platformCommand.tabsAriaLabel")}>
        {platformTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              aria-pressed={activeTab === tab.id}
              className={activeTab === tab.id ? "platform-tab active" : "platform-tab"}
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              type="button"
            >
              <Icon size={16} />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="command-grid">
        <LiveAlignmentCard
          selectedLanguage={selectedLanguage.nativeName}
          activeSession={data.activeSession}
          sessionAlignments={data.sessionAlignments}
          tenantId={tenantId}
          authToken={authToken}
        />
        <IntelligenceColumn agentRuns={data.agentRuns} tajweedFindings={data.tajweedFindings} loaded={loaded} />
        <OperationsColumn
          scholarSummary={scholarSummary}
          scholarApprovals={data.scholarApprovals}
          teacherReviews={data.teacherReviews}
          memorizationPlan={data.memorizationPlan}
          loaded={loaded}
        />
      </div>

      <div className="command-bottom-grid">
        <DataFlywheelCard />
        <BenchmarkCard metrics={data.benchmarkMetrics} loaded={loaded} />
        <GovernanceCard agentRuns={data.agentRuns} />
      </div>
    </section>
  );
}

function LiveAlignmentCard({
  selectedLanguage,
  activeSession,
  sessionAlignments,
  tenantId,
  authToken,
}: {
  selectedLanguage: string;
  activeSession: RecitationSessionSummary | null;
  sessionAlignments: SessionAlignment[];
  tenantId: string;
  authToken?: string;
}) {
  const { t } = useTranslation();
  // Chunks the bounded buffer had to discard during an outage. Surfaced rather than swallowed: the
  // learner must know their recitation has gaps.
  const [droppedChunks, setDroppedChunks] = useState(0);
  const captureRef = useRef<MicCaptureController | null>(null);
  const uploaderRef = useRef<GatewayUploader | null>(null);
  // Guards handleCaptureToggle's start path against a double-tap: captureRef.current is only
  // assigned after `await startBrowserMicCapture(...)` resolves (a real getUserMedia permission
  // prompt, which can take real wall-clock time), so a second click during that window would
  // otherwise re-enter the start branch too — opening a second real microphone stream AND a
  // second gateway WebSocket, each orphaning the first (refs get overwritten by whichever
  // resolves last; the first stream's tracks are never stopped, the first socket never closed).
  // Same class of bug as the double-tap mic leak already fixed in App.tsx's toggleAsrRecording.
  const isStartingCaptureRef = useRef(false);

  // Without this, navigating away from the console (e.g. closing Internal Command) while capture
  // is running unmounts this component but never tells the underlying MediaRecorder, microphone
  // MediaStreamTracks, or gateway WebSocket to stop -- only handleCaptureToggle's manual-stop
  // branch did that. The mic keeps recording and streaming audio indefinitely with no UI
  // indication and no way to stop it short of a full reload, a real privacy issue given this
  // app's explicit audio-consent requirements.
  useEffect(() => {
    return () => {
      captureRef.current?.stop();
      uploaderRef.current?.close();
    };
  }, []);

  const [captureStatus, setCaptureStatus] = useState<MicCaptureStatus>("idle");
  const [captureError, setCaptureError] = useState("");
  const [gatewayStatus, setGatewayStatus] = useState<GatewayUploadStatus>("idle");
  const [gatewayError, setGatewayError] = useState("");
  const [gatewayAcks, setGatewayAcks] = useState<GatewayAudioAck[]>([]);
  const [audioChunks, setAudioChunks] = useState<BrowserAudioChunk[]>([]);
  // Live per-word alignment streaming is not wired yet; pass [] so telemetry reflects
  // captured chunks only (no fabricated alignment events).
  const liveSummary = summarizeLiveCapture(audioChunks, []);
  const acceptedAcks = gatewayAcks.filter((ack) => ack.accepted).length;
  const flaggedCount = sessionAlignments.filter((alignment) => alignment.status !== "matched").length;
  const isRecording = captureStatus === "recording" || captureStatus === "requesting-permission";
  const sessionId = activeSession?.id ?? "platform-console-preview";
  const latencyMs = activeSession?.latencyMs ?? 0;

  async function handleCaptureToggle() {
    if (captureRef.current) {
      captureRef.current.stop();
      captureRef.current = null;
      uploaderRef.current?.close();
      uploaderRef.current = null;
      return;
    }

    // See isStartingCaptureRef's declaration comment: block re-entry synchronously, before the
    // getUserMedia await, so a double-tap can't open a second stream/socket.
    if (isStartingCaptureRef.current) {
      return;
    }
    isStartingCaptureRef.current = true;
    try {
      setCaptureError("");
      setGatewayError("");
      setGatewayAcks([]);
      setAudioChunks([]);
      setDroppedChunks(0);
      uploaderRef.current = startGatewayAudioUpload({
        // A FRESH single-use ticket per connect — including every reconnect. The gateway 401s an
        // audio socket with no `?ticket=` (which is why live upload never actually connected before)
        // and rejects any ticket it has already seen, so the URL cannot be reused.
        getUrl: async () => {
          const ticket = await fetchRealtimeTicket({
            tenantId,
            userId: "admin-1",
            role: "admin",
            authToken,
            sessionId,
            requestedSampleRates: [16000],
          });
          return `${getConfiguredRealtimeAudioUrl(sessionId)}?ticket=${encodeURIComponent(ticket.token)}`;
        },
        onStatusChange: setGatewayStatus,
        onAck: (ack) => setGatewayAcks((currentAcks) => [...currentAcks, ack]),
        onError: setGatewayError,
        onBufferDrop: setDroppedChunks,
      });

      captureRef.current = await startBrowserMicCapture({
        sessionId,
        sampleRate: 16000,
        chunkDurationMs: 480,
        onStatusChange: setCaptureStatus,
        onError: setCaptureError,
        onChunk: (chunk) => {
          uploaderRef.current?.sendChunk(chunk);
          setAudioChunks((currentChunks) => [...currentChunks, chunk]);
        },
      });
    } finally {
      isStartingCaptureRef.current = false;
    }
  }

  const sessionTitle = activeSession ? activeSession.quranRef.display : t("platformCommand.liveAlignment.noRecentSession");
  const kbStreamed = (liveSummary.totalBytes / 1024).toFixed(1);

  return (
    <article className="command-card live-card">
      <div className="command-card-header">
        <div>
          <p>{t("platformCommand.liveAlignment.eyebrow")}</p>
          <h2>{sessionTitle}</h2>
        </div>
        <span className="live-pill"><Radio size={14} /> {latencyMs}ms</span>
      </div>

      <div className="live-capture-panel">
        <button className={isRecording ? "capture-button active" : "capture-button"} onClick={handleCaptureToggle} type="button">
          {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
          {isRecording ? t("platformCommand.liveAlignment.stopLive") : t("platformCommand.liveAlignment.startLive")}
        </button>
        <div className="capture-state">
          <strong>{t(formatCaptureStatusKey(captureStatus))}</strong>
          <span>
            {captureError ||
              t("platformCommand.liveAlignment.chunksStreamed", { count: liveSummary.chunkCount, kb: kbStreamed })}
          </span>
        </div>
        <div className="gateway-state">
          <strong>{t("platformCommand.liveAlignment.gatewayLabel", { status: t(formatGatewayStatusKey(gatewayStatus)) })}</strong>
          <span>{gatewayError || t("platformCommand.liveAlignment.acceptedAcks", { count: acceptedAcks })}</span>
        </div>
      </div>

      <div className="session-meta-grid">
        <Metric label={t("platformCommand.liveAlignment.learner")} value={activeSession?.learnerId ?? "—"} />
        <Metric label={t("platformCommand.liveAlignment.language")} value={selectedLanguage} />
        <Metric label={t("platformCommand.liveAlignment.mode")} value={(activeSession?.mode ?? "—").replace("-", " ")} />
        <Metric label={t("platformCommand.liveAlignment.findings")} value={t("platformCommand.liveAlignment.findingsValue", { count: flaggedCount })} />
      </div>

      <div className="mini-mushaf" dir="rtl" lang="ar">
        {getQuranVerses().slice(4).map((verse) => (
          <div className="mini-verse" key={verse.id}>
            <span>{verse.verseNumber}</span>
            <p>
              {verse.words.map((word) => (
                <mark className={`mini-word ${word.status}`} key={word.id}>
                  {word.text}
                </mark>
              ))}
            </p>
          </div>
        ))}
      </div>

      <div className="alignment-table" aria-label={t("platformCommand.liveAlignment.wordAlignmentAriaLabel")}>
        {sessionAlignments.map((alignment) => (
          <div className={`alignment-row ${alignment.status}`} key={alignment.wordId}>
            <span dir="rtl" lang="ar">{alignment.canonicalText}</span>
            <small>{alignment.status.replace("-", " ")}</small>
            <strong>{Math.round(alignment.confidence * 100)}%</strong>
          </div>
        ))}
        {sessionAlignments.length === 0 && (
          <p className="panel-empty">{t("platformCommand.liveAlignment.noStoredAlignments")}</p>
        )}
      </div>
    </article>
  );
}

// Plain functions, no React context to call useTranslation() from -- return translation KEYs.
function formatCaptureStatusKey(status: MicCaptureStatus): string {
  switch (status) {
    case "requesting-permission":
      return "platformCommand.liveAlignment.statusRequestingMic";
    case "recording":
      return "platformCommand.liveAlignment.statusStreaming";
    case "stopped":
      return "platformCommand.liveAlignment.statusStopped";
    case "denied":
      return "platformCommand.liveAlignment.statusPermissionDenied";
    case "unsupported":
      return "platformCommand.liveAlignment.statusUnsupported";
    case "error":
      return "platformCommand.liveAlignment.statusCaptureError";
    case "idle":
      return "platformCommand.liveAlignment.statusReady";
  }
}

function formatGatewayStatusKey(status: GatewayUploadStatus): string {
  switch (status) {
    case "connecting":
      return "platformCommand.liveAlignment.gatewayConnecting";
    case "connected":
      return "platformCommand.liveAlignment.gatewayConnected";
    case "reconnecting":
      return "platformCommand.liveAlignment.gatewayReconnecting";
    case "degraded":
      return "platformCommand.liveAlignment.gatewayDegraded";
    case "unavailable":
      return "platformCommand.liveAlignment.gatewayUnavailable";
    case "error":
      return "platformCommand.liveAlignment.gatewayError";
    case "closed":
      return "platformCommand.liveAlignment.gatewayClosed";
    case "idle":
      return "platformCommand.liveAlignment.gatewayIdle";
  }
}

function IntelligenceColumn({
  agentRuns,
  tajweedFindings,
  loaded,
}: {
  agentRuns: AgentRunSummary[];
  tajweedFindings: TajweedFindingSummary[];
  loaded: boolean;
}) {
  const { t } = useTranslation();
  const pipelineSteps = [
    t("platformCommand.pipeline.audioChunk"),
    t("platformCommand.pipeline.canonicalAlign"),
    t("platformCommand.pipeline.tajweedFeatures"),
    t("platformCommand.pipeline.teacherGate"),
  ];
  return (
    <div className="command-column">
      <article className="command-card pipeline-card">
        <div className="command-card-header compact">
          <div>
            <p>{t("platformCommand.pipeline.eyebrow")}</p>
            <h2>{t("platformCommand.pipeline.title")}</h2>
          </div>
          <DatabaseZap size={20} />
        </div>
        <div className="pipeline">
          {pipelineSteps.map((step, index) => (
            <div className="pipeline-step" key={step}>
              <span>{index + 1}</span>
              <p>{step}</p>
              {index < 3 ? <ArrowRight size={15} /> : <CheckCircle2 size={15} />}
            </div>
          ))}
        </div>
      </article>

      <article className="command-card">
        <div className="command-card-header compact">
          <div>
            <p>{t("platformCommand.agentRuns.eyebrow")}</p>
            <h2>{t("platformCommand.agentRuns.title")}</h2>
          </div>
          <Bot size={20} />
        </div>
        {/* run.name/goal/lastEvent are real agent-run data from the backend -- not translated. */}
        <div className="agent-list">
          {agentRuns.map((run) => (
            <div className={`agent-row ${run.status}`} key={run.id}>
              <div>
                <strong>{run.name}</strong>
                <p>{run.goal}</p>
                {run.lastEvent ? <small>{run.lastEvent}</small> : null}
              </div>
              <span>
                {requiresHumanReview(run)
                  ? t("platformCommand.agentRuns.review")
                  : canShowLearnerFacingAnswer(run)
                    ? t("platformCommand.agentRuns.safe")
                    : t("platformCommand.agentRuns.blocked")}
              </span>
            </div>
          ))}
          {loaded && agentRuns.length === 0 && <p className="panel-empty">{t("platformCommand.agentRuns.empty")}</p>}
        </div>
      </article>

      <article className="command-card">
        <div className="command-card-header compact">
          <div>
            <p>{t("platformCommand.tajweedFindings.eyebrow")}</p>
            <h2>{t("platformCommand.tajweedFindings.title")}</h2>
          </div>
          <Sparkles size={20} />
        </div>
        {/* finding.rule/explanation/reviewStatus are real tajweed content -- not translated here,
            same as TajweedPanel.tsx (requires scholar review, not UI i18n). */}
        <div className="finding-list">
          {tajweedFindings.map((finding) => (
            <div className={`finding-row ${finding.severity}`} key={finding.id}>
              <strong>{finding.rule}</strong>
              <p>{finding.explanation}</p>
              <span>{Math.round(finding.confidence * 100)}% · {finding.reviewStatus}</span>
            </div>
          ))}
          {loaded && tajweedFindings.length === 0 && (
            <p className="panel-empty">{t("platformCommand.tajweedFindings.empty")}</p>
          )}
        </div>
      </article>
    </div>
  );
}

function OperationsColumn({
  scholarSummary,
  scholarApprovals,
  teacherReviews,
  memorizationPlan,
  loaded,
}: {
  scholarSummary: ReturnType<typeof summarizeScholarQueue>;
  scholarApprovals: ScholarApprovalSummary[];
  teacherReviews: TeacherReviewItem[];
  memorizationPlan: MemorizationPlan | null;
  loaded: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="command-column">
      <article className="command-card">
        <div className="command-card-header compact">
          <div>
            <p>{t("platformCommand.teacherDashboard.eyebrow")}</p>
            <h2>{t("platformCommand.teacherDashboard.title")}</h2>
          </div>
          <UsersRound size={20} />
        </div>
        {/* review.teacherId/note/findingId/decision are real teacher-review data -- not translated. */}
        <div className="teacher-list">
          {teacherReviews.map((review) => (
            <div className="teacher-row" key={review.id}>
              <div>
                <strong>{review.teacherId}</strong>
                <span>{review.note}</span>
              </div>
              <dl>
                <div>
                  <dt>{t("platformCommand.teacherDashboard.finding")}</dt>
                  <dd>{review.findingId}</dd>
                </div>
                <div>
                  <dt>{t("platformCommand.teacherDashboard.decision")}</dt>
                  <dd>{review.decision}</dd>
                </div>
              </dl>
            </div>
          ))}
          {loaded && teacherReviews.length === 0 && (
            <p className="panel-empty">{t("platformCommand.teacherDashboard.empty")}</p>
          )}
        </div>
      </article>

      <article className="command-card">
        <div className="command-card-header compact">
          <div>
            <p>{t("platformCommand.scholarReview.eyebrow")}</p>
            <h2>{t("platformCommand.scholarReview.title")}</h2>
          </div>
          <ShieldCheck size={20} />
        </div>
        <div className="review-summary">
          <Metric label={t("platformCommand.scholarReview.queue")} value={`${scholarSummary.total}`} />
          <Metric label={t("platformCommand.scholarReview.approved")} value={`${scholarSummary["scholar-approved"]}`} />
          <Metric label={t("platformCommand.scholarReview.blocked")} value={`${scholarSummary.blocked}`} />
        </div>
        {/* approval.topic/reviewer/sourceCount/risk are real scholar-approval data -- not translated. */}
        <div className="scholar-list">
          {scholarApprovals.map((approval) => (
            <div className={`scholar-row ${approval.status}`} key={approval.id}>
              <span>{approval.status === "blocked" ? <ShieldAlert size={16} /> : <FileCheck2 size={16} />}</span>
              <div>
                <strong>{approval.topic}</strong>
                <small>{approval.reviewer} · {approval.sourceCount} sources · {approval.risk} risk</small>
              </div>
            </div>
          ))}
          {loaded && scholarApprovals.length === 0 && (
            <p className="panel-empty">{t("platformCommand.scholarReview.empty")}</p>
          )}
        </div>
      </article>

      <article className="command-card">
        <div className="command-card-header compact">
          <div>
            <p>{t("platformCommand.memorizationCoach.eyebrow")}</p>
            <h2>{t("platformCommand.memorizationCoach.title")}</h2>
          </div>
          <Timer size={20} />
        </div>
        {memorizationPlan ? (
          <>
            <p className="coach-note">{t(memorizationPlan.currentFocusKey)}</p>
            <div className="interval-list">
              {memorizationPlan.intervals.map((interval) => (
                <div key={interval.labelKey}>
                  <span>{t(interval.labelKey)}</span>
                  <strong>{t("platformCommand.memorizationCoach.dueCount", { count: interval.dueCount })}</strong>
                  <small>{t("platformCommand.memorizationCoach.retention", { percent: formatPercent(interval.retention) })}</small>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="panel-empty">{t("platformCommand.memorizationCoach.empty")}</p>
        )}
      </article>
    </div>
  );
}

function DataFlywheelCard() {
  const { t } = useTranslation();
  const flywheelSteps = [
    t("platformCommand.dataFlywheel.learnerAudio"),
    t("platformCommand.dataFlywheel.teacherCorrection"),
    t("platformCommand.dataFlywheel.scholarApprovedExamples"),
    t("platformCommand.dataFlywheel.evalSet"),
    t("platformCommand.dataFlywheel.modelRelease"),
  ];
  return (
    <article className="command-card bottom-card">
      <div className="command-card-header compact">
        <div>
          <p>{t("platformCommand.dataFlywheel.eyebrow")}</p>
          <h2>{t("platformCommand.dataFlywheel.title")}</h2>
        </div>
        <DatabaseZap size={20} />
      </div>
      <div className="flywheel">
        {flywheelSteps.map((step) => (
          <span key={step}>{step}</span>
        ))}
      </div>
    </article>
  );
}

function BenchmarkCard({ metrics, loaded }: { metrics: BenchmarkMetric[]; loaded: boolean }) {
  const { t } = useTranslation();
  return (
    <article className="command-card bottom-card">
      <div className="command-card-header compact">
        <div>
          <p>{t("platformCommand.benchmark.eyebrow")}</p>
          <h2>{t("platformCommand.benchmark.title")}</h2>
        </div>
        <Gauge size={20} />
      </div>
      <div className="benchmark-grid">
        {metrics.map((metric) => (
          <div className={`benchmark ${metric.status}`} key={metric.labelKey}>
            <span>{t(metric.labelKey)}</span>
            <strong>{metric.value}</strong>
            <small>{t("platformCommand.benchmark.target", { value: metric.target })}</small>
          </div>
        ))}
        {loaded && metrics.length === 0 && (
          <p className="panel-empty">{t("platformCommand.benchmark.empty")}</p>
        )}
      </div>
    </article>
  );
}

function GovernanceCard({ agentRuns }: { agentRuns: AgentRunSummary[] }) {
  const { t } = useTranslation();
  const coverage = agentRuns.length > 0 ? getSourceCoverage(agentRuns[0].sources) : "missing";
  return (
    <article className="command-card bottom-card">
      <div className="command-card-header compact">
        <div>
          <p>{t("platformCommand.governance.eyebrow")}</p>
          <h2>{t("platformCommand.governance.title")}</h2>
        </div>
        <LockKeyhole size={20} />
      </div>
      <div className="governance-grid">
        {governanceItems.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.labelKey}>
              <Icon size={17} />
              <strong>{t(item.labelKey)}</strong>
              <span>{t(item.statusKey)}</span>
            </div>
          );
        })}
      </div>
      <p className="source-line">
        {t("platformCommand.governance.sourceLine", { coverage })}
      </p>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
