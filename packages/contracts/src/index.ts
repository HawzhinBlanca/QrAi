export const SUPPORTED_LANGUAGE_CODES = ["ar", "ckb", "en", "tr", "ur", "id", "ms", "fr", "de"] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGE_CODES)[number];

export type ReviewStatus =
  | "draft"
  | "ai-suggested"
  | "teacher-review-required"
  | "teacher-reviewed"
  | "scholar-approved"
  | "blocked";

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
  // Server-side ML proxy: the browser calls these; platform-api forwards to ml-inference with the
  // server-held ML_API_KEY and the actor's authoritative tenant (never the client-supplied tenantId).
  { method: "POST", path: "/v1/ml/alignments:predict", transport: "http" },
  { method: "POST", path: "/v1/ml/tajweed-findings:predict", transport: "http" },
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
  "pilot_invitations",
  "pilot_sessions",
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

export const MODEL_COMPONENTS = [
  "asr",
  "forced-aligner",
  "quran-aligner",
  "acoustic-scorer",
  "calibrator",
] as const;

export const MODEL_ANALYSIS_BASES = ["acoustic", "quran-constrained", "text-rule"] as const;

export type ModelComponent = (typeof MODEL_COMPONENTS)[number];
export type ModelAnalysisBasis = (typeof MODEL_ANALYSIS_BASES)[number];
export type Sha256Digest = `sha256:${string}`;

export interface ActiveModelComponentAttribution {
  component: ModelComponent;
  status: "active";
  implementationId: string;
  artifactDigest: Sha256Digest;
  datasetVersion: string;
  analysisBasis: ModelAnalysisBasis;
  calibratorId: string | null;
}

export interface UnavailableModelComponentAttribution {
  component: ModelComponent;
  status: "unavailable";
  reason: string;
}

export type ModelComponentAttribution =
  | ActiveModelComponentAttribution
  | UnavailableModelComponentAttribution;

export interface ModelAttribution {
  schemaVersion: 1;
  primaryComponent: ModelComponent;
  components: ModelComponentAttribution[];
}

export interface ModelAttributionValidationOptions {
  expectedDigests?: Partial<Record<ModelComponent, Sha256Digest>>;
  legacyModelVersion?: string;
}

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isModelComponent(value: unknown): value is ModelComponent {
  return typeof value === "string" && (MODEL_COMPONENTS as readonly string[]).includes(value);
}

function isModelAnalysisBasis(value: unknown): value is ModelAnalysisBasis {
  return typeof value === "string" && (MODEL_ANALYSIS_BASES as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function modelAttributionError(message: string): never {
  throw new Error(`invalid model attribution: ${message}`);
}

/**
 * Validate model attribution at every runtime boundary.
 *
 * The validator deliberately does not infer, default, or rename a producer. Its output is the same
 * object it was given so callers can validate before forwarding or persisting without rewriting
 * provenance. The expected-digests option is the deployment/release allowlist; a producer cannot
 * authorize its own unexpected artifact merely by returning a well-formed digest.
 */
export function validateModelAttribution(
  value: unknown,
  options: ModelAttributionValidationOptions = {},
): ModelAttribution {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return modelAttributionError("value must be an object");
  }

  const attribution = value as Record<string, unknown>;
  if (attribution.schemaVersion !== 1) {
    return modelAttributionError("schemaVersion must be 1");
  }
  if (!isModelComponent(attribution.primaryComponent)) {
    return modelAttributionError(`unknown model component: ${String(attribution.primaryComponent)}`);
  }
  if (!Array.isArray(attribution.components) || attribution.components.length === 0) {
    return modelAttributionError("components must be a non-empty array");
  }

  const seen = new Set<ModelComponent>();
  const active = new Map<ModelComponent, ActiveModelComponentAttribution>();

  for (const raw of attribution.components) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return modelAttributionError("each component record must be an object");
    }
    const record = raw as Record<string, unknown>;
    if (!isModelComponent(record.component)) {
      return modelAttributionError(`unknown model component: ${String(record.component)}`);
    }
    if (seen.has(record.component)) {
      return modelAttributionError(`duplicate model component: ${record.component}`);
    }
    seen.add(record.component);

    if (record.status === "unavailable") {
      if (!isNonEmptyString(record.reason)) {
        return modelAttributionError(`unavailable component ${record.component} requires a reason`);
      }
      if ("artifactDigest" in record) {
        return modelAttributionError(
          `unavailable component ${record.component} cannot claim an artifact digest`,
        );
      }
      continue;
    }

    if (record.status !== "active") {
      return modelAttributionError(`component ${record.component} has an unknown status`);
    }
    if (!isNonEmptyString(record.implementationId)) {
      return modelAttributionError(`component ${record.component} requires implementationId`);
    }
    if (!isNonEmptyString(record.artifactDigest) || !SHA256_DIGEST_PATTERN.test(record.artifactDigest)) {
      return modelAttributionError(
        `component ${record.component} artifactDigest must be sha256 plus 64 lowercase hex characters`,
      );
    }
    if (!isNonEmptyString(record.datasetVersion)) {
      return modelAttributionError(`component ${record.component} requires datasetVersion`);
    }
    if (!isModelAnalysisBasis(record.analysisBasis)) {
      return modelAttributionError(`component ${record.component} has an unknown analysisBasis`);
    }
    if (
      record.calibratorId !== null &&
      (typeof record.calibratorId !== "string" || record.calibratorId.length === 0)
    ) {
      return modelAttributionError(`component ${record.component} has an invalid calibratorId`);
    }

    active.set(record.component, record as unknown as ActiveModelComponentAttribution);
  }

  const primary = active.get(attribution.primaryComponent);
  if (primary === undefined) {
    return modelAttributionError(
      `primary component ${attribution.primaryComponent} must be active`,
    );
  }

  for (const record of active.values()) {
    if (record.calibratorId === null) continue;
    const calibrator = active.get("calibrator");
    if (calibrator === undefined || calibrator.implementationId !== record.calibratorId) {
      return modelAttributionError(
        `component ${record.component} names an unavailable or mismatched calibrator`,
      );
    }
  }

  if (
    options.legacyModelVersion !== undefined &&
    options.legacyModelVersion !== primary.implementationId
  ) {
    return modelAttributionError(
      `modelVersion must equal the primary component implementationId ${primary.implementationId}`,
    );
  }

  if (options.expectedDigests !== undefined) {
    for (const [componentName, expectedDigest] of Object.entries(options.expectedDigests)) {
      if (!isModelComponent(componentName)) {
        return modelAttributionError(`unknown expected model component: ${componentName}`);
      }
      const record = active.get(componentName);
      if (record === undefined || record.artifactDigest !== expectedDigest) {
        return modelAttributionError(`artifact digest mismatch for ${componentName}`);
      }
    }
  }

  return value as ModelAttribution;
}

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
  recordingConsent: boolean;
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
  sourceId: "alquran-cloud" | "quran-foundation" | "tanzil";
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
  sourceId: "alquran-cloud" | "quran-foundation" | "tanzil";
  edition: string;
  scriptType: "uthmani" | "indopak" | "plain";
  importVersion: string;
  sourceChecksum: string;
}

export interface CanonicalSourceManifest {
  id: "alquran-cloud" | "quran-foundation" | "tanzil";
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
  auditEventId: string;
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
  startMs: number | null;
  endMs: number | null;
  status: "matched" | "misread" | "missed" | "extra" | "needs-review";
  transcriptSource?: "server-derived" | "client-reported";
  modelAttribution?: ModelAttribution | null;
  datasetVersion?: string | null;
  evidenceIds?: string[];
}

export interface RecognizedToken {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface AcousticLearnerEvidence {
  startMs: number;
  endMs: number;
  audioStatus: "available" | "discarded" | "not-captured" | "unknown";
  modelArtifactSha256: Sha256Digest;
  acousticDatasetVersion: string;
  acousticDatasetManifestSha256: Sha256Digest;
  calibratorId: string;
  calibratorArtifactSha256: Sha256Digest;
  calibrationStatus: "calibrated" | "uncalibrated";
  evaluationEvidenceId: string;
  evaluationEvidenceSha256: Sha256Digest;
  evaluationEvidenceStatus: "release-trusted" | "fixture" | "stale" | "unverified";
  withheld: boolean;
}

export interface TajweedFinding extends TraceableRecord, AcousticLearnerEvidence {
  id: string;
  wordId: string;
  rule: string;
  analysisBasis: "acoustic";
  severity: "practice" | "warning" | "critical";
  explanation: string;
  sources: SourceReference[];
}

export interface TajweedInstructionalAnnotation {
  id?: string;
  wordId: string;
  rule: string;
  arabicName?: string;
  category?: string;
  analysisBasis: "text-rule";
  instructional: true;
  explanation: string;
  sources: SourceReference[];
  tenantId: string;
  sourceChecksum: string;
  evidenceId: string;
  auditEventId: string;
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
  modelAttribution: ModelAttribution;
  finalizable: boolean;
  nonFinalizedReason: string | null;
  latencyMs: number;
  datasetVersion: string;
}

export interface TajweedPredictionResponse {
  tenantId: string;
  sessionId: string;
  quranRef: QuranReference;
  sourceChecksum: string;
  evidenceId: string;
  modelVersion: string;
  auditEventId: string;
  annotations: TajweedInstructionalAnnotation[];
  findings: TajweedFinding[];
  latencyMs: number;
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
  evaluationTask: "quran-word-alignment" | "acoustic-tajweed" | null;
  evidenceId: string | null;
  evidenceKind: "legacy-aggregate" | "row-level-computed-evaluation";
  evidenceEligibility: "fixture-regression" | "research-only" | "release-candidate";
  releaseEligible: boolean;
  evidencePayload: Record<string, unknown> | null;
  evidencePayloadSha256: string | null;
  candidateId: string | null;
  modelArtifactSha256: string | null;
  datasetManifestSha256: string | null;
  splitManifestSha256: string | null;
  splitId: string | null;
  evaluatorVersion: string | null;
  evaluatorSourceSha256: string | null;
  evaluatorProtocolSha256: string | null;
  rawRowManifestSha256: string | null;
  rawResultsSha256: string | null;
  calibratorId: string | null;
  calibratorArtifactSha256: string | null;
  signerKeyId: string | null;
  signatureAlgorithm: "Ed25519" | null;
  signatureBase64Url: string | null;
  signedAt: string | null;
  evaluationCounts: Record<string, unknown> | null;
  sliceMetrics: unknown[] | null;
}

/**
 * Output of the detached Ed25519 evidence verifier. The release gate accepts this separately from
 * the database projection so a caller-supplied `passed` boolean can never stand in for verified
 * row-level evidence.
 */
export interface ModelEvidenceVerification {
  cryptographicallyValid: true;
  evidence: Record<string, unknown>;
  evidenceId: string;
  keyId: string;
  payloadSha256: string;
  releaseTrusted: boolean;
  trustClass: "test-only" | "release";
  signatureAlgorithm: "Ed25519";
  signatureBase64Url: string;
  signedAt: string;
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
  return stableChecksum(canonicalWordPayload(record));
}

export function createCanonicalAyahChecksum(record: Omit<CanonicalAyahRecord, "sourceChecksum">): string {
  return stableChecksum(canonicalAyahPayload(record));
}

export function verifyCanonicalWord(record: CanonicalWordRecord): boolean {
  const { sourceChecksum, ...checksumInput } = record;
  // Accept both new sha256: and legacy fnv1a32: checksums.
  const expected = createCanonicalChecksum(checksumInput);
  if (expected === sourceChecksum) return true;
  // Fallback: check against legacy FNV-1a checksum for existing seed data.
  return legacyFnv1aChecksum(canonicalWordPayload(checksumInput)) === sourceChecksum;
}

export function verifyCanonicalAyah(record: CanonicalAyahRecord): boolean {
  const { sourceChecksum, ...checksumInput } = record;
  const expected = createCanonicalAyahChecksum(checksumInput);
  if (expected === sourceChecksum) return true;
  return legacyFnv1aChecksum(canonicalAyahPayload(checksumInput)) === sourceChecksum;
}

function canonicalWordPayload(record: Omit<CanonicalWordRecord, "sourceChecksum">): string {
  return [
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
}

function canonicalAyahPayload(record: Omit<CanonicalAyahRecord, "sourceChecksum">): string {
  return [
    record.id,
    record.quranRef.display,
    record.text,
    record.wordCount,
    record.sourceId,
    record.edition,
    record.scriptType,
    record.importVersion,
  ].join("|");
}

export function hasCanonicalTextChanged(before: CanonicalWordRecord, after: CanonicalWordRecord): boolean {
  return before.id !== after.id || before.text !== after.text || before.sourceChecksum !== after.sourceChecksum;
}

function hasCompleteAcousticLearnerEvidence(record: {
  withheld?: unknown;
  startMs?: unknown;
  endMs?: unknown;
  audioStatus?: unknown;
  evidenceId?: unknown;
  modelVersion?: unknown;
  modelArtifactSha256?: unknown;
  acousticDatasetVersion?: unknown;
  acousticDatasetManifestSha256?: unknown;
  calibratorId?: unknown;
  calibratorArtifactSha256?: unknown;
  calibrationStatus?: unknown;
  evaluationEvidenceId?: unknown;
  evaluationEvidenceSha256?: unknown;
  evaluationEvidenceStatus?: unknown;
  auditEventId?: unknown;
  sources: unknown;
}): boolean {
  const sources = Array.isArray(record.sources) ? record.sources : [];
  const validSources =
    sources.length > 0 &&
    sources.every(
      (source) =>
        source !== null &&
        typeof source === "object" &&
        isNonEmptyString((source as Record<string, unknown>).id) &&
        isNonEmptyString((source as Record<string, unknown>).title) &&
        isNonEmptyString((source as Record<string, unknown>).citation),
    );
  const validSpan =
    Number.isInteger(record.startMs) &&
    Number.isInteger(record.endMs) &&
    (record.startMs as number) >= 0 &&
    (record.endMs as number) > (record.startMs as number);
  const validIds = [
    record.evidenceId,
    record.modelVersion,
    record.acousticDatasetVersion,
    record.calibratorId,
    record.evaluationEvidenceId,
    record.auditEventId,
  ].every(isNonEmptyString);
  const validDigests = [
    record.modelArtifactSha256,
    record.acousticDatasetManifestSha256,
    record.calibratorArtifactSha256,
    record.evaluationEvidenceSha256,
  ].every((value) => typeof value === "string" && SHA256_DIGEST_PATTERN.test(value));

  return (
    record.withheld === false &&
    validSpan &&
    record.audioStatus === "available" &&
    validSources &&
    validIds &&
    validDigests &&
    record.calibrationStatus === "calibrated" &&
    record.evaluationEvidenceStatus === "release-trusted"
  );
}

export function canShowLearnerFacingAiOutput(
  record: Pick<AgentRun, "confidence" | "reviewStatus" | "sources"> & {
    analysisBasis?: ModelAnalysisBasis | "canonical-text";
    withheld?: unknown;
    startMs?: unknown;
    endMs?: unknown;
    audioStatus?: unknown;
    evidenceId?: unknown;
    modelVersion?: unknown;
    modelArtifactSha256?: unknown;
    acousticDatasetVersion?: unknown;
    acousticDatasetManifestSha256?: unknown;
    calibratorId?: unknown;
    calibratorArtifactSha256?: unknown;
    calibrationStatus?: unknown;
    evaluationEvidenceId?: unknown;
    evaluationEvidenceSha256?: unknown;
    evaluationEvidenceStatus?: unknown;
    auditEventId?: unknown;
  },
): boolean {
  const approved =
    record.reviewStatus === "teacher-reviewed" || record.reviewStatus === "scholar-approved";
  if (!approved || !Number.isFinite(record.confidence) || record.confidence < 0.82 || record.confidence > 1) {
    return false;
  }

  // Generic agent runs predate acoustic findings and have no analysisBasis. Preserve that separate
  // gate, while every explicit learner-performance record takes the complete acoustic path below.
  if (record.analysisBasis === undefined) {
    return Array.isArray(record.sources) && record.sources.length > 0;
  }
  if (record.analysisBasis !== "acoustic") {
    return false;
  }

  return hasCompleteAcousticLearnerEvidence(record);
}

/**
 * Codepoints that are mushaf ANNOTATION, not recited text: waqf (pause) signs, the end-of-ayah
 * marker, the rub'-el-hizb marker, and the sajdah marker.
 *
 * Written as explicit escapes, never literal characters — a literal-character class in
 * `forced_align.py` merged two ranges, deleted every Arabic letter, and passed review (PR #258).
 * See AGENTS.md's hard boundary on Arabic character classes.
 *
 * U+06D6..U+06DC  small high letters — waqf signs (pause permitted / compulsory / forbidden)
 * U+06DD          end of ayah
 * U+06DE          start of rub el hizb
 * U+06E9          place of sajdah
 *
 * NOT included: U+06DF..U+06E8 and U+06EA..U+06ED. Those are combining marks that live INSIDE a
 * word (superscript alef, small high/low marks); they are handled by the all-characters rule in
 * `isNonRecitedMark` rather than by listing them, because a word carrying one is still a word.
 */
const NON_RECITED_MARK_CODEPOINTS: ReadonlySet<number> = new Set([
  0x06d6, 0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06dd, 0x06de, 0x06e9,
]);

/**
 * True when a canonical word token is entirely mushaf annotation and therefore must never be
 * scored as recitation.
 *
 * 4,578 of the 82,456 tokens in `packages/quran-data` are standalone annotation symbols carrying
 * real word ids (`surah:ayah:index`) — measured across 89 of 114 surahs. Without this gate they are
 * rendered as scored word buttons and fed to the forced aligner, so a learner is marked "missed" on
 * a sajdah sign and the aligner is asked to find audio for a silent token, distorting that token's
 * span and every neighbour's.
 *
 * These tokens are deliberately NOT removed from the corpus: waqf signs tell a reciter where they
 * may, must, or must not pause, which is recitation instruction a learner needs to SEE. The fix is
 * to separate display from scoring, not to delete the marks. See
 * specs/canonical-corpus-marks/plan.md.
 *
 * Every character must be a mark. A real word that happens to carry a combining mark is still a
 * word and stays scored — the failure mode of a looser rule (e.g. "contains a mark") would be
 * silently dropping real words from scoring, which is worse than the bug being fixed.
 *
 * This value is metadata ABOUT a token, not part of its canonical identity: it must never enter
 * `canonicalWordPayload`, or every checksum after the first mark in an ayah changes and
 * `verifyCanonicalWord` fails across 89 surahs.
 */
export function isNonRecitedMark(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  let sawMark = false;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) {
      return false;
    }
    if (NON_RECITED_MARK_CODEPOINTS.has(cp)) {
      sawMark = true;
      continue;
    }
    // Whitespace is tolerated around a mark (the corpus has a few padded tokens) but cannot on its
    // own make a token a mark — otherwise " " would classify as annotation.
    if (/\s/u.test(char)) {
      continue;
    }
    return false;
  }
  return sawMark;
}

/**
 * Is this recording one we are OBLIGED to destroy?
 *
 * An ALLOWLIST of the two modes that permit keeping audio — not a denylist containing `"discard"`.
 * The two agree on every value in the vocabulary and differ on the one outside it, in the direction
 * that matters: `retention === "discard"` answers FALSE for a mode nobody recognises, which means
 * "you may keep it" for a child's recording held under a policy no one can state.
 *
 * `audio_retention` reaches this from a consent record and from a realtime ticket claim that
 * `services/shared-ticket` carries as a deliberately UNVALIDATED string, on the stated grounds that
 * an unknown value "can only shorten retention; it can never extend it". That is only true if every
 * consumer treats unknown as discard. `services/ml-inference`'s retention sweep always did — it
 * keeps `training-opt-in` forever, gives `teacher-review` its own TTL, and applies the discard TTL
 * to everything else. This function did not, and nothing had ever noticed, because it had no caller
 * and no case in the corpus had shown either implementation an out-of-vocabulary value.
 *
 * The parameter type says `AudioRetentionMode`, and that is not a guarantee: this value is
 * deserialized from JSON and read out of Postgres, so TypeScript's opinion of it is a compile-time
 * hope. The same reasoning as `canShowLearnerFacingAiOutput`'s status allowlist, which spells it out
 * at greater length.
 */
export function mustDiscardAudio(retention: AudioRetentionMode): boolean {
  return retention !== "teacher-review" && retention !== "training-opt-in";
}

export function canUseExternalAsr(consent: Pick<ConsentSnapshot, "externalAsrProcessing" | "guardianApproved">): boolean {
  return consent.externalAsrProcessing && consent.guardianApproved;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  const leftRecord = jsonRecord(left);
  const rightRecord = jsonRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function metricsClearReleaseGate(value: unknown, task: ModelEvalRun["evaluationTask"]): boolean {
  const metrics = jsonRecord(value);
  const operatingPoint = jsonRecord(metrics?.operatingPoint);
  if (
    !metrics ||
    !operatingPoint ||
    !finiteNumber(operatingPoint.precision) ||
    !finiteNumber(operatingPoint.f1) ||
    !finiteNumber(operatingPoint.falsePositiveRate) ||
    !finiteNumber(metrics.expectedCalibrationError) ||
    !finiteNumber(metrics.teacherAgreementRate)
  ) {
    return false;
  }
  const taskMetricPasses =
    task === "acoustic-tajweed"
      ? operatingPoint.precision >= 0.7 && operatingPoint.f1 >= 0.82
      : task === "quran-word-alignment" && operatingPoint.f1 >= 0.9;
  return (
    taskMetricPasses &&
    operatingPoint.falsePositiveRate <= 0.08 &&
    metrics.teacherAgreementRate >= 0.9 &&
    metrics.expectedCalibrationError >= 0 &&
    metrics.expectedCalibrationError <= 1
  );
}

/**
 * Fail-closed release authority. Every persisted projection must match the exact signed payload;
 * aggregate metrics, fixtures, test signers, or a caller-supplied `passed` flag are never enough.
 */
export function modelEvalPassesReleaseGate(
  evalRun: ModelEvalRun,
  verification?: ModelEvidenceVerification,
): boolean {
  if (
    !verification ||
    verification.cryptographicallyValid !== true ||
    verification.trustClass !== "release" ||
    verification.releaseTrusted !== true ||
    evalRun.passed !== true ||
    evalRun.evidenceKind !== "row-level-computed-evaluation" ||
    evalRun.evidenceEligibility !== "release-candidate" ||
    evalRun.releaseEligible !== true ||
    evalRun.signatureAlgorithm !== "Ed25519" ||
    evalRun.unsourcedLearnerOutputs !== 0
  ) {
    return false;
  }

  const evidence = jsonRecord(verification.evidence);
  const candidate = jsonRecord(evidence?.candidate);
  const dataset = jsonRecord(evidence?.dataset);
  const evaluator = jsonRecord(evidence?.evaluator);
  const rawResults = jsonRecord(evidence?.rawResults);
  const counts = jsonRecord(evidence?.counts);
  const uncertainty = jsonRecord(evidence?.uncertainty);
  const calibration = jsonRecord(evidence?.calibration);
  const slices = evidence?.slices;
  if (
    !evidence ||
    !candidate ||
    !dataset ||
    !evaluator ||
    !rawResults ||
    !counts ||
    !uncertainty ||
    !calibration ||
    !Array.isArray(slices)
  ) {
    return false;
  }

  if (
    evidence.evidenceId !== verification.evidenceId ||
    evidence.evidenceId !== evalRun.evidenceId ||
    evidence.evidenceKind !== evalRun.evidenceKind ||
    evidence.eligibility !== evalRun.evidenceEligibility ||
    evidence.evaluationTask !== evalRun.evaluationTask ||
    verification.keyId !== evalRun.signerKeyId ||
    verification.payloadSha256 !== evalRun.evidencePayloadSha256 ||
    verification.signatureAlgorithm !== evalRun.signatureAlgorithm ||
    verification.signatureBase64Url !== evalRun.signatureBase64Url ||
    verification.signedAt !== evalRun.signedAt ||
    !jsonValuesEqual(evidence, evalRun.evidencePayload) ||
    !jsonValuesEqual(counts, evalRun.evaluationCounts) ||
    !jsonValuesEqual(slices, evalRun.sliceMetrics)
  ) {
    return false;
  }

  if (
    candidate.candidateId !== evalRun.candidateId ||
    candidate.modelVersion !== evalRun.modelVersion ||
    candidate.modelArtifactSha256 !== evalRun.modelArtifactSha256 ||
    dataset.datasetVersion !== evalRun.datasetVersion ||
    dataset.manifestSha256 !== evalRun.datasetManifestSha256 ||
    dataset.splitManifestSha256 !== evalRun.splitManifestSha256 ||
    dataset.splitId !== evalRun.splitId ||
    evaluator.evaluatorVersion !== evalRun.evaluatorVersion ||
    evaluator.sourceSha256 !== evalRun.evaluatorSourceSha256 ||
    evaluator.protocolSha256 !== evalRun.evaluatorProtocolSha256 ||
    rawResults.rowManifestSha256 !== evalRun.rawRowManifestSha256 ||
    rawResults.rowResultsSha256 !== evalRun.rawResultsSha256 ||
    calibration.calibratorId !== evalRun.calibratorId ||
    calibration.artifactSha256 !== evalRun.calibratorArtifactSha256
  ) {
    return false;
  }

  if (
    !Number.isInteger(counts.rowCount) ||
    !Number.isInteger(counts.positiveCount) ||
    !Number.isInteger(counts.negativeCount) ||
    !Number.isInteger(counts.reciterCount) ||
    !Number.isInteger(counts.sourceBackedFindingCount) ||
    counts.rowCount !== (counts.positiveCount as number) + (counts.negativeCount as number) ||
    (counts.reciterCount as number) < 18 ||
    counts.unsourcedLearnerOutputCount !== 0 ||
    (evalRun.evaluationTask === "acoustic-tajweed" &&
      counts.sourceBackedFindingCount !== counts.rowCount) ||
    uncertainty.method !== "reciter-cluster-bootstrap" ||
    !Number.isInteger(uncertainty.replicateCount) ||
    (uncertainty.replicateCount as number) < 10_000
  ) {
    return false;
  }

  const intervals = uncertainty.intervals;
  if (
    !Array.isArray(intervals) ||
    intervals.length === 0 ||
    intervals.some((interval) => {
      const item = jsonRecord(interval);
      return (
        !item ||
        !Number.isInteger(item.validReplicateCount) ||
        (item.validReplicateCount as number) < 10_000
      );
    }) ||
    slices.length < 2 ||
    slices.some((slice) => {
      const item = jsonRecord(slice);
      return (
        !item ||
        !Number.isInteger(item.rowCount) ||
        !Number.isInteger(item.positiveCount) ||
        !Number.isInteger(item.negativeCount) ||
        !Number.isInteger(item.reciterCount) ||
        item.rowCount !== (item.positiveCount as number) + (item.negativeCount as number) ||
        (item.reciterCount as number) < 2 ||
        !metricsClearReleaseGate(item.metrics, evalRun.evaluationTask)
      );
    }) ||
    !metricsClearReleaseGate(evidence.metrics, evalRun.evaluationTask)
  ) {
    return false;
  }

  const metrics = jsonRecord(evidence.metrics);
  const operatingPoint = jsonRecord(metrics?.operatingPoint);
  if (!metrics || !operatingPoint) return false;
  const taskMetricMatches =
    evalRun.evaluationTask === "acoustic-tajweed"
      ? evalRun.tajweedF1 === operatingPoint.f1
      : evalRun.evaluationTask === "quran-word-alignment" &&
        evalRun.wordAlignmentF1 === operatingPoint.f1;
  return (
    taskMetricMatches &&
    evalRun.falsePositiveRate === operatingPoint.falsePositiveRate &&
    evalRun.teacherAgreementRate === metrics.teacherAgreementRate
  );
}

/**
 * SHA-256 checksum for new canonical data. Uses a pure-JS implementation
 * so it works in both Node.js and browser environments (the contracts
 * package is bundled into the web frontend). Returns `sha256:<hex>`.
 */
function stableChecksum(input: string): string {
  const hex = sha256Hex(input);
  return `sha256:${hex}`;
}

// ── Pure-JS SHA-256 (FIPS 180-4) ────────────────────────────────────────────
// No external dependencies; works synchronously in any JS runtime.

const K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// Exported so the primitive can be pinned against NIST known-answer vectors — a self-referential
// "checksum changes when text changes" test cannot catch a subtly-broken hash (it would just pin its
// own wrong output), and this underlies the canonical-content integrity checks.
export function sha256Hex(message: string): string {
  // UTF-8 encode
  const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  let bytes: Uint8Array;
  if (encoder) {
    bytes = encoder.encode(message);
  } else {
    // Fallback for environments without TextEncoder
    const buf = Buffer.from(message, "utf8");
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  // Pre-processing: pad to 512-bit blocks
  const bitLen = bytes.length * 8;
  const padLen = (bytes.length + 9 + 63) & ~63; // next multiple of 64
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // Big-endian 64-bit length at the end (we only use 32-bit since messages are small)
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 4, bitLen, false);

  // Initial hash values
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Int32Array(64);

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map(v => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Legacy FNV-1a 32-bit checksum for backward compatibility with existing seed data.
 * Returns `fnv1a32:<hex>`.
 */
function legacyFnv1aChecksum(input: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
