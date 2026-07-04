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

export function canShowLearnerFacingAiOutput(record: Pick<AgentRun | TajweedFinding, "confidence" | "reviewStatus" | "sources">): boolean {
  if (
    record.reviewStatus === "blocked" ||
    record.reviewStatus === "draft" ||
    record.reviewStatus === "ai-suggested" ||
    record.reviewStatus === "teacher-review-required"
  ) {
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

function sha256Hex(message: string): string {
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
