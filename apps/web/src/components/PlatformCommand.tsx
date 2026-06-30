import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
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
import { BrandMark } from "./BrandMark";

interface PlatformCommandProps {
  tenantId: string;
  activeLanguage: SupportedLanguageCode;
  onLanguageChange: (language: SupportedLanguageCode) => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
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
  activeLanguage,
  activeTab,
  onLanguageChange,
  onTabChange,
}: PlatformCommandProps) {
  const selectedLanguage =
    supportedLanguages.find((language) => language.code === activeLanguage) ?? supportedLanguages[0];
  const [data, setData] = useState<ConsoleData>(EMPTY_CONSOLE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);

    async function load() {
      const [agentRuns, scholarApprovals, teacherReviews, tajweedFindings, benchmarkMetrics, memorizationPlan, sessions] =
        await Promise.all([
          fetchAgentRuns(tenantId),
          fetchScholarApprovals(tenantId),
          fetchTeacherReviewQueue(tenantId),
          fetchTajweedFindings(tenantId),
          fetchBenchmarkMetrics(tenantId),
          fetchMemorizationPlan(tenantId, "learner-1"),
          fetchRecitationSessions(tenantId),
        ]);

      const activeSession = sessions[0] ?? null;
      const sessionAlignments = activeSession
        ? await fetchSessionAlignments(tenantId, activeSession.id)
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
      setLoaded(true);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const scholarSummary = summarizeScholarQueue(data.scholarApprovals);

  return (
    <section className="platform-command" aria-label="Quran AI Platform Command">
      <header className="command-hero">
        <div className="command-title">
          <span className="status-dot" />
          <div>
            <p>Platform Command</p>
            <h1>Quran AI intelligence platform</h1>
          </div>
        </div>
        <div className="command-controls">
          <label className="language-select">
            <Languages size={16} />
            <span className="sr-only">Language</span>
            <select value={activeLanguage} onChange={(event) => onLanguageChange(event.target.value as SupportedLanguageCode)}>
              {supportedLanguages.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.nativeName}
                </option>
              ))}
            </select>
          </label>
          <div className="trust-chip">
            <ShieldCheck size={16} />
            Human reviewed
          </div>
          <div className="trust-chip model">
            <Gauge size={16} />
            {DEPLOYED_MODEL_VERSION}
          </div>
        </div>
      </header>

      <nav className="platform-apps" aria-label="Platform apps">
        {platformApps.map((app) => {
          const Icon = app.icon;
          return (
            <button className={app.id === "learner" ? "platform-app active" : "platform-app"} key={app.id} type="button">
              <Icon size={18} />
              <span>{app.label}</span>
              <small>{app.description}</small>
            </button>
          );
        })}
      </nav>

      <div className="platform-tabs" role="tablist" aria-label="Command center views">
        {platformTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "platform-tab active" : "platform-tab"}
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              role="tab"
              type="button"
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="command-grid">
        <LiveAlignmentCard
          selectedLanguage={selectedLanguage.nativeName}
          activeSession={data.activeSession}
          sessionAlignments={data.sessionAlignments}
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
}: {
  selectedLanguage: string;
  activeSession: RecitationSessionSummary | null;
  sessionAlignments: SessionAlignment[];
}) {
  const captureRef = useRef<MicCaptureController | null>(null);
  const uploaderRef = useRef<GatewayUploader | null>(null);
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

    setCaptureError("");
    setGatewayError("");
    setGatewayAcks([]);
    setAudioChunks([]);
    uploaderRef.current = startGatewayAudioUpload({
      url: getConfiguredRealtimeAudioUrl(sessionId),
      onStatusChange: setGatewayStatus,
      onAck: (ack) => setGatewayAcks((currentAcks) => [...currentAcks, ack]),
      onError: setGatewayError,
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
  }

  const sessionTitle = activeSession ? activeSession.quranRef.display : "No recent session";
  const kbStreamed = (liveSummary.totalBytes / 1024).toFixed(1);

  return (
    <article className="command-card live-card">
      <div className="command-card-header">
        <div>
          <p>Live alignment</p>
          <h2>{sessionTitle}</h2>
        </div>
        <span className="live-pill"><Radio size={14} /> {latencyMs}ms</span>
      </div>

      <div className="live-capture-panel">
        <button className={isRecording ? "capture-button active" : "capture-button"} onClick={handleCaptureToggle} type="button">
          {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
          {isRecording ? "Stop live recitation" : "Start live recitation"}
        </button>
        <div className="capture-state">
          <strong>{formatCaptureStatus(captureStatus)}</strong>
          <span>
            {captureError ||
              `${liveSummary.chunkCount} chunks · ${kbStreamed} KB streamed`}
          </span>
        </div>
        <div className="gateway-state">
          <strong>Gateway {formatGatewayStatus(gatewayStatus)}</strong>
          <span>{gatewayError || `${acceptedAcks} accepted acks`}</span>
        </div>
      </div>

      <div className="session-meta-grid">
        <Metric label="Learner" value={activeSession?.learnerId ?? "—"} />
        <Metric label="Language" value={selectedLanguage} />
        <Metric label="Mode" value={(activeSession?.mode ?? "—").replace("-", " ")} />
        <Metric label="Findings" value={`${flaggedCount} review`} />
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

      <div className="alignment-table" aria-label="Word alignment">
        {sessionAlignments.map((alignment) => (
          <div className={`alignment-row ${alignment.status}`} key={alignment.wordId}>
            <span dir="rtl" lang="ar">{alignment.canonicalText}</span>
            <small>{alignment.status.replace("-", " ")}</small>
            <strong>{Math.round(alignment.confidence * 100)}%</strong>
          </div>
        ))}
        {sessionAlignments.length === 0 && (
          <p className="panel-empty">No stored word alignments for the latest session yet.</p>
        )}
      </div>
    </article>
  );
}

function formatCaptureStatus(status: MicCaptureStatus): string {
  switch (status) {
    case "requesting-permission":
      return "Requesting mic";
    case "recording":
      return "Streaming";
    case "stopped":
      return "Stopped";
    case "denied":
      return "Permission denied";
    case "unsupported":
      return "Unsupported";
    case "error":
      return "Capture error";
    case "idle":
      return "Ready";
  }
}

function formatGatewayStatus(status: GatewayUploadStatus): string {
  switch (status) {
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "unavailable":
      return "unavailable";
    case "error":
      return "error";
    case "closed":
      return "closed";
    case "idle":
      return "idle";
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
  return (
    <div className="command-column">
      <article className="command-card pipeline-card">
        <div className="command-card-header compact">
          <div>
            <p>Quran-specific engine</p>
            <h2>Streaming intelligence pipeline</h2>
          </div>
          <DatabaseZap size={20} />
        </div>
        <div className="pipeline">
          {["Audio chunk", "Canonical align", "Tajweed features", "Teacher gate"].map((step, index) => (
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
            <p>Agent runs</p>
            <h2>Supervised tools only</h2>
          </div>
          <Bot size={20} />
        </div>
        <div className="agent-list">
          {agentRuns.map((run) => (
            <div className={`agent-row ${run.status}`} key={run.id}>
              <div>
                <strong>{run.name}</strong>
                <p>{run.goal}</p>
                {run.lastEvent ? <small>{run.lastEvent}</small> : null}
              </div>
              <span>{requiresHumanReview(run) ? "Review" : canShowLearnerFacingAnswer(run) ? "Safe" : "Blocked"}</span>
            </div>
          ))}
          {loaded && agentRuns.length === 0 && <p className="panel-empty">No agent runs recorded yet.</p>}
        </div>
      </article>

      <article className="command-card">
        <div className="command-card-header compact">
          <div>
            <p>Tajweed findings</p>
            <h2>Confidence-scored feedback</h2>
          </div>
          <Sparkles size={20} />
        </div>
        <div className="finding-list">
          {tajweedFindings.map((finding) => (
            <div className={`finding-row ${finding.severity}`} key={finding.id}>
              <strong>{finding.rule}</strong>
              <p>{finding.explanation}</p>
              <span>{Math.round(finding.confidence * 100)}% · {finding.reviewStatus}</span>
            </div>
          ))}
          {loaded && tajweedFindings.length === 0 && (
            <p className="panel-empty">No tajweed findings under review.</p>
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
  return (
    <div className="command-column">
      <article className="command-card">
        <div className="command-card-header compact">
          <div>
            <p>Teacher dashboard</p>
            <h2>Institution review loop</h2>
          </div>
          <UsersRound size={20} />
        </div>
        <div className="teacher-list">
          {teacherReviews.map((review) => (
            <div className="teacher-row" key={review.id}>
              <div>
                <strong>{review.teacherId}</strong>
                <span>{review.note}</span>
              </div>
              <dl>
                <div>
                  <dt>Finding</dt>
                  <dd>{review.findingId}</dd>
                </div>
                <div>
                  <dt>Decision</dt>
                  <dd>{review.decision}</dd>
                </div>
              </dl>
            </div>
          ))}
          {loaded && teacherReviews.length === 0 && (
            <p className="panel-empty">No teacher reviews recorded yet.</p>
          )}
        </div>
      </article>

      <article className="command-card">
        <div className="command-card-header compact">
          <div>
            <p>Scholar review</p>
            <h2>Trust ledger</h2>
          </div>
          <ShieldCheck size={20} />
        </div>
        <div className="review-summary">
          <Metric label="Queue" value={`${scholarSummary.total}`} />
          <Metric label="Approved" value={`${scholarSummary["scholar-approved"]}`} />
          <Metric label="Blocked" value={`${scholarSummary.blocked}`} />
        </div>
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
            <p className="panel-empty">No scholar approvals in the ledger yet.</p>
          )}
        </div>
      </article>

      <article className="command-card">
        <div className="command-card-header compact">
          <div>
            <p>Memorization coach</p>
            <h2>Adaptive review plan</h2>
          </div>
          <Timer size={20} />
        </div>
        {memorizationPlan ? (
          <>
            <p className="coach-note">{memorizationPlan.currentFocus}</p>
            <div className="interval-list">
              {memorizationPlan.intervals.map((interval) => (
                <div key={interval.label}>
                  <span>{interval.label}</span>
                  <strong>{interval.dueCount} due</strong>
                  <small>{formatPercent(interval.retention)} retention</small>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="panel-empty">No memorization plan available yet.</p>
        )}
      </article>
    </div>
  );
}

function DataFlywheelCard() {
  return (
    <article className="command-card bottom-card">
      <div className="command-card-header compact">
        <div>
          <p>Data flywheel</p>
          <h2>Opt-in reviewed learning loop</h2>
        </div>
        <DatabaseZap size={20} />
      </div>
      <div className="flywheel">
        {["Learner audio", "Teacher correction", "Scholar-approved examples", "Eval set", "Model release"].map((step) => (
          <span key={step}>{step}</span>
        ))}
      </div>
    </article>
  );
}

function BenchmarkCard({ metrics, loaded }: { metrics: BenchmarkMetric[]; loaded: boolean }) {
  return (
    <article className="command-card bottom-card">
      <div className="command-card-header compact">
        <div>
          <p>Model Ops</p>
          <h2>Release benchmarks</h2>
        </div>
        <Gauge size={20} />
      </div>
      <div className="benchmark-grid">
        {metrics.map((metric) => (
          <div className={`benchmark ${metric.status}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>Target {metric.target}</small>
          </div>
        ))}
        {loaded && metrics.length === 0 && (
          <p className="panel-empty">No eval run published for the current model.</p>
        )}
      </div>
    </article>
  );
}

function GovernanceCard({ agentRuns }: { agentRuns: AgentRunSummary[] }) {
  const coverage = agentRuns.length > 0 ? getSourceCoverage(agentRuns[0].sources) : "missing";
  return (
    <article className="command-card bottom-card">
      <div className="command-card-header compact">
        <div>
          <p>Trust governance</p>
          <h2>Religious safety controls</h2>
        </div>
        <LockKeyhole size={20} />
      </div>
      <div className="governance-grid">
        {governanceItems.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label}>
              <Icon size={17} />
              <strong>{item.label}</strong>
              <span>{item.status}</span>
            </div>
          );
        })}
      </div>
      <p className="source-line">
        Source coverage: {coverage} · canonical Quran text never machine-modified.
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

export function PlatformCompactHeader() {
  return (
    <div className="platform-compact-header">
      <BrandMark />
      <div>
        <strong>Quran AI</strong>
        <span>Canonical Quran text · human review · model telemetry</span>
      </div>
      <BadgeCheck size={18} />
      <AlertTriangle className="risk-icon" size={18} />
    </div>
  );
}
