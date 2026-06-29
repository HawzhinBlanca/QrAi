export const SUPPORTED_LANGUAGE_CODES = ["ar", "ckb", "en", "tr", "ur", "id", "ms", "fr", "de"] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGE_CODES)[number];

export type ReviewStatus = "draft" | "ai-suggested" | "teacher-reviewed" | "scholar-approved" | "blocked";

export type AgentName =
  | "Recitation Coach"
  | "Tajweed Explainer"
  | "Memorization Planner"
  | "Teacher Copilot"
  | "Curriculum Builder"
  | "Localization Agent"
  | "Support Agent"
  | "Data QA Agent"
  | "Scholar Review Agent";

export type AudioRetentionMode = "discard" | "training-opt-in" | "teacher-review";

export type PracticeMode = "listen" | "guided-recite" | "memory-recite" | "correction" | "drill" | "complete";

export type EventSubject =
  | "recitation.session.started"
  | "recitation.realtime-ticket.issued"
  | "recitation.audio.chunked"
  | "recitation.alignment.partial"
  | "recitation.finding.created"
  | "ml.alignment.predicted"
  | "ml.tajweed.predicted"
  | "privacy.export.requested"
  | "privacy.delete.requested"
  | "privacy.external-asr.called"
  | "review.teacher.submitted"
  | "review.scholar.approved"
  | "model.eval.completed"
  | "audit.security.event";

export const EVENT_SUBJECTS: EventSubject[] = [
  "recitation.session.started",
  "recitation.realtime-ticket.issued",
  "recitation.audio.chunked",
  "recitation.alignment.partial",
  "recitation.finding.created",
  "ml.alignment.predicted",
  "ml.tajweed.predicted",
  "privacy.export.requested",
  "privacy.delete.requested",
  "privacy.external-asr.called",
  "review.teacher.submitted",
  "review.scholar.approved",
  "model.eval.completed",
  "audit.security.event",
];

export const PUBLIC_API_ROUTES = [
  { method: "POST", path: "/v1/recitation-sessions", transport: "http" },
  { method: "GET", path: "/v1/recitation-sessions/:id", transport: "http" },
  { method: "POST", path: "/v1/realtime-session-tickets", transport: "http" },
  { method: "WS", path: "/v1/recitation-sessions/:id/audio", transport: "websocket" },
  { method: "POST", path: "/v1/teacher-reviews", transport: "http" },
  { method: "GET", path: "/v1/teacher-review-queue", transport: "http" },
  { method: "POST", path: "/v1/scholar-approvals", transport: "http" },
  { method: "GET", path: "/v1/eval-runs/:modelVersion", transport: "http" },
  { method: "POST", path: "/v1/privacy/export", transport: "http" },
  { method: "POST", path: "/v1/privacy/delete", transport: "http" },
] as const;

export const CORE_TABLES = [
  "institutions",
  "users",
  "canonical_ayahs",
  "canonical_words",
  "recitation_sessions",
  "audio_chunks",
  "word_alignments",
  "tajweed_findings",
  "teacher_reviews",
  "scholar_approvals",
  "agent_runs",
  "audit_events",
  "model_versions",
  "eval_runs",
  "consent_records",
  "realtime_session_tickets",
  "privacy_jobs",
  "alignment_runs",
] as const;

export const PROOF_GATES = [
  "typescript-contract-tests",
  "rust-realtime-gateway-tests",
  "canonical-quran-checksums",
  "source-review-gates",
  "tenant-isolation-tests",
  "audio-retention-tests",
  "model-eval-regression-gates",
] as const;

export interface SourceReference {
  id: string;
  title: string;
  citation: string;
  url?: string;
}

export interface QuranReference {
  surahNumber: number;
  ayahStart: number;
  ayahEnd: number;
  wordStart?: number;
  wordEnd?: number;
  display: string;
}

export interface TraceableRecord {
  tenantId: string;
  quranRef: QuranReference;
  sourceChecksum: string;
  evidenceId: string;
  modelVersion: string;
  confidence: number;
  reviewStatus: ReviewStatus;
  createdBy: string;
  auditEventId: string;
}

export interface ConsentSnapshot {
  audioRetention: AudioRetentionMode;
  anonymizedLearning: boolean;
  externalAsrProcessing: boolean;
  guardianApproved: boolean;
  consentVersion: string;
}

export interface CanonicalWordRecord {
  id: string;
  quranRef: QuranReference;
  ayahId: string;
  wordIndex: number;
  text: string;
  sourceId: "quran-foundation" | "tanzil";
  edition: string;
  scriptType: "uthmani" | "indopak" | "plain";
  importVersion: string;
  sourceChecksum: string;
}

export interface CanonicalAyahRecord {
  id: string;
  quranRef: QuranReference;
  text: string;
  wordCount: number;
  sourceId: "quran-foundation" | "tanzil";
  edition: string;
  scriptType: "uthmani" | "indopak" | "plain";
  importVersion: string;
  sourceChecksum: string;
}

export interface CanonicalSourceManifest {
  id: "quran-foundation" | "tanzil";
  title: string;
  url: string;
  edition: string;
  scriptType: "uthmani" | "indopak" | "plain";
  importVersion: string;
}

export interface RecitationSession extends TraceableRecord {
  id: string;
  learnerId: string;
  learnerName: string;
  institutionId: string;
  surah: string;
  ayahRange: string;
  language: SupportedLanguageCode;
  mode: PracticeMode;
  practicePlanId: string;
  externalProcessingAllowed: boolean;
  startedAt: string;
  latencyMs: number;
  consent: ConsentSnapshot;
}

export interface RealtimeSessionTicket {
  sessionId: string;
  tenantId: string;
  learnerId: string;
  expiresAt: string;
  allowedSampleRates: Array<16000 | 24000 | 48000>;
  externalAsrProcessing: boolean;
  token: string;
}

export interface AudioChunk extends TraceableRecord {
  id: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  sampleRate: 16000 | 24000 | 48000;
  status: "queued" | "streaming" | "aligned" | "review-needed";
}

export interface WordAlignment extends TraceableRecord {
  wordId: string;
  canonicalText: string;
  heardText: string;
  startMs: number;
  endMs: number;
  status: "matched" | "misread" | "missed" | "extra" | "needs-review";
}

export interface TajweedFinding extends TraceableRecord {
  id: string;
  wordId: string;
  rule: string;
  severity: "practice" | "warning" | "critical";
  explanation: string;
  sources: SourceReference[];
}

export interface AlignmentPredictionRequest {
  tenantId: string;
  sessionId: string;
  quranRef: QuranReference;
  sourceChecksum: string;
  evidenceIds: string[];
  sampleRate: 16000 | 24000 | 48000;
  language: SupportedLanguageCode;
  consent: ConsentSnapshot;
}

export interface AlignmentPredictionResponse extends TraceableRecord {
  sessionId: string;
  alignments: WordAlignment[];
  latencyMs: number;
  datasetVersion: string;
}

export interface TajweedPredictionResponse extends TraceableRecord {
  sessionId: string;
  findings: TajweedFinding[];
  datasetVersion: string;
}

export interface ModelEvalRun {
  modelVersion: string;
  datasetVersion: string;
  wordAlignmentF1: number;
  tajweedF1: number;
  falsePositiveRate: number;
  teacherAgreementRate: number;
  unsourcedLearnerOutputs: number;
  passed: boolean;
}

export interface MemorizationPlan extends TraceableRecord {
  id: string;
  learnerId: string;
  horizonDays: number;
  currentFocus: string;
  nextReviewAt: string;
  intervals: Array<{
    label: string;
    dueCount: number;
    retention: number;
  }>;
}

export interface TeacherReview extends TraceableRecord {
  id: string;
  teacherName: string;
  classroomName: string;
  pendingCount: number;
  medianReviewMinutes: number;
  agreementRate: number;
}

export interface ScholarApproval extends TraceableRecord {
  id: string;
  topic: string;
  reviewer: string;
  status: Extract<ReviewStatus, "draft" | "scholar-approved" | "blocked">;
  risk: "low" | "medium" | "high";
  sourceCount: number;
}

export interface AgentRun extends TraceableRecord {
  id: string;
  name: AgentName;
  goal: string;
  status: "queued" | "running" | "needs-human-review" | "approved" | "blocked";
  sources: SourceReference[];
  lastEvent: string;
}

export interface BenchmarkMetric {
  label: string;
  value: string;
  target: string;
  status: "passing" | "watch" | "blocked";
}

export function createCanonicalChecksum(record: Omit<CanonicalWordRecord, "sourceChecksum">): string {
  const payload = [
    record.id,
    record.quranRef.display,
    record.ayahId,
    record.wordIndex,
    record.text,
    record.sourceId,
    record.edition,
    record.scriptType,
    record.importVersion,
  ].join("|");

  return stableChecksum(payload);
}

export function createCanonicalAyahChecksum(record: Omit<CanonicalAyahRecord, "sourceChecksum">): string {
  const payload = [
    record.id,
    record.quranRef.display,
    record.text,
    record.wordCount,
    record.sourceId,
    record.edition,
    record.scriptType,
    record.importVersion,
  ].join("|");

  return stableChecksum(payload);
}

export function verifyCanonicalWord(record: CanonicalWordRecord): boolean {
  const { sourceChecksum, ...checksumInput } = record;
  return createCanonicalChecksum(checksumInput) === sourceChecksum;
}

export function verifyCanonicalAyah(record: CanonicalAyahRecord): boolean {
  const { sourceChecksum, ...checksumInput } = record;
  return createCanonicalAyahChecksum(checksumInput) === sourceChecksum;
}

export function hasCanonicalTextChanged(before: CanonicalWordRecord, after: CanonicalWordRecord): boolean {
  return before.id !== after.id || before.text !== after.text || before.sourceChecksum !== after.sourceChecksum;
}

export function canShowLearnerFacingAiOutput(record: Pick<AgentRun | TajweedFinding, "confidence" | "reviewStatus" | "sources">): boolean {
  if (record.reviewStatus === "blocked" || record.reviewStatus === "draft" || record.reviewStatus === "ai-suggested") {
    return false;
  }

  return record.confidence >= 0.82 && record.sources.length > 0;
}

export function mustDiscardAudio(retention: AudioRetentionMode): boolean {
  return retention === "discard";
}

export function canUseExternalAsr(consent: Pick<ConsentSnapshot, "externalAsrProcessing" | "guardianApproved">): boolean {
  return consent.externalAsrProcessing && consent.guardianApproved;
}

export function modelEvalPassesReleaseGate(evalRun: ModelEvalRun): boolean {
  return (
    evalRun.wordAlignmentF1 >= 0.9 &&
    evalRun.tajweedF1 >= 0.82 &&
    evalRun.falsePositiveRate <= 0.08 &&
    evalRun.teacherAgreementRate >= 0.9 &&
    evalRun.unsourcedLearnerOutputs === 0 &&
    evalRun.passed
  );
}

function stableChecksum(input: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
