import { useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
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
  activeSession,
  agentRuns,
  alignments,
  benchmarkMetrics,
  governanceItems,
  memorizationPlan,
  platformApps,
  platformTabs,
  scholarApprovals,
  supportedLanguages,
  tajweedFindings,
  teacherReviews,
} from "../data/platform";
import { getQuranVerses } from "../data/quran";
import {
  createMockAlignmentEvent,
  getConfiguredRealtimeAudioUrl,
  startGatewayAudioUpload,
  startBrowserMicCapture,
  summarizeLiveCapture,
  type BrowserAudioChunk,
  type GatewayAudioAck,
  type GatewayUploader,
  type GatewayUploadStatus,
  type LiveAlignmentEvent,
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
  activeLanguage: SupportedLanguageCode;
  onLanguageChange: (language: SupportedLanguageCode) => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function PlatformCommand({
  activeLanguage,
  activeTab,
  onLanguageChange,
  onTabChange,
}: PlatformCommandProps) {
  const selectedLanguage = supportedLanguages.find((language) => language.code === activeLanguage) ?? supportedLanguages[0];
  const scholarSummary = summarizeScholarQueue(scholarApprovals);

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
            {activeSession.modelVersion}
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
        <LiveAlignmentCard selectedLanguage={selectedLanguage.nativeName} />
        <IntelligenceColumn />
        <OperationsColumn scholarSummary={scholarSummary} />
      </div>

      <div className="command-bottom-grid">
        <DataFlywheelCard />
        <BenchmarkCard />
        <GovernanceCard />
      </div>
    </section>
  );
}

function LiveAlignmentCard({ selectedLanguage }: { selectedLanguage: string }) {
  const captureRef = useRef<MicCaptureController | null>(null);
  const uploaderRef = useRef<GatewayUploader | null>(null);
  const [captureStatus, setCaptureStatus] = useState<MicCaptureStatus>("idle");
  const [captureError, setCaptureError] = useState("");
  const [gatewayStatus, setGatewayStatus] = useState<GatewayUploadStatus>("idle");
  const [gatewayError, setGatewayError] = useState("");
  const [gatewayAcks, setGatewayAcks] = useState<GatewayAudioAck[]>([]);
  const [audioChunks, setAudioChunks] = useState<BrowserAudioChunk[]>([]);
  const [alignmentEvents, setAlignmentEvents] = useState<LiveAlignmentEvent[]>([]);
  const liveSummary = summarizeLiveCapture(audioChunks, alignmentEvents);
  const liveAlignments = alignmentEvents.at(-1)?.alignments ?? alignments;
  const flaggedCount = liveAlignments.filter((alignment) => alignment.status !== "matched").length;
  const isRecording = captureStatus === "recording" || captureStatus === "requesting-permission";

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
    setAlignmentEvents([]);
    uploaderRef.current = startGatewayAudioUpload({
      url: getConfiguredRealtimeAudioUrl(activeSession.id),
      onStatusChange: setGatewayStatus,
      onAck: (ack) => setGatewayAcks((currentAcks) => [...currentAcks, ack]),
      onError: setGatewayError,
    });

    captureRef.current = await startBrowserMicCapture({
      sessionId: activeSession.id,
      sampleRate: 16000,
      chunkDurationMs: 480,
      onStatusChange: setCaptureStatus,
      onError: setCaptureError,
      onChunk: (chunk) => {
        uploaderRef.current?.sendChunk(chunk);
        setAudioChunks((currentChunks) => [...currentChunks, chunk]);
        setAlignmentEvents((currentEvents) => [
          ...currentEvents,
          createMockAlignmentEvent(activeSession, chunk, alignments),
        ]);
      },
    });
  }

  return (
    <article className="command-card live-card">
      <div className="command-card-header">
        <div>
          <p>Live alignment</p>
          <h2>{activeSession.surah} · {activeSession.ayahRange}</h2>
        </div>
        <span className="live-pill"><Radio size={14} /> {activeSession.latencyMs}ms</span>
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
              `${liveSummary.chunkCount} chunks · ${liveSummary.alignedWordCount} aligned words · ${
                liveSummary.latestLatencyMs || activeSession.latencyMs
              }ms latest`}
          </span>
        </div>
        <div className="gateway-state">
          <strong>Gateway {formatGatewayStatus(gatewayStatus)}</strong>
          <span>{gatewayError || `${gatewayAcks.filter((ack) => ack.accepted).length} accepted acks`}</span>
        </div>
      </div>

      <div className="session-meta-grid">
        <Metric label="Learner" value={activeSession.learnerName} />
        <Metric label="Language" value={selectedLanguage} />
        <Metric label="Consent" value={activeSession.consent.audioRetention.replace("-", " ")} />
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
        {liveAlignments.map((alignment) => (
          <div className={`alignment-row ${alignment.status}`} key={alignment.wordId}>
            <span dir="rtl" lang="ar">{alignment.canonicalText}</span>
            <small>{alignment.status.replace("-", " ")}</small>
            <strong>{Math.round(alignment.confidence * 100)}%</strong>
          </div>
        ))}
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

function IntelligenceColumn() {
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
                <small>{run.lastEvent}</small>
              </div>
              <span>{requiresHumanReview(run) ? "Review" : canShowLearnerFacingAnswer(run) ? "Safe" : "Blocked"}</span>
            </div>
          ))}
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
        </div>
      </article>
    </div>
  );
}

function OperationsColumn({ scholarSummary }: { scholarSummary: ReturnType<typeof summarizeScholarQueue> }) {
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
                <strong>{review.classroomName}</strong>
                <span>{review.teacherName}</span>
              </div>
              <dl>
                <div>
                  <dt>Pending</dt>
                  <dd>{review.pendingCount}</dd>
                </div>
                <div>
                  <dt>Agreement</dt>
                  <dd>{formatPercent(review.agreementRate)}</dd>
                </div>
              </dl>
            </div>
          ))}
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

function BenchmarkCard() {
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
        {benchmarkMetrics.map((metric) => (
          <div className={`benchmark ${metric.status}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>Target {metric.target}</small>
          </div>
        ))}
      </div>
    </article>
  );
}

function GovernanceCard() {
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
        Source coverage: {getSourceCoverage(agentRuns[0].sources)} · canonical Quran text never machine-modified.
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
