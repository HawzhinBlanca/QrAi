/**
 * Quran AI ML Inference Service
 *
 * Real Quran-constrained alignment + rule-based tajweed engine.
 * Replaces the fixture-based stub with actual algorithms.
 */

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, existsSync, writeFileSync, appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { readFile as readFileAsync, readdir as readdirAsync } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeArabic, similarity, alignWords, calculateConfidence } from "./alignment.js";
import { analyzeAyah, analyzeWord } from "./tajweed.js";
import {
  QURAN_ALIGNER_COMPONENT,
  mergeModelAttributions,
  quranAlignmentAttribution,
  validateModelAttribution,
} from "./model-attribution.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// True only when this file is the process entrypoint (node server.mjs), false when imported
// (e.g. by server.test.mjs). Every side effect — listen(), the cleanup timers, the signal
// handlers — is gated on this so importing the module for tests does not bind a port or start
// timers. (verify.sh notes the same footgun: a dir glob would import server.mjs, which listens.)
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  : false;

// Load golden eval fixtures for health endpoint + smoke tests
const FIXTURES_PATH = join(__dirname, "fixtures", "golden-evals.json");
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));

// Load full Quran data
const QURAN_DATA_DIR = join(__dirname, "..", "..", "packages", "quran-data", "src", "data", "full-quran");
const manifest = JSON.parse(readFileSync(join(QURAN_DATA_DIR, "manifest.json"), "utf8"));
const acousticCandidateManifest = JSON.parse(
  readFileSync(join(__dirname, "..", "asr-inference", "acoustic-candidates.json"), "utf8"),
);
const ACOUSTIC_CANDIDATE = acousticCandidateManifest.candidates?.find(
  (candidate) => candidate.id === acousticCandidateManifest.activeCandidateId,
);
if (
  acousticCandidateManifest.schemaVersion !== 1 ||
  ACOUSTIC_CANDIDATE?.status !== "shadow-only" ||
  ACOUSTIC_CANDIDATE?.releaseEligible !== false ||
  ACOUSTIC_CANDIDATE?.limits?.sampleRate !== 16_000 ||
  ACOUSTIC_CANDIDATE?.limits?.maxWindowMs !== 15_000
) {
  throw new Error("invalid acoustic shadow candidate manifest");
}

const ML_API_KEY = process.env.ML_API_KEY ?? "smoke-ml-api-key";

const MODEL_VERSION = QURAN_ALIGNER_COMPONENT.implementationId;
// Upper bound on words per alignment request (both canonical range and recognized text), bounding the
// O(m·n) alignment DP. Far above any real practice session (the web caps a session at 7 ayahs).
const MAX_ALIGN_WORDS = 1000;
const DATASET_VERSION = fixtures.datasetVersion;
const GOLDEN_CASE_IDS = fixtures.cases.map((c) => c.id);
// Golden fixtures are ONLY for smoke/regression. By default (flag unset) every request
// computes real alignment/tajweed — even for the golden refs like Al-Fatihah 1:1-7.
const USE_GOLDEN_FIXTURES = process.env.ML_USE_GOLDEN_FIXTURES === "1";

// ── Fixture output is a deliberate act, not a flag somebody set once (P3.2) ──────────────────────
//
// In fixture mode `predictAlignment` answers with `heardText: w.canonicalText, status: "matched"` —
// a FLAWLESS recitation that nobody performed. `predictTajweed` now strips fixture metrics and
// returns its rules only as non-performance instructional annotations; they cannot persist as
// learner findings. The alignment fixture is still evidence-shaped and therefore still requires
// the explicit operator acknowledgement below.
//
// The flag is genuinely needed, so it is not removed. It now requires a second variable whose NAME
// is the acknowledgement, so enabling it cannot be done absent-mindedly and shows up in review as
// what it is. Same shape as AUDIO_STORAGE_DRIVER above: refuse to start rather than do something an
// operator would not recognise from their config.
if (USE_GOLDEN_FIXTURES && process.env.ML_ACKNOWLEDGE_FIXTURE_OUTPUT !== "1") {
  throw new Error(
    "ML_USE_GOLDEN_FIXTURES=1 makes this service answer from fixtures instead of analysing " +
      "anything: alignments report a flawless recitation nobody performed. Tajweed fixture rules " +
      "are instructional only, but the alignment output remains evidence-shaped. " +
      "Set ML_ACKNOWLEDGE_FIXTURE_OUTPUT=1 alongside it to confirm that is intended. " +
      "Refusing to start rather than quietly producing evidence about recitations that never happened.",
  );
}
// === Audio storage abstraction ===
// Filesystem-only today. AUDIO_STORAGE_DRIVER exists so a future S3/MinIO backend has a place to
// hang off of, but until one is actually implemented, requesting it must fail loudly at startup —
// silently falling back to the filesystem while an operator believes audio is going to S3 would be
// a silent privacy/compliance gap (see docs/DATA_INVENTORY.md), not a graceful degradation.
const AUDIO_STORAGE_DRIVER = process.env.AUDIO_STORAGE_DRIVER ?? "filesystem";
if (AUDIO_STORAGE_DRIVER !== "filesystem") {
  throw new Error(
    `AUDIO_STORAGE_DRIVER=${AUDIO_STORAGE_DRIVER} is not implemented (only "filesystem" is supported). ` +
      `Refusing to start rather than silently store audio on the local filesystem while a different backend was requested.`,
  );
}
const AUDIO_STORAGE_DIR = process.env.AUDIO_STORAGE_DIR ?? join(__dirname, "audio-storage");

mkdirSync(AUDIO_STORAGE_DIR, { recursive: true });

// Durable audit log: one append-only JSONL file per tenant on the audio_storage volume (which the
// backup runbook already covers). Previously the audit trail lived only in an in-memory array —
// unbounded (a slow memory leak over a long-running process) AND lost entirely on restart, so a
// learner's privacy export could report zero external-ASR calls even if their audio was sent to ASR
// the day before (a compliance-grade data-loss window). Writing to disk fixes both (P3.3).
const AUDIT_LOG_DIR = join(AUDIO_STORAGE_DIR, "audit-log");
mkdirSync(AUDIT_LOG_DIR, { recursive: true });

const ASR_SERVICE_URL = process.env.ASR_SERVICE_URL ?? "http://127.0.0.1:8091";

// === Structured JSON Logger ===
// Outputs JSON lines to stdout (info) or stderr (warn/error) for production log aggregation.
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? 1;

function log(level, msg, data = {}) {
  if ((LOG_LEVELS[level] ?? 1) < currentLogLevel) return;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "ml-inference",
    msg,
    ...data,
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(entry + "\n");
  } else {
    process.stdout.write(entry + "\n");
  }
}

async function storeAudioObject(tenantId, learnerId, chunkId, audioBytes) {
  tenantId = safeStorageSegment(tenantId, "tenantId");
  learnerId = safeStorageSegment(learnerId, "learnerId");
  chunkId = safeStorageSegment(chunkId, "chunkId");
  const objectKey = `${tenantId}/${learnerId}/${chunkId}.bin`;
  const tenantDir = join(AUDIO_STORAGE_DIR, tenantId, learnerId);
  mkdirSync(tenantDir, { recursive: true });
  writeFileSync(join(tenantDir, `${chunkId}.bin`), audioBytes);
  return objectKey;
}

async function deleteAudioObjects(tenantId, learnerId) {
  tenantId = safeStorageSegment(tenantId, "tenantId");
  learnerId = safeStorageSegment(learnerId, "learnerId");
  const tenantDir = join(AUDIO_STORAGE_DIR, tenantId, learnerId);
  const deletedAudioObjectKeys = [];
  const deletedMetadataObjectKeys = [];
  if (existsSync(tenantDir)) {
    const { readdirSync, unlinkSync, rmdirSync } = await import("node:fs");
    const files = readdirSync(tenantDir);
    for (const file of files) {
      if (file.endsWith(".bin")) {
        unlinkSync(join(tenantDir, file));
        deletedAudioObjectKeys.push(`${tenantId}/${learnerId}/${file}`);
      } else if (file.endsWith(".meta.json")) {
        unlinkSync(join(tenantDir, file));
        deletedMetadataObjectKeys.push(`${tenantId}/${learnerId}/${file}`);
      }
    }
    try { rmdirSync(tenantDir); } catch {}
  }
  return { deletedAudioObjectKeys, deletedMetadataObjectKeys };
}

async function listAudioObjects(tenantId, learnerId) {
  tenantId = safeStorageSegment(tenantId, "tenantId");
  learnerId = safeStorageSegment(learnerId, "learnerId");
  const tenantDir = join(AUDIO_STORAGE_DIR, tenantId, learnerId);
  let audioObjectKeys = [];
  let metadataObjectKeys = [];
  if (existsSync(tenantDir)) {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(tenantDir);
    audioObjectKeys = files
      .filter((file) => file.endsWith(".bin"))
      .map((file) => `${tenantId}/${learnerId}/${file}`);
    metadataObjectKeys = files
      .filter((file) => file.endsWith(".meta.json"))
      .map((file) => `${tenantId}/${learnerId}/${file}`);
  }
  return { audioObjectKeys, metadataObjectKeys };
}

const deletionJobs = new Map();

// Path to a tenant's append-only audit JSONL, or null if the tenantId isn't a safe path segment
// (audit writes must never traverse the filesystem, and must never crash the request they audit).
function auditFileFor(tenantId) {
  if (typeof tenantId !== "string") return null;
  const t = tenantId.trim();
  if (
    !t ||
    t.length > 128 ||
    t === "." ||
    t === ".." ||
    t.includes("..") ||
    t.includes("/") ||
    t.includes("\\") ||
    t.includes("\0")
  ) {
    return null;
  }
  return join(AUDIT_LOG_DIR, `${t}.jsonl`);
}

// All audit events for a tenant, read from the durable JSONL. Empty for an unknown/invalid tenant.
// Malformed lines are skipped rather than throwing — one bad line must not hide the rest of the
// audit trail.
function readTenantAuditEvents(tenantId) {
  const file = auditFileFor(tenantId);
  if (!file || !existsSync(file)) return [];
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip a corrupt line
    }
  }
  return events;
}

// Load surah data cache
const surahCache = new Map();
function getSurah(surahNumber) {
  // Validate BEFORE touching the filesystem so an out-of-range reference is a 400, not a
  // 500 from readFileSync(ENOENT).
  if (!Number.isInteger(surahNumber) || surahNumber < 1 || surahNumber > 114) {
    throw httpError(400, `surahNumber must be an integer 1-114 (got ${surahNumber})`);
  }
  if (surahCache.has(surahNumber)) return surahCache.get(surahNumber);
  const fileName = `surah-${String(surahNumber).padStart(3, "0")}.json`;
  const data = JSON.parse(readFileSync(join(QURAN_DATA_DIR, fileName), "utf8"));
  surahCache.set(surahNumber, data);
  return data;
}

function getCanonicalWords(surahNumber, ayahStart, ayahEnd) {
  const surah = getSurah(surahNumber);
  if (
    !Number.isInteger(ayahStart) ||
    !Number.isInteger(ayahEnd) ||
    ayahStart < 1 ||
    ayahEnd < ayahStart ||
    ayahStart > surah.ayahs.length ||
    ayahEnd > surah.ayahs.length
  ) {
    throw httpError(
      400,
      `invalid ayah range ${ayahStart}-${ayahEnd} for surah ${surahNumber} (${surah.ayahs.length} ayahs)`,
    );
  }
  const words = [];
  for (const ayah of surah.ayahs) {
    if (ayah.ayahNumber >= ayahStart && ayah.ayahNumber <= ayahEnd) {
      for (let i = 0; i < ayah.words.length; i++) {
        const wordIndex = i + 1;
        words.push({
          id: `${ayah.surahNumber}:${ayah.ayahNumber}:${wordIndex}`,
          text: ayah.words[i],
        });
      }
    }
  }
  // Bound the O(m·n) alignment DP: a single practice request is far smaller (the web caps a session at
  // 7 ayahs). Without this a caller could ask for a whole surah/juz and block the handler for tens of
  // seconds. 1000 words is well above any real 7-ayah span but bounds the worst case to ~1s.
  if (words.length > MAX_ALIGN_WORDS) {
    throw httpError(
      400,
      `ayah range ${ayahStart}-${ayahEnd} spans ${words.length} words (max ${MAX_ALIGN_WORDS} per request); align a smaller range`,
    );
  }
  return words;
}

// NO CORS. This service is not a browser origin.
//
// It used to send `access-control-allow-origin: *` so the web app could call it directly — but that
// path was removed when the platform-api proxy (`/v1/ml/*`) was introduced precisely so `ML_API_KEY`
// stays server-side and never ships to a page. A wildcard CORS header on a service the browser must
// never call directly only invites the pattern back: it tells any origin that a cross-origin request
// here is welcome, and the only thing then missing is the key.
//
// Server-to-server callers (platform-api, the agents service) do not perform preflight and are
// unaffected. Kept as an empty object so the response-header spread sites need no branching.
const CORS_HEADERS = {};

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...CORS_HEADERS,
  });
  response.end(JSON.stringify(body));
}

function textResponse(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    ...CORS_HEADERS,
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) return;
      data += chunk;
      if (data.length > 5_000_000) {
        // Stop consuming, but do NOT destroy the socket: destroying it tears the connection down
        // before the request handler's .catch can write the 413, so the client sees a raw connection
        // reset (ECONNRESET) instead of a clean 413. Pause and reject; the 413 is then written on the
        // still-open socket.
        request.pause();
        settle(reject, httpError(413, "request body too large"));
      }
    });
    request.on("end", () => {
      if (!data.trim()) {
        settle(resolve, {});
        return;
      }
      try {
        const parsed = JSON.parse(data);
        settle(resolve, parsed);
      } catch {
        // Malformed JSON is a client error (400), not an internal failure (500).
        settle(reject, httpError(400, "request body is not valid JSON"));
      }
    });
    request.on("error", (err) => settle(reject, err));
  });
}

function appendAudit(tenantId, action, subjectId, details = {}) {
  const event = {
    id: `audit-${randomUUID()}`,
    tenantId,
    traceId: details.traceId ?? null,
    action,
    subjectType: action.startsWith("privacy.") ? "privacy" : "ml_prediction",
    subjectId,
    details,
    createdAt: new Date().toISOString(),
  };
  // Append durably (JSONL). Best-effort: an audit-write failure is logged but never throws — it
  // must not break the request being audited. The line is newline-terminated so appends compose.
  const file = auditFileFor(tenantId);
  if (file) {
    try {
      appendFileSync(file, `${JSON.stringify(event)}\n`);
    } catch (err) {
      console.error(`[audit] failed to persist event for tenant ${tenantId}: ${err.message}`);
    }
  } else {
    console.error(`[audit] refusing to persist event for unsafe tenantId: ${tenantId}`);
  }
  return event.id;
}

function extractTraceId(requestBody) {
  const traceId = requestBody.traceId ?? requestBody.trace_id ?? requestBody.smokeTraceId;
  return typeof traceId === "string" && traceId.trim() ? traceId.trim() : null;
}

function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw httpError(400, `${fieldName} is required`);
  }
  return value;
}

function safeStorageSegment(value, fieldName) {
  const segment = requiredString(value, fieldName);
  if (
    // Cap the length well under the filesystem's ~255-byte path-component limit. Without this, an
    // over-long (but otherwise valid-charset) id passed validation and only blew up at write time as
    // an uncaught ENAMETOOLONG — surfaced as a 500 that leaked the raw filesystem path. 128 leaves
    // room for the ".bin" / ".meta.json" suffixes this segment is joined with.
    segment.length > 128 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("..") ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(segment)
  ) {
    throw httpError(400, `${fieldName} must be a safe storage path segment`);
  }
  return segment;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// === ASR integration ===
async function transcribeAudio(audioBase64, audioFormat = "webm", language = "ar") {
  let response;
  try {
    response = await fetch(`${ASR_SERVICE_URL}/v1/transcribe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // ASR now requires an API key (like this service does). Server-to-server call, so the key
        // stays server-side; matches ASR_API_KEY on the ASR service (default dev key in dev/CI).
        "x-asr-api-key": process.env.ASR_API_KEY ?? "smoke-asr-api-key",
      },
      body: JSON.stringify({ audioBase64, audioFormat, language, wordTimestamps: true }),
    });
  } catch {
    throw httpError(502, "ASR service is unavailable");
  }
  if (!response.ok) {
    const text = await response.text();
    throw httpError(502, `ASR service failed: ${response.status} ${text}`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw httpError(502, "ASR service returned an invalid response");
  }
  try {
    validateModelAttribution(result?.modelAttribution, {
      legacyModelVersion: result?.modelVersion,
    });
  } catch {
    // Do not forward the bad object or its detail: an internal response is not trusted provenance,
    // and parsing errors can quote upstream transcript bytes.
    throw httpError(502, "ASR service returned invalid model attribution");
  }
  return result;
}

/**
 * The recited words from an ASR reply, whichever shape the loaded model speaks.
 *
 * Two shapes are both real and the service picks between them by `ASR_MODEL`:
 *
 *   openai-whisper       `words: [{word, start, end}, …]` plus `text`
 *   HF Quran fine-tune   `words: []`, the whole recitation in `text`
 *
 * The second is the PRODUCTION default (`tarteel-ai/whisper-base-ar-quran`; its 2022 checkpoint has
 * no timestamp config, which is why word timing comes from the separate /v1/force-align pass). Every
 * reader here used to take `.words` and nothing else, so on the default model a session transcribed
 * to zero words, `finalize_session` aligned that emptiness against the full passage, and a learner
 * who recited perfectly was recorded as having missed every word. Nothing failed and nothing logged.
 *
 * Segments win when present: deriving from `text` unconditionally would discard the boundaries the
 * whisper path does produce.
 *
 * ── Split, never normalise ──────────────────────────────────────────────────────────────────────
 * `text` is Quranic recitation. The split is on WHITESPACE RUNS and nothing else: no diacritic
 * stripping, no NFC/NFD, no tatweel removal, no case folding — every code point inside a word
 * crosses this function unchanged. Trimming first stops a leading space producing an empty first
 * "word", which the aligner would score as a real utterance the learner never made.
 */
function recognizedWordsFrom(asrResult) {
  const segments = asrResult?.words;
  if (Array.isArray(segments) && segments.length > 0) {
    return segments.map((w) => w.word);
  }
  const text = typeof asrResult?.text === "string" ? asrResult.text.trim() : "";
  return text === "" ? [] : text.split(/\s+/);
}

const ASR_WINDOW_CORE_SECONDS = 90;
const ASR_WINDOW_CONTEXT_SECONDS = 2;
const MAX_SESSION_WINDOWS = 20;
const ALLOWED_PCM_SAMPLE_RATES = new Set([16000, 24000, 48000]);

class SpanEvidenceError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "SpanEvidenceError";
    this.reason = reason;
  }
}

function spanEvidenceError(reason, message) {
  return new SpanEvidenceError(reason, message);
}

/**
 * Convert producer-owned word timing into the one session token shape.
 *
 * This function changes units only. It never normalizes, strips, or reconstructs Quran text. A
 * non-empty upstream `words` array is an evidence claim, so one malformed element invalidates the
 * whole array instead of being dropped or replaced from transcript text.
 */
export function recognizedTokensFrom(
  result,
  { offsetMs = 0, durationMs = Number.POSITIVE_INFINITY, confidenceField = "probability" } = {},
) {
  const words = result?.words;
  if (!Array.isArray(words)) {
    throw spanEvidenceError("invalid-recognized-spans", "word timing must be an array");
  }
  if (words.length === 0) return null;

  const tokens = [];
  let previousStartMs = -1;
  let previousEndMs = -1;
  for (const word of words) {
    const text = word?.word;
    const startSeconds = word?.start;
    const endSeconds = word?.end;
    const confidence = word?.[confidenceField];
    if (
      typeof text !== "string" || text.length === 0 ||
      !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
      startSeconds < 0 || endSeconds <= startSeconds ||
      !Number.isFinite(confidence) || confidence < 0 || confidence > 1
    ) {
      throw spanEvidenceError("invalid-recognized-spans", "word timing is malformed");
    }

    const localStartMs = Math.round(startSeconds * 1000);
    const localEndMs = Math.round(endSeconds * 1000);
    if (
      localEndMs <= localStartMs ||
      localStartMs < previousStartMs ||
      localEndMs < previousEndMs ||
      localEndMs > durationMs + 1000
    ) {
      throw spanEvidenceError("invalid-recognized-spans", "word timing is non-monotonic or out of bounds");
    }
    previousStartMs = localStartMs;
    previousEndMs = localEndMs;
    tokens.push({
      text,
      startMs: offsetMs + localStartMs,
      endMs: offsetMs + localEndMs,
      confidence,
    });
  }
  return tokens;
}

async function forceAlignRecognizedAudio(audioBase64, audioFormat, transcript) {
  let response;
  try {
    response = await fetch(`${ASR_SERVICE_URL}/v1/force-align`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-asr-api-key": process.env.ASR_API_KEY ?? "smoke-asr-api-key",
      },
      body: JSON.stringify({ audioBase64, audioFormat, transcript }),
    });
  } catch {
    throw spanEvidenceError("forced-alignment-unavailable", "forced alignment is unavailable");
  }
  if (!response.ok) {
    // Upstream detail may contain model paths or transcript bytes. The reason code is enough for
    // finalization and the service boundary must not echo the detail.
    throw spanEvidenceError("forced-alignment-unavailable", "forced alignment is unavailable");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw spanEvidenceError("forced-alignment-unavailable", "forced alignment response is invalid");
  }
  try {
    validateModelAttribution(result?.modelAttribution, {
      legacyModelVersion: result?.modelVersion,
    });
    if (result?.modelAttribution?.primaryComponent !== "forced-aligner") throw new Error("wrong component");
  } catch {
    throw spanEvidenceError("forced-alignment-unavailable", "forced alignment attribution is invalid");
  }
  return result;
}

/** Build context-bearing worker inputs whose cores partition the session exactly once. */
export function boundedPcmWindows(pcm, sampleRate) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) {
    throw spanEvidenceError("inconsistent-audio-format", "PCM16 audio must contain complete samples");
  }
  if (!ALLOWED_PCM_SAMPLE_RATES.has(sampleRate)) {
    throw spanEvidenceError("inconsistent-audio-format", "unsupported PCM sample rate");
  }

  const totalFrames = pcm.length / 2;
  const coreFrames = ASR_WINDOW_CORE_SECONDS * sampleRate;
  const contextFrames = ASR_WINDOW_CONTEXT_SECONDS * sampleRate;
  const windowCount = Math.ceil(totalFrames / coreFrames);
  if (windowCount > MAX_SESSION_WINDOWS) {
    throw spanEvidenceError("session-duration-limit", "session exceeds the bounded window limit");
  }

  const windows = [];
  for (let coreStartFrame = 0; coreStartFrame < totalFrames; coreStartFrame += coreFrames) {
    const coreEndFrame = Math.min(totalFrames, coreStartFrame + coreFrames);
    const contextStartFrame = Math.max(0, coreStartFrame - contextFrames);
    const contextEndFrame = Math.min(totalFrames, coreEndFrame + contextFrames);
    windows.push({
      pcm: pcm.subarray(contextStartFrame * 2, contextEndFrame * 2),
      offsetMs: Math.round((contextStartFrame * 1000) / sampleRate),
      durationMs: Math.round(((contextEndFrame - contextStartFrame) * 1000) / sampleRate),
      coreStartMs: Math.round((coreStartFrame * 1000) / sampleRate),
      coreEndMs: Math.round((coreEndFrame * 1000) / sampleRate),
      final: coreEndFrame === totalFrames,
    });
  }
  return windows;
}


/**
 * Cut a retained 16 kHz PCM timeline into reference-aware acoustic shadow windows.
 *
 * Only spans persisted by server finalization may enter this function. Every core word is owned by
 * exactly one window; neighbouring words may be included as context, but they are never promoted
 * into duplicate learner claims. Canonical bytes are copied verbatim and are never normalized.
 */
export function planAcousticWindows(pcm, sampleRate, segments, canonicalWords) {
  const MAX_WINDOW_MS = 15_000;
  const MAX_CORE_SPAN_MS = 13_000;
  const CONTEXT_MS = 1_000;
  if (sampleRate !== 16_000) {
    throw spanEvidenceError("unsupported-sample-rate", "acoustic shadow inference requires 16 kHz PCM");
  }
  if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) {
    throw spanEvidenceError("inconsistent-audio-format", "PCM16 audio must contain complete samples");
  }
  if (!Array.isArray(segments) || segments.length === 0 || !Array.isArray(canonicalWords)) {
    throw spanEvidenceError("invalid-server-derived-spans", "acoustic shadow inference requires measured word spans");
  }

  const durationMs = Math.floor((pcm.length / 2 * 1000) / sampleRate);
  const canonicalById = new Map();
  for (const word of canonicalWords) {
    if (
      word === null || typeof word !== "object" ||
      typeof word.id !== "string" || word.id === "" ||
      typeof word.text !== "string" || word.text === "" ||
      canonicalById.has(word.id)
    ) {
      throw spanEvidenceError("reference-mismatch", "canonical acoustic reference is invalid");
    }
    canonicalById.set(word.id, word.text);
  }

  const measured = [];
  const seen = new Set();
  let priorStartMs = -1;
  let priorEndMs = 0;
  for (const segment of segments) {
    const wordId = segment?.wordId;
    const startMs = segment?.startMs;
    const endMs = segment?.endMs;
    if (
      typeof wordId !== "string" || wordId === "" || seen.has(wordId) ||
      !canonicalById.has(wordId) ||
      !Number.isInteger(startMs) || !Number.isInteger(endMs) ||
      startMs < 0 || endMs <= startMs || endMs > durationMs ||
      startMs < priorStartMs || startMs < priorEndMs
    ) {
      throw spanEvidenceError("invalid-server-derived-spans", "acoustic word spans are invalid");
    }
    seen.add(wordId);
    measured.push({
      wordId,
      canonicalText: canonicalById.get(wordId),
      startMs,
      endMs,
    });
    priorStartMs = startMs;
    priorEndMs = endMs;
  }

  const coreGroups = [];
  for (let index = 0; index < measured.length;) {
    const group = [measured[index]];
    let cursor = index + 1;
    while (
      cursor < measured.length &&
      measured[cursor].endMs - group[0].startMs <= MAX_CORE_SPAN_MS
    ) {
      group.push(measured[cursor]);
      cursor += 1;
    }
    coreGroups.push(group);
    index = cursor;
  }

  return coreGroups.map((core) => {
    const coreStartMs = core[0].startMs;
    const coreEndMs = core.at(-1).endMs;
    let windowStartMs = Math.max(0, coreStartMs - CONTEXT_MS);
    let windowEndMs = Math.min(durationMs, coreEndMs + CONTEXT_MS);
    if (windowEndMs - windowStartMs > MAX_WINDOW_MS) {
      const leftContext = Math.min(CONTEXT_MS, coreStartMs);
      windowStartMs = coreStartMs - leftContext;
      windowEndMs = Math.min(durationMs, windowStartMs + MAX_WINDOW_MS);
      if (windowEndMs < coreEndMs) {
        windowEndMs = coreEndMs;
        windowStartMs = Math.max(0, windowEndMs - MAX_WINDOW_MS);
      }
    }

    // A context word is useful only when the complete measured span is present. Including a word
    // that merely overlaps an edge would pair a full canonical reference with truncated audio and
    // would also create a negative/out-of-window span at the Python boundary.
    const context = measured.filter(
      (segment) => segment.startMs >= windowStartMs && segment.endMs <= windowEndMs,
    );
    const startFrame = Math.floor(windowStartMs * sampleRate / 1000);
    const endFrame = Math.ceil(windowEndMs * sampleRate / 1000);
    const actualStartMs = Math.round(startFrame * 1000 / sampleRate);
    const actualEndMs = Math.round(endFrame * 1000 / sampleRate);
    const windowPcm = pcm.subarray(startFrame * 2, endFrame * 2);
    if (windowPcm.length === 0 || actualEndMs - actualStartMs > MAX_WINDOW_MS) {
      throw spanEvidenceError("window-duration-limit", "acoustic window exceeds 15 seconds");
    }

    return {
      pcm: windowPcm,
      sampleRate,
      durationMs: actualEndMs - actualStartMs,
      offsetMs: actualStartMs,
      referenceText: context.map((segment) => segment.canonicalText).join(" "),
      segments: context.map((segment) => ({
        wordId: segment.wordId,
        canonicalText: segment.canonicalText,
        startMs: segment.startMs - actualStartMs,
        endMs: segment.endMs - actualStartMs,
      })),
      coreWordIds: core.map((segment) => segment.wordId),
    };
  });
}


function acousticShadowRefusal(reason, { windowCount = 0 } = {}) {
  return {
    status: "refused",
    candidateId: null,
    qpsProfileId: null,
    modelVersion: null,
    observationCount: 0,
    windowCount,
    refusalReason: reason,
  };
}

function containsConfidenceClaim(value) {
  if (Array.isArray(value)) return value.some(containsConfidenceClaim);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) => key === "confidence" || containsConfidenceClaim(nested),
  );
}

function validateAcousticObservationResponse(value, expectedCoreWordIds) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid acoustic response");
  }
  if (value.status === "refused" || value.status === "unavailable") {
    if (
      !Array.isArray(value.observations) || value.observations.length !== 0 ||
      typeof value.refusalReason !== "string" || value.refusalReason === ""
    ) {
      throw new Error("invalid acoustic refusal");
    }
    return value;
  }
  if (
    value.status !== "observed" ||
    value.candidateId !== ACOUSTIC_CANDIDATE.id ||
    value.qpsProfileId !== ACOUSTIC_CANDIDATE.qps.profileId ||
    value.qpsProfileChecksum !== ACOUSTIC_CANDIDATE.qps.profileChecksum ||
    !Array.isArray(value.observations) ||
    value.observations.length === 0
  ) {
    throw new Error("invalid acoustic observation");
  }
  validateModelAttribution(value.modelAttribution, { legacyModelVersion: value.modelVersion });
  const active = value.modelAttribution.components.find(
    (component) =>
      component.component === "acoustic-scorer" &&
      component.status === "active",
  );
  if (
    value.modelAttribution.primaryComponent !== "acoustic-scorer" ||
    active?.artifactDigest !== ACOUSTIC_CANDIDATE.model.artifactSha256 ||
    active?.datasetVersion !== ACOUSTIC_CANDIDATE.model.trainingDataset ||
    active?.calibratorId !== null
  ) {
    throw new Error("acoustic observation attribution mismatch");
  }
  const expected = JSON.stringify(expectedCoreWordIds);
  for (const observation of value.observations) {
    if (
      observation === null || typeof observation !== "object" || Array.isArray(observation) ||
      observation.analysisBasis !== "acoustic" ||
      observation.calibrationStatus !== "uncalibrated" ||
      JSON.stringify(observation.coreWordIds) !== expected ||
      !/^sha256:[a-f0-9]{64}$/.test(observation.referenceDigest ?? "") ||
      containsConfidenceClaim(observation)
    ) {
      throw new Error("invalid uncalibrated acoustic observation");
    }
  }
  return value;
}

async function observeAcousticWindow(window) {
  let response;
  try {
    response = await fetch(`${ASR_SERVICE_URL}/v1/acoustic-tajweed:observe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-asr-api-key": process.env.ASR_API_KEY ?? "smoke-asr-api-key",
      },
      body: JSON.stringify({
        audioBase64: wavFromPcm16(window.pcm, window.sampleRate).toString("base64"),
        audioFormat: "wav",
        sampleRate: window.sampleRate,
        durationMs: window.durationMs,
        referenceText: window.referenceText,
        segments: window.segments,
        coreWordIds: window.coreWordIds,
      }),
    });
  } catch {
    return { status: "unavailable", observations: [], refusalReason: "acoustic-worker-unavailable" };
  }
  if (!response.ok) {
    return { status: "unavailable", observations: [], refusalReason: "acoustic-worker-unavailable" };
  }
  try {
    return validateAcousticObservationResponse(await response.json(), window.coreWordIds);
  } catch {
    return { status: "unavailable", observations: [], refusalReason: "invalid-acoustic-response" };
  }
}

async function runAcousticShadow(requestBody, canonicalWords) {
  const consent = requestBody.consent ?? {};
  if (
    !(consent.externalAsrProcessing ?? false) ||
    !(consent.guardianApproved ?? false)
  ) {
    return acousticShadowRefusal("consent-revoked-or-insufficient");
  }
  if (!Array.isArray(requestBody.acousticSegments) || requestBody.acousticSegments.length === 0) {
    return acousticShadowRefusal("no-server-derived-spans");
  }

  const audio = await loadSessionPcm({
    tenantId: requestBody.tenantId,
    learnerId: requestBody.learnerId,
    sessionId: requestBody.sessionId,
    traceId: extractTraceId(requestBody),
  });
  if (!audio.loaded) return acousticShadowRefusal(audio.reason);

  let windows;
  try {
    windows = planAcousticWindows(
      audio.pcm,
      audio.sampleRate,
      requestBody.acousticSegments,
      canonicalWords,
    );
  } catch (error) {
    if (error instanceof SpanEvidenceError) return acousticShadowRefusal(error.reason);
    throw error;
  }

  let observationCount = 0;
  let modelVersion = null;
  for (const window of windows) {
    const response = await observeAcousticWindow(window);
    if (response.status !== "observed") {
      return acousticShadowRefusal(response.refusalReason, { windowCount: windows.length });
    }
    if (modelVersion !== null && response.modelVersion !== modelVersion) {
      return acousticShadowRefusal("inconsistent-acoustic-attribution", {
        windowCount: windows.length,
      });
    }
    modelVersion = response.modelVersion;
    observationCount += response.observations.length;
  }

  return {
    status: "observed",
    candidateId: ACOUSTIC_CANDIDATE.id,
    qpsProfileId: ACOUSTIC_CANDIDATE.qps.profileId,
    modelVersion,
    observationCount,
    windowCount: windows.length,
    refusalReason: null,
  };
}

/**
 * Validate the only request shape that may become persisted audio evidence.
 *
 * This does not trim or normalize token text. It checks structure, bounds, and ordering while
 * preserving the producer's exact bytes. Public API proxies reject this field; the transitional
 * finalizer reaches this internal keyed endpoint only after fetching the tokens server-to-server
 * from `transcribeSession`.
 */
function measuredRecognizedTokens(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ALIGN_WORDS) {
    return { valid: false, tokens: [], reason: "invalid-recognized-spans" };
  }

  const tokens = [];
  let previousStartMs = -1;
  let previousEndMs = -1;
  for (const token of value) {
    const text = token?.text;
    const startMs = token?.startMs;
    const endMs = token?.endMs;
    const confidence = token?.confidence;
    if (
      token === null || typeof token !== "object" || Array.isArray(token) ||
      typeof text !== "string" || text.length === 0 || /\s/u.test(text) ||
      !Number.isInteger(startMs) || !Number.isInteger(endMs) ||
      startMs < 0 || endMs <= startMs || endMs > 2147483647 ||
      startMs < previousStartMs || endMs < previousEndMs ||
      !Number.isFinite(confidence) || confidence < 0 || confidence > 1
    ) {
      return { valid: false, tokens: [], reason: "invalid-recognized-spans" };
    }
    previousStartMs = startMs;
    previousEndMs = endMs;
    tokens.push({ text, startMs, endMs, confidence });
  }
  return { valid: true, tokens, reason: null };
}

// === Real alignment prediction ===
async function predictAlignment(requestBody) {
  if (Object.hasOwn(requestBody, "modelVersion") || Object.hasOwn(requestBody, "modelAttribution")) {
    throw httpError(400, "model identity is server-selected and must not be supplied");
  }
  const startedAt = performance.now();
  const traceId = extractTraceId(requestBody);
  const tenantId = requiredString(requestBody.tenantId, "tenantId");
  const sessionId = requiredString(requestBody.sessionId, "sessionId");

  const quranRef = requestBody.quranRef ?? {
    surahNumber: 1,
    ayahStart: 1,
    ayahEnd: 7,
    display: "Al-Fatihah 1:1-7",
  };

  const sourceChecksum = requestBody.sourceChecksum ?? "fnv1a32:real";

  // Consent-gated external ASR
  const consent = requestBody.consent ?? {};
  const externalAsrRequested = requestBody.externalAsrRequested ?? false;
  const guardianApproved = consent.guardianApproved ?? false;
  const consentExternalAsr = consent.externalAsrProcessing ?? false;
  const asrAllowed = externalAsrRequested && consentExternalAsr && guardianApproved;
  const childProfile = requestBody.profileKind === "child";
  // The SINGLE authority for whether this request may send audio to the ASR service. Used both to
  // decide the audit event below AND to gate the actual transcribe call, so the two can never
  // diverge (they used to: the transcribe fired on `audioBase64` presence alone, so a child-profile
  // request with guardianApproved=false was audited "external-asr.denied" yet still shipped the
  // child's audio to Whisper). `asrAllowed` already requires guardianApproved, so the child clause
  // is belt-and-suspenders.
  const asrActuallyAllowed = asrAllowed && (!childProfile || guardianApproved);

  let externalAsr;
  if (asrAllowed && !childProfile) {
    externalAsr = { called: true, reason: "consent-granted" };
    appendAudit(tenantId, "privacy.external-asr.called", sessionId, { traceId, reason: "consent-granted" });
  } else if (asrAllowed && childProfile && guardianApproved) {
    externalAsr = { called: true, reason: "child-profile-guardian-approved" };
    appendAudit(tenantId, "privacy.external-asr.called", sessionId, { traceId, reason: "child-profile-guardian-approved" });
  } else if (externalAsrRequested && childProfile && !guardianApproved) {
    externalAsr = { called: false, reason: "child-profile-no-guardian-consent" };
    appendAudit(tenantId, "privacy.external-asr.denied", sessionId, { traceId, reason: "child-profile-no-guardian-consent" });
  } else if (externalAsrRequested && !asrAllowed) {
    externalAsr = { called: false, reason: "consent-revoked-or-insufficient" };
    appendAudit(tenantId, "privacy.external-asr.denied", sessionId, { traceId, reason: "consent-revoked-or-insufficient" });
  } else {
    externalAsr = { called: false, reason: "not-requested" };
  }

  // Check for golden fixture match
  const fixtureCase = fixtures.cases.find(
    (c) => c.quranRef.surahNumber === quranRef.surahNumber &&
           c.quranRef.ayahStart === quranRef.ayahStart &&
           c.quranRef.ayahEnd === quranRef.ayahEnd,
  );

  const evidenceId = `evidence-${randomUUID()}`;

  // The audit event is appended AFTER the branch below so the recorded confidence/word counts
  // reflect what this request ACTUALLY computed (real alignment vs golden fixture), not the fixture
  // values regardless of path. With ML_USE_GOLDEN_FIXTURES unset (the default) the golden ref still
  // matches `fixtureCase` here, but the REAL path runs — previously the audit logged the fixture's
  // 0.94 confidence / 8-word counts while the response returned the real confidence over the real
  // (29-word) canonical set, so the audit trail contradicted the prediction it claimed to describe.
  let alignments;
  let confidence;
  let reviewStatus;
  let wordCount;
  let recognizedCount;
  let upstreamModelAttribution = null;
  let finalizable = false;
  let nonFinalizedReason = "no-recognized-evidence";

  if (fixtureCase && USE_GOLDEN_FIXTURES) {
    // Return golden fixture alignment data
    confidence = asrActuallyAllowed ? fixtureCase.alignment.confidence : fixtureCase.alignment.fallbackConfidence;
    reviewStatus = !asrActuallyAllowed
      ? "teacher-review-required"
      : confidence >= 0.85 ? "ai-suggested" : "teacher-review-required";
    wordCount = fixtureCase.alignment.words.length;
    recognizedCount = fixtureCase.alignment.words.length;

    alignments = fixtureCase.alignment.words.map((w) => ({
      wordId: w.wordId,
      canonicalText: w.canonicalText,
      heardText: w.canonicalText,
      startMs: null,
      endMs: null,
      status: "matched",
      confidence: confidence,
      reviewStatus,
      tenantId,
      quranRef,
      sourceChecksum,
      evidenceId,
      modelVersion: MODEL_VERSION,
      traceId,
    }));
    // Declared eval fixtures exercise response plumbing. They are not a learner's measured audio
    // and cannot be upgraded into persistable evidence by carrying fixture timestamps.
    finalizable = false;
    nonFinalizedReason = "declared-fixture-is-not-span-evidence";
  } else {
    // Get canonical words for the requested ayah range
    const canonicalWords = getCanonicalWords(quranRef.surahNumber, quranRef.ayahStart, quranRef.ayahEnd);

    // Get recognized text: from ASR (audio), from the caller, or NOTHING.
    //
    // ── The fallback used to invent a perfect recitation ─────────────────────────────────────────
    // This branch previously ended `recognizedWords = canonicalWords.map(w => w.text)` — aligning
    // the canonical text against ITSELF. Measured against the running service, a learner who
    // declined external-ASR consent got back `status: "matched"`, `confidence: 1`, and
    // `heardText` equal to the canonical text for EVERY word: a claim that they recited the Qur'an
    // perfectly, about audio nobody listened to.
    //
    // `apps/web` persists alignments unconditionally, and `word_alignments` has no `reviewStatus`
    // column, so the `teacher-review-required` flag set below was dropped on the way to the
    // database. What remained was a stored record of a flawless recitation that never happened —
    // and, since findings anchor to alignments, a teacher's review queue built on top of it.
    //
    // There is no honest alignment without recognition. `needs-review` (an existing
    // `word_alignments.status` value) is what "we did not hear this word" looks like.
    let recognizedWords;
    let asrResult = null;
    let recognized = true;
    if (Object.hasOwn(requestBody, "recognizedTokens")) {
      const measured = measuredRecognizedTokens(requestBody.recognizedTokens);
      let transcriptAttribution = null;
      let attributionReason = null;
      if (!Object.hasOwn(requestBody, "transcriptModelAttribution")) {
        attributionReason = "missing-transcript-attribution";
      } else {
        try {
          transcriptAttribution = validateModelAttribution(requestBody.transcriptModelAttribution);
          if (transcriptAttribution.primaryComponent !== "asr") {
            attributionReason = "invalid-transcript-attribution";
            transcriptAttribution = null;
          }
        } catch {
          attributionReason = "invalid-transcript-attribution";
        }
      }
      if (measured.valid && transcriptAttribution !== null) {
        recognizedWords = measured.tokens;
        upstreamModelAttribution = transcriptAttribution;
        finalizable = true;
        nonFinalizedReason = null;
      } else {
        // One bad token invalidates the whole evidence set. Aligning a valid prefix would turn a
        // partial transcript into claims about the rest of the recitation. Measured timings with
        // no producer identity are equally non-finalizable: a span alone cannot say which model
        // authored the recognized word.
        recognizedWords = [];
        recognized = false;
        finalizable = false;
        nonFinalizedReason = measured.valid ? attributionReason : measured.reason;
      }
    } else if (requestBody.audioBase64 && asrActuallyAllowed) {
      // Real acoustic ASR: send audio to Whisper service — ONLY when consent (and, for a child
      // profile, guardian approval) actually permits it. Without this gate the audio was sent
      // regardless of the consent decision recorded above. When not allowed, we fall through to the
      // recognizedText / canonical path below and the audio is never processed.
      asrResult = await transcribeAudio(requestBody.audioBase64, requestBody.audioFormat ?? "webm", "ar");
      upstreamModelAttribution = asrResult.modelAttribution;
      try {
        const measured = recognizedTokensFrom(asrResult);
        if (measured === null) {
          recognizedWords = recognizedWordsFrom(asrResult);
          recognized = recognizedWords.length > 0;
          nonFinalizedReason = recognized
            ? "recognized-text-is-not-span-evidence"
            : "no-recognized-speech";
        } else {
          recognizedWords = measured;
          finalizable = true;
          nonFinalizedReason = null;
        }
      } catch (error) {
        if (!(error instanceof SpanEvidenceError)) throw error;
        recognizedWords = [];
        recognized = false;
        nonFinalizedReason = error.reason;
      }
    } else if (requestBody.recognizedText && Array.isArray(requestBody.recognizedText)) {
      // Every element must be a string; a non-string would throw inside alignWords and
      // surface as a 500. Bad input is a 400.
      if (!requestBody.recognizedText.every((w) => typeof w === "string")) {
        throw httpError(400, "recognizedText must be an array of strings");
      }
      recognizedWords = requestBody.recognizedText;
      recognized = recognizedWords.length > 0;
      nonFinalizedReason = recognized
        ? "recognized-text-is-not-span-evidence"
        : "no-recognized-speech";
    } else if (requestBody.recognizedTextString) {
      // Guard the type: a truthy non-string (number, object, array) would throw a
      // TypeError on .trim() and surface as a 500. Bad input is a 400.
      if (typeof requestBody.recognizedTextString !== "string") {
        throw httpError(400, "recognizedTextString must be a string");
      }
      const text = requestBody.recognizedTextString.trim();
      recognizedWords = text === "" ? [] : text.split(/\s+/);
      recognized = recognizedWords.length > 0;
      nonFinalizedReason = recognized
        ? "recognized-text-is-not-span-evidence"
        : "no-recognized-speech";
    } else {
      recognizedWords = [];
      recognized = false;
    }

    // Bound the recognized side of the O(m·n) alignment DP too (the canonical side is capped in
    // getCanonicalWords). Prevents a huge recognizedText from blocking the handler.
    if (recognizedWords.length > MAX_ALIGN_WORDS) {
      throw httpError(
        400,
        `recognizedText has ${recognizedWords.length} words (max ${MAX_ALIGN_WORDS} per request)`,
      );
    }

    // Not `alignWords(canonical, [])`: that reports every word as `missed`, which is also a claim
    // about the recitation — "they left these out" — and equally unfounded when nothing was heard.
    const alignmentResults = recognized
      ? alignWords(canonicalWords, recognizedWords)
      : canonicalWords.map((w) => ({
          wordId: w.id,
          canonicalText: w.text,
          heardText: "",
          startMs: null,
          endMs: null,
          status: "needs-review",
          confidence: 0,
        }));
    // Not `calculateConfidence` when nothing was recognised: its weights describe how well
    // RECOGNISED words matched, and `needs-review` carries 0.8 there — "the recogniser was unsure
    // about this word", not "nobody listened to this recitation". Run through it, a session with no
    // recognition at all scores 0.8, a whisker under the 0.85 auto-accept line.
    confidence = recognized ? calculateConfidence(alignmentResults) : 0;
    reviewStatus = !asrAllowed
      ? "teacher-review-required"
      : confidence >= 0.85 ? "ai-suggested" : "teacher-review-required";
    wordCount = canonicalWords.length;
    recognizedCount = recognizedWords.length;

    alignments = alignmentResults.map((r) => ({
      wordId: r.wordId,
      canonicalText: r.canonicalText,
      heardText: r.heardText,
      startMs: r.startMs ?? null,
      endMs: r.endMs ?? null,
      status: r.status,
      confidence: r.confidence,
      reviewStatus,
      tenantId,
      quranRef,
      sourceChecksum,
      evidenceId,
      modelVersion: MODEL_VERSION,
      traceId,
    }));
  }

  const modelAttribution = quranAlignmentAttribution(upstreamModelAttribution);

  // Record the ACTUAL computed metrics (see the note above the branch), then stamp every alignment
  // with the resulting event id.
  const auditEventId = appendAudit(tenantId, "ml.alignment.predicted", sessionId, {
    modelVersion: MODEL_VERSION,
    modelAttribution,
    traceId,
    confidence,
    wordCount,
    recognizedCount,
    finalizable,
    nonFinalizedReason,
  });
  alignments = alignments.map((a) => ({ ...a, auditEventId }));

  return {
    traceId,
    fixtureCaseId: fixtureCase?.id ?? null,
    tenantId,
    sessionId,
    quranRef,
    sourceChecksum,
    evidenceId,
    modelVersion: MODEL_VERSION,
    modelAttribution,
    auditEventId,
    alignments,
    confidence,
    reviewStatus,
    finalizable,
    nonFinalizedReason,
    externalAsr,
    latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    datasetVersion: fixtureCase && USE_GOLDEN_FIXTURES
      ? DATASET_VERSION
      : QURAN_ALIGNER_COMPONENT.datasetVersion,
    algorithm: "quran-constrained-levenshtein",
  };
}

// === Real tajweed prediction ===
async function predictTajweed(requestBody) {
  if (Object.hasOwn(requestBody, "modelVersion") || Object.hasOwn(requestBody, "modelAttribution")) {
    throw httpError(400, "model identity is server-selected and must not be supplied");
  }
  const startedAt = performance.now();
  const traceId = extractTraceId(requestBody);
  const tenantId = requiredString(requestBody.tenantId, "tenantId");
  const sessionId = requiredString(requestBody.sessionId, "sessionId");

  const quranRef = requestBody.quranRef ?? {
    surahNumber: 1,
    ayahStart: 1,
    ayahEnd: 7,
    display: "Al-Fatihah 1:1-7",
  };
  const canonicalWords = getCanonicalWords(
    quranRef.surahNumber,
    quranRef.ayahStart,
    quranRef.ayahEnd,
  );

  const fixtureCase = fixtures.cases.find(
    (candidate) =>
      candidate.quranRef.surahNumber === quranRef.surahNumber &&
      candidate.quranRef.ayahStart === quranRef.ayahStart &&
      candidate.quranRef.ayahEnd === quranRef.ayahEnd,
  );
  const evidenceId = `evidence-${randomUUID()}`;

  // Canonical rules and declared fixture rules are instruction, never learner findings.
  let annotations;
  if (fixtureCase && USE_GOLDEN_FIXTURES) {
    annotations = fixtureCase.tajweedFindings.map((finding) => ({
      id: finding.id,
      wordId: finding.wordId,
      rule: finding.rule,
      explanation: finding.explanation,
      sources: finding.sources,
      analysisBasis: "text-rule",
      instructional: true,
      tenantId,
      sourceChecksum: requestBody.sourceChecksum ?? "fnv1a32:real",
      evidenceId,
      traceId,
    }));
  } else {
    annotations = analyzeAyah(
      `${quranRef.surahNumber}:${quranRef.ayahStart}`,
      canonicalWords,
    ).map((finding) => ({
      ...finding,
      tenantId,
      sourceChecksum: requestBody.sourceChecksum ?? "fnv1a32:real",
      evidenceId,
      traceId,
    }));
  }

  // This result is deliberately audit-only. Raw, uncalibrated observations never enter the public
  // response, findings[], Postgres, teacher review, Flutter, or a learner-facing confidence.
  const acousticShadow = await runAcousticShadow(requestBody, canonicalWords);
  const auditEventId = appendAudit(tenantId, "ml.tajweed.predicted", sessionId, {
    modelVersion: MODEL_VERSION,
    traceId,
    annotationCount: annotations.length,
    findingCount: 0,
    acousticShadow,
  });
  annotations = annotations.map((annotation) => ({ ...annotation, auditEventId }));

  return {
    traceId,
    fixtureCaseId: fixtureCase?.id ?? null,
    tenantId,
    sessionId,
    quranRef,
    evidenceId,
    modelVersion: MODEL_VERSION,
    auditEventId,
    annotations,
    findings: [],
    latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    datasetVersion: DATASET_VERSION,
    algorithm: "rule-based-tajweed",
  };
}

// === Privacy ===
async function exportPrivacy(requestBody) {
  const tenantId = safeStorageSegment(requestBody.tenantId, "tenantId");
  const learnerId = safeStorageSegment(requestBody.learnerId, "learnerId");
  const traceId = extractTraceId(requestBody);
  appendAudit(tenantId, "privacy.export.requested", learnerId, { traceId });

  // List audio files for this tenant/learner
  const { audioObjectKeys, metadataObjectKeys } = await listAudioObjects(tenantId, learnerId);

  return {
    traceId,
    tenantId,
    learnerId,
    audioObjectKeys,
    metadataObjectKeys,
    externalAsrCalls: readTenantAuditEvents(tenantId).filter(
      (event) => event.action === "privacy.external-asr.called",
    ),
    deniedExternalAsr: readTenantAuditEvents(tenantId).filter(
      (event) => event.action === "privacy.external-asr.denied",
    ),
    auditEvents: readTenantAuditEvents(tenantId),
  };
}

async function deletePrivacy(requestBody) {
  const tenantId = safeStorageSegment(requestBody.tenantId, "tenantId");
  const learnerId = safeStorageSegment(requestBody.learnerId, "learnerId");
  const traceId = extractTraceId(requestBody);

  // Delete audio files
  const { deletedAudioObjectKeys, deletedMetadataObjectKeys } = await deleteAudioObjects(tenantId, learnerId);

  const job = {
    id: `privacy-delete-${randomUUID()}`,
    traceId,
    tenantId,
    learnerId,
    status: "completed",
    deletedAudioObjectKeys,
    deletedMetadataObjectKeys,
    tombstonedDerivedRecords: true,
    completedAt: new Date().toISOString(),
  };
  deletionJobs.set(job.id, job);
  appendAudit(tenantId, "privacy.delete.requested", learnerId, {
    jobId: job.id,
    traceId,
    deletedAudioObjectKeys,
    deletedMetadataObjectKeys,
  });
  return job;
}

/**
 * Describe how an incoming chunk differs from one already stored under the same id, or null when
 * there is nothing stored or it is the same audio arriving again.
 *
 * Compares the content HASH, not just the size: two different 3200-byte chunks of PCM are the
 * normal case, not an exotic one, so a size check would miss almost every real conflict. Metadata
 * written before `audioSha256` existed has no hash to compare, so those fall back to size and
 * timing — weaker, and deliberately not treated as "no conflict" just because the hash is absent.
 */
function describeChunkConflict(tenantDir, chunkId, incoming) {
  const metaPath = join(tenantDir, `${chunkId}.meta.json`);
  if (!existsSync(metaPath)) return null;

  let stored;
  try {
    stored = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    // Unreadable metadata beside a stored chunk is itself worth surfacing rather than swallowing.
    return { reason: "existing metadata could not be read" };
  }

  if (stored.audioSha256 && incoming.audioSha256) {
    if (stored.audioSha256 === incoming.audioSha256) return null; // idempotent retry
    return {
      reason: "different audio",
      storedSha256: stored.audioSha256.slice(0, 12),
      incomingSha256: incoming.audioSha256.slice(0, 12),
      storedStartMs: stored.startMs,
      incomingStartMs: incoming.startMs,
    };
  }

  // Pre-hash metadata, or a chunk stored with no audio at all.
  const differs =
    stored.audioSize !== incoming.audioSize ||
    stored.startMs !== incoming.startMs ||
    stored.endMs !== incoming.endMs;
  return differs
    ? {
        reason: "different size or timing (stored before content hashing)",
        storedAudioSize: stored.audioSize,
        incomingAudioSize: incoming.audioSize,
        storedStartMs: stored.startMs,
        incomingStartMs: incoming.startMs,
      }
    : null;
}

// === Audio chunk storage ===
/**
 * Where a chunk sits in the recording, or `{startMs: null, endMs: null}` when that is not known.
 *
 * Mirrors `usable_span` (handlers/recitation.rs) and `usableSpan` (routes/session-writes.mjs) in what
 * it accepts — integers with `0 <= start < end` — and differs in what it does with the rest. Those
 * two REFUSE the row, because an alignment with no span is a finding pointing at nothing. This one
 * keeps the row and drops only the claim, because the row here is a learner's actual recording.
 */
function chunkSpan(startMs, endMs) {
  const usable =
    Number.isInteger(startMs) && Number.isInteger(endMs) && startMs >= 0 && endMs > startMs;
  return usable ? { startMs, endMs } : { startMs: null, endMs: null };
}

/**
 * Read one stored chunk back, for a teacher adjudicating a finding about it.
 *
 * Audio had only ever been written here. Nothing could read it back, which is why a teacher asked to
 * accept or reject a claim about how a child recited has never been able to hear the recitation.
 *
 * ── The key's PARTS, never the key ───────────────────────────────────────────────────────────────
 * `objectKey` is `<tenant>/<learner>/<chunk>.bin`, and accepting one would mean filtering a
 * path-shaped string for traversal on the exact route that reads files off the host. Taking the
 * three segments and validating each with `safeStorageSegment` makes traversal structurally
 * impossible instead of filtered: a segment containing `/`, `..` or a NUL never becomes a path
 * component because it never gets past validation.
 *
 * ── Retention is checked HERE too, and that is not redundant ─────────────────────────────────────
 * platform-api checks the learner's consent record in the database before it ever calls this. This
 * checks the retention that was written ALONGSIDE THE BYTES at the moment they were stored. Two
 * independent records have to agree before a child's recitation is played back, and neither is the
 * other's cache — if they disagree, something is wrong and the safe answer is to refuse.
 *
 * The default is `discard` (see `storeAudioChunk`), so a chunk stored without a stated retention is
 * refused rather than served.
 */
async function readAudioObject(requestBody) {
  const tenantId = safeStorageSegment(requestBody.tenantId, "tenantId");
  const learnerId = safeStorageSegment(requestBody.learnerId, "learnerId");
  const chunkId = safeStorageSegment(requestBody.chunkId, "chunkId");

  const dir = join(AUDIO_STORAGE_DIR, tenantId, learnerId);
  const metaPath = join(dir, `${chunkId}.meta.json`);
  const binPath = join(dir, `${chunkId}.bin`);

  // One message for "no metadata", "no bytes" and "no such learner". A caller that can tell them
  // apart can map which learners and chunk ids exist, and this route is reachable by anything
  // holding ML_API_KEY.
  if (!existsSync(metaPath) || !existsSync(binPath)) {
    throw httpError(404, "no such audio object");
  }

  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    // Unreadable metadata means the retention policy for these bytes is unknown, and unknown is not
    // permission. Refuse rather than serve on the assumption it was fine.
    throw httpError(410, "audio retention for this object cannot be established");
  }

  if (metadata.audioRetention !== "teacher-review" && metadata.audioRetention !== "training-opt-in") {
    throw httpError(410, "this recording was not retained for review");
  }

  const audio = readFileSync(binPath);
  return {
    objectKey: metadata.objectKey ?? `${tenantId}/${learnerId}/${chunkId}.bin`,
    audioBase64: audio.toString("base64"),
    audioSize: audio.length,
    sampleRate: metadata.sampleRate ?? null,
    // Nullable by construction — see `chunkSpan`. A player that cannot seek is better than one that
    // seeks to an invented position.
    startMs: metadata.startMs ?? null,
    endMs: metadata.endMs ?? null,
  };
}

async function storeAudioChunk(requestBody) {
  const tenantId = safeStorageSegment(requestBody.tenantId, "tenantId");
  const learnerId = safeStorageSegment(requestBody.learnerId, "learnerId");
  const sessionId = requiredString(requestBody.sessionId, "sessionId");
  const chunkId = safeStorageSegment(requestBody.chunkId, "chunkId");

  const tenantDir = join(AUDIO_STORAGE_DIR, tenantId, learnerId);
  mkdirSync(tenantDir, { recursive: true });

  const metadata = {
    tenantId,
    learnerId,
    sessionId,
    chunkId,
    sampleRate: requestBody.sampleRate ?? 16000,
    // `?? 0` here was the same fail-open the alignment writers had (see `usable_span` in
    // handlers/recitation.rs), and worse for one reason: **0 is a legitimate value**. The first
    // chunk of every session genuinely starts at 0ms, so "we do not know where this chunk sits" and
    // "this chunk sits at the beginning" were written identically and no reader could tell them
    // apart. That span is what a tajweed finding needs to locate its audio; a chunk claiming
    // 0ms-to-0ms is unlocatable, and claiming it silently is how the gap stays invisible.
    //
    // `null` is the honest third value. The AUDIO is stored either way — refusing the chunk would
    // discard a learner's recording that consent covers, which is the opposite of the point. Only
    // the claim about where it sits is withheld.
    ...chunkSpan(requestBody.startMs, requestBody.endMs),
    audioSize: requestBody.audioSize ?? 0,
    audioRetention: requestBody.audioRetention ?? "discard",
    storedAt: new Date().toISOString(),
    objectKey: `${tenantId}/${learnerId}/${chunkId}.bin`,
  };

  // Decode and FINGERPRINT first, write second. The order is the whole point: a check that runs
  // after `storeAudioObject` can only report the overwrite it failed to prevent.
  let audioBytes = null;
  if (requestBody.audioBase64) {
    audioBytes = Buffer.from(requestBody.audioBase64, "base64");
    metadata.audioSize = audioBytes.length;
    // Cheap, because the bytes are already in hand. It is what tells a harmless retry apart from a
    // chunk being replaced with DIFFERENT audio.
    metadata.audioSha256 = createHash("sha256").update(audioBytes).digest("hex");
  }

  // ── Is this replacing a learner's recording with a different one? ────────────────────────────
  // Writing a chunk id that already exists is NORMAL and safe when it is the same audio: the ML
  // forwarder retries up to three times, so a POST whose response was lost arrives again. That path
  // is idempotent and must stay silent.
  //
  // A conflicting write is a different thing entirely, and until now it was indistinguishable — the
  // file was replaced, 200 was returned, and nothing anywhere said a child's recitation had just
  // been overwritten by other audio. That silence is what let the reconnect chunk-id collision
  // (ADR: fix/reconnect-chunk-id-collision) destroy half of a learner's session undetected for as
  // long as it existed. The gateway no longer mints duplicate ids, so this should now never fire —
  // which is exactly why it is worth hearing if it does.
  //
  // REFUSED, as of the flow enumeration below. This landed as detect-and-log first, deliberately,
  // because a 409 that broke a legitimate rewrite would have traded a silent failure for a loud
  // wrong one. Every caller of this route has since been enumerated:
  //
  //   services/realtime-gateway/src/lib.rs  — the ONLY production writer
  //   scripts/privacy-audit-run.mjs         — audit tooling
  //   scripts/smoke-privacy.mjs             — smoke test
  //
  // apps/mobile does not post chunks (it goes through /v1/asr/transcribe) and apps/web streams via
  // the gateway. Since the reconnect fix, the gateway mints ids from a per-session cursor that never
  // repeats, so the only legitimate rewrite left is the bounded retry — same id, same bytes — which
  // `describeChunkConflict` returns null for and which stays a silent 200.
  //
  // That leaves no production flow that legitimately replaces stored audio with different audio.
  // A request that tries to is a bug somewhere upstream, and the last moment anyone can stop it
  // from destroying a child's recitation is here, before the write.
  const conflict = describeChunkConflict(tenantDir, chunkId, metadata);
  if (conflict) {
    log("error", "REFUSED: audio chunk would be overwritten with different content", {
      tenantId,
      sessionId,
      chunkId,
      traceId: extractTraceId(requestBody),
      conflict,
    });
    appendAudit(tenantId, "audio.chunk.overwrite-refused", chunkId, {
      sessionId,
      traceId: extractTraceId(requestBody),
      conflict,
    });
    // 409, not 400: the request is well-formed, it conflicts with what is already stored. Nothing
    // has been written — the stored recitation is exactly as it was before this call.
    throw httpError(
      409,
      `chunk ${chunkId} already holds different audio; refusing to replace a stored recitation`,
    );
  }

  if (audioBytes) {
    await storeAudioObject(tenantId, learnerId, chunkId, audioBytes);
  }

  writeFileSync(join(tenantDir, `${chunkId}.meta.json`), JSON.stringify(metadata, null, 2));

  appendAudit(tenantId, "audio.chunk.stored", chunkId, {
    sessionId,
    traceId: extractTraceId(requestBody),
    audioSize: metadata.audioSize,
  });

  return { stored: true, objectKey: metadata.objectKey, audioSize: metadata.audioSize };
}

// Test-only accessors. Importing this module does not start the server (see `isMain`), so the
// hermetic node:test suite drives the handlers directly and asserts on the audit trail.
export function getAuditEvents(tenantId) {
  return tenantId ? readTenantAuditEvents(tenantId) : [];
}
export { predictAlignment, predictTajweed, transcribeSession, safeStorageSegment, route };


/**
 * Wrap raw PCM16 in a WAV container.
 *
 * The realtime gateway forwards what the client streams, and `apps/flutter`'s recorder streams raw
 * PCM16 — but the ASR service accepts only container formats (`ALLOWED_AUDIO_FORMATS` in
 * `services/asr-inference/server.py`: webm, wav, mp3, m4a, ogg, flac). A 44-byte RIFF header is the
 * whole difference: it DESCRIBES the samples (rate, channels, bit depth) and changes none of them,
 * so this is packaging, not processing.
 */
export function wavFromPcm16(pcm, sampleRate = 16000, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4); // file size minus the first 8 bytes
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}


/**
 * Assemble one retained session into a validated PCM16 timeline.
 *
 * Transcription and acoustic shadow analysis share this loader so missing, expired, gapped, mixed-
 * rate, or malformed audio can never be interpreted differently by the two inference paths.
 */
export async function loadSessionPcm({ tenantId, learnerId, sessionId, traceId = null }) {
  tenantId = safeStorageSegment(tenantId, "tenantId");
  learnerId = safeStorageSegment(learnerId, "learnerId");
  sessionId = requiredString(sessionId, "sessionId");
  const empty = (reason, extra = {}) => ({
    loaded: false,
    reason,
    pcm: null,
    sampleRate: null,
    durationMs: 0,
    chunkCount: 0,
    missingChunkIds: [],
    missingAudioChunkIds: [],
    ...extra,
  });

  const dir = join(AUDIO_STORAGE_DIR, tenantId, learnerId);
  if (!existsSync(dir)) return empty("no-audio");

  const BATCH = 64;
  async function readAllOf(files, read) {
    const out = [];
    for (let i = 0; i < files.length; i += BATCH) {
      out.push(...(await Promise.all(files.slice(i, i + BATCH).map(read))));
    }
    return out;
  }

  const metaFiles = (await readdirAsync(dir)).filter((file) => file.endsWith(".meta.json"));
  const chunks = (
    await readAllOf(metaFiles, async (file) => {
      try {
        return JSON.parse(await readFileAsync(join(dir, file), "utf8"));
      } catch {
        return null;
      }
    })
  )
    .filter((metadata) => metadata && metadata.sessionId === sessionId)
    .sort((left, right) => (left.startMs ?? 0) - (right.startMs ?? 0));

  if (chunks.length === 0) return empty("no-audio");
  const expired = chunks.some((metadata) => {
    if (typeof metadata.storedAt !== "string") return false;
    const storedAt = Date.parse(metadata.storedAt);
    if (!Number.isFinite(storedAt)) return true;
    return Date.now() >= storedAt + retentionTtlHours(metadata.audioRetention) * 60 * 60 * 1000;
  });
  if (expired) return empty("expired-audio", { chunkCount: chunks.length });

  const read = await readAllOf(chunks, async (metadata) => {
    try {
      return {
        chunkId: metadata.chunkId,
        metadata,
        bytes: await readFileAsync(join(dir, `${metadata.chunkId}.bin`)),
      };
    } catch {
      return { chunkId: metadata.chunkId, metadata, bytes: null };
    }
  });
  const available = read.filter((entry) => Buffer.isBuffer(entry.bytes));
  const present = available.map((entry) => entry.chunkId);
  const missingAudioChunkIds = read
    .filter((entry) => !Buffer.isBuffer(entry.bytes))
    .map((entry) => entry.chunkId);
  const missingChunkIds = interiorSequenceGaps(present);
  if (missingChunkIds.length > 0 || missingAudioChunkIds.length > 0) {
    log("warn", "session is missing chunks that were accepted upstream", {
      tenantId,
      sessionId,
      traceId,
      storedChunks: present.length,
      missingChunkIds,
      missingAudioChunkIds,
    });
    return empty("incomplete-audio", {
      chunkCount: available.length,
      missingChunkIds,
      missingAudioChunkIds,
    });
  }
  if (available.length === 0) {
    return empty("no-audio", {
      chunkCount: chunks.length,
      missingChunkIds,
      missingAudioChunkIds,
    });
  }

  const sampleRates = new Set(available.map((entry) => entry.metadata?.sampleRate));
  const sampleRate = available[0]?.metadata?.sampleRate;
  const validTimingShape = chunks.every(
    (metadata, index) =>
      Number.isInteger(metadata?.startMs) && Number.isInteger(metadata?.endMs) &&
      metadata.startMs >= 0 && metadata.endMs > metadata.startMs &&
      (index === 0 || chunks[index - 1].endMs <= metadata.startMs),
  );
  const completeTimeline = chunks[0]?.startMs === 0 && chunks.every(
    (metadata, index) => index === 0 || chunks[index - 1].endMs === metadata.startMs,
  );
  const byteLengthsMatchRoundedTimings = available.every((entry) => {
    const durationMs = entry.metadata.endMs - entry.metadata.startMs;
    const measuredDurationMs = entry.bytes.length * 1000 / (entry.metadata.sampleRate * 2);
    // Chunk metadata is integer milliseconds while PCM duration has frame precision. A correctly
    // rounded boundary may differ by at most half a millisecond; anything beyond that is truncated,
    // padded, or described with the wrong rate and must still fail closed.
    return Math.abs(measuredDurationMs - durationMs) <= 0.5;
  });
  if (
    sampleRates.size !== 1 ||
    !ALLOWED_PCM_SAMPLE_RATES.has(sampleRate) ||
    !validTimingShape ||
    !byteLengthsMatchRoundedTimings ||
    available.some((entry) => entry.bytes.length === 0 || entry.bytes.length % 2 !== 0)
  ) {
    return empty("inconsistent-audio-format", {
      chunkCount: available.length,
      missingChunkIds,
      missingAudioChunkIds,
    });
  }
  if (!completeTimeline) {
    return empty("incomplete-audio", {
      chunkCount: available.length,
      missingChunkIds,
      missingAudioChunkIds,
    });
  }

  const pcm = Buffer.concat(available.map((entry) => entry.bytes));
  return {
    loaded: true,
    reason: null,
    pcm,
    sampleRate,
    durationMs: Math.round((pcm.length / 2 * 1000) / sampleRate),
    chunkCount: available.length,
    missingChunkIds,
    missingAudioChunkIds,
  };
}

/**
 * Transcribe a whole session from the chunks the realtime gateway already forwarded here.
 *
 * ── Why this lives in ml-inference ──────────────────────────────────────────────────────────────
 * The gateway streams audio to `/v1/audio-chunks`, which stored it and did nothing else — so a
 * gateway-based recitation produced no transcript, therefore no alignment, therefore no finding a
 * teacher could ever review. The audio is already here; this is what turns it into words.
 *
 * ── Consent is the CALLER's to supply, and it is not optional ───────────────────────────────────
 * The stored chunk metadata carries no consent — the gateway does not send any (see its
 * `/v1/audio-chunks` body). The authoritative record lives in platform-api's database, which is why
 * this refuses unless the caller passes it, exactly as `predictAlignment` does. platform-api reads
 * it from the session row and never from the client.
 *
 * Whole session, not per chunk: chunk boundaries fall mid-word, and transcribing each one
 * separately would invent word breaks the learner did not make.
 */
async function transcribeSession(requestBody) {
  const tenantId = safeStorageSegment(requestBody.tenantId, "tenantId");
  const learnerId = safeStorageSegment(requestBody.learnerId, "learnerId");
  const sessionId = requiredString(requestBody.sessionId, "sessionId");
  const traceId = extractTraceId(requestBody);

  const consent = requestBody.consent ?? {};
  const asrAllowed = (consent.externalAsrProcessing ?? false) && (consent.guardianApproved ?? false);
  if (!asrAllowed) {
    appendAudit(tenantId, "privacy.external-asr.denied", sessionId, {
      traceId,
      reason: "consent-revoked-or-insufficient",
    });
    return {
      transcribed: false,
      reason: "consent-revoked-or-insufficient",
      recognizedText: [],
      recognizedTokens: [],
      chunkCount: 0,
    };
  }

  const audio = await loadSessionPcm({ tenantId, learnerId, sessionId, traceId });
  if (!audio.loaded) {
    return {
      transcribed: false,
      reason: audio.reason,
      recognizedText: [],
      recognizedTokens: [],
      chunkCount: audio.chunkCount,
      missingChunkIds: audio.missingChunkIds,
      missingAudioChunkIds: audio.missingAudioChunkIds,
    };
  }

  const {
    pcm,
    sampleRate,
    chunkCount,
    missingChunkIds,
    missingAudioChunkIds,
  } = audio;
  let windows;
  try {
    windows = boundedPcmWindows(pcm, sampleRate);
  } catch (error) {
    if (!(error instanceof SpanEvidenceError)) throw error;
    return {
      transcribed: false,
      reason: error.reason,
      recognizedText: [],
      recognizedTokens: [],
      chunkCount,
      missingChunkIds,
      missingAudioChunkIds,
    };
  }

  const recognizedTokens = [];
  const transcriptAttributions = [];
  try {
    for (const window of windows) {
      const wav = wavFromPcm16(window.pcm, sampleRate);
      const audioBase64 = wav.toString("base64");
      const asr = await transcribeAudio(audioBase64, "wav", "ar");
      transcriptAttributions.push(asr.modelAttribution);
      let tokens = recognizedTokensFrom(asr, {
        offsetMs: window.offsetMs,
        durationMs: window.durationMs,
      });

      if (tokens === null) {
        const transcript = typeof asr?.text === "string" ? asr.text.trim() : "";
        const words = transcript === "" ? [] : transcript.split(/\s+/);
        if (words.length === 0) continue;
        const forced = await forceAlignRecognizedAudio(audioBase64, "wav", transcript);
        transcriptAttributions.push(forced.modelAttribution);
        const forcedWords = Array.isArray(forced?.words) ? forced.words : [];
        if (
          forcedWords.length !== words.length ||
          forcedWords.some((word, index) => word?.word !== words[index])
        ) {
          throw spanEvidenceError(
            "invalid-recognized-spans",
            "forced alignment does not correspond to the recognized transcript",
          );
        }
        tokens = recognizedTokensFrom(forced, {
          offsetMs: window.offsetMs,
          durationMs: window.durationMs,
          confidenceField: "score",
        });
      }

      for (const token of tokens ?? []) {
        const midpointMs = token.startMs + (token.endMs - token.startMs) / 2;
        if (
          midpointMs >= window.coreStartMs &&
          (midpointMs < window.coreEndMs || (window.final && midpointMs <= window.coreEndMs))
        ) {
          recognizedTokens.push(token);
        }
      }
    }
  } catch (error) {
    const reason = error instanceof SpanEvidenceError
      ? error.reason
      : error?.status === 502
        ? "asr-unavailable"
        : null;
    if (reason === null) throw error;
    return {
      transcribed: false,
      reason,
      recognizedText: [],
      recognizedTokens: [],
      chunkCount: chunkCount,
      windowCount: windows.length,
      sampleRate,
      missingChunkIds,
      missingAudioChunkIds,
    };
  }

  if (recognizedTokens.length === 0) {
    return {
      transcribed: false,
      reason: "no-recognized-speech",
      recognizedText: [],
      recognizedTokens: [],
      chunkCount: chunkCount,
      windowCount: windows.length,
      sampleRate,
      missingChunkIds,
      missingAudioChunkIds,
    };
  }

  for (let index = 1; index < recognizedTokens.length; index++) {
    const previous = recognizedTokens[index - 1];
    const current = recognizedTokens[index];
    if (current.startMs < previous.startMs || current.endMs < previous.endMs) {
      return {
        transcribed: false,
        reason: "invalid-recognized-spans",
        recognizedText: [],
        recognizedTokens: [],
        chunkCount: chunkCount,
        windowCount: windows.length,
        sampleRate,
        missingChunkIds,
        missingAudioChunkIds,
      };
    }
  }

  let modelAttribution;
  try {
    modelAttribution = mergeModelAttributions(transcriptAttributions, "asr");
  } catch (error) {
    log("warn", "session transcript producer attribution is inconsistent", {
      tenantId,
      sessionId,
      traceId,
      reason: error instanceof Error ? error.message : "invalid model attribution",
    });
    return {
      transcribed: false,
      reason: "invalid-model-attribution",
      recognizedText: [],
      recognizedTokens: [],
      chunkCount: chunkCount,
      windowCount: windows.length,
      sampleRate,
      missingChunkIds,
      missingAudioChunkIds,
    };
  }
  const primary = modelAttribution.components.find(
    (component) =>
      component.component === modelAttribution.primaryComponent && component.status === "active",
  );

  appendAudit(tenantId, "privacy.external-asr.called", sessionId, {
    traceId,
    reason: "consent-granted",
    chunkCount: chunkCount,
    windowCount: windows.length,
  });

  return {
    transcribed: true,
    reason: "consent-granted",
    // Canonical/recognized text is never normalized here; this is a projection of measured tokens.
    recognizedText: recognizedTokens.map((token) => token.text),
    recognizedTokens,
    transcriptSource: "server-derived",
    modelVersion: primary.implementationId,
    modelAttribution,
    chunkCount: chunkCount,
    windowCount: windows.length,
    sampleRate,
    // Reported even when empty, so a caller can tell "no gaps" from "this build does not check".
    missingChunkIds,
    missingAudioChunkIds,
  };
}

/**
 * Sequence numbers missing from the INTERIOR of a session's chunk ids.
 *
 * Ids are `{session}-ws-{NNNN}` with a per-session monotonic cursor, so 0,1,2,6,7 means 3,4,5 were
 * accepted and never stored.
 *
 * INTERIOR only, and that limit is not a detail: the run has no known upper bound, so chunks lost
 * off the END of a session are invisible here. A recitation truncated by an outage in its last
 * seconds still looks complete. Closing that needs the client or the gateway to declare how many
 * chunks a session should have — which is a protocol change, not a computation.
 *
 * Ids that do not match the pattern are ignored rather than guessed at; a session whose chunks came
 * from somewhere else simply reports no gaps.
 */
function interiorSequenceGaps(chunkIds) {
  const seqs = [];
  let prefix = null;
  let width = 0;
  for (const id of chunkIds) {
    const m = /^(.*-ws-)(\d+)$/.exec(id ?? "");
    if (!m) continue;
    prefix ??= m[1];
    if (m[1] !== prefix) continue;
    seqs.push(Number(m[2]));
    // From the id TEXT, not from the number: deriving it from the value pads `11` to "11" and would
    // report `-ws-11` for an id that is actually `-ws-0011`.
    width = Math.max(width, m[2].length);
  }
  if (seqs.length < 2) return [];

  seqs.sort((a, b) => a - b);
  const missing = [];
  for (let n = seqs[0] + 1; n < seqs.at(-1); n++) {
    if (!seqs.includes(n)) missing.push(`${prefix}${String(n).padStart(width, "0")}`);
  }
  return missing;
}

// === Router ===
async function route(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/health") {
    jsonResponse(response, 200, {
      ok: true,
      service: "quran-ai-ml-inference",
      modelVersion: MODEL_VERSION,
      datasetVersion: DATASET_VERSION,
      goldenCases: GOLDEN_CASE_IDS,
      algorithm: "quran-constrained-levenshtein + rule-based-tajweed",
      quranCoverage: `${manifest.surahCount} surahs, ${manifest.totalAyahs} ayahs, ${manifest.totalWords} words`,
      audioStorage: AUDIO_STORAGE_DIR,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/audit-events") {
    // tenantId is REQUIRED on this HTTP surface, unlike the getAuditEvents() test-only accessor
    // above (which intentionally supports an unscoped "every tenant" mode for the hermetic
    // node:test suite, never network-reachable). This route used to fall back to "every tenant"
    // the same way when the query param was omitted -- gated only by the single shared
    // ML_API_KEY, which is not tenant-specific, so any caller holding that one key could read
    // every other tenant's alignment/tajweed predictions, session/trace ids, confidence scores,
    // and privacy consent events by simply omitting ?tenantId=. README.md has always documented
    // this route as `GET /v1/audit-events?tenantId=...` -- tenantId was never meant to be
    // optional here.
    const tenantId = url.searchParams.get("tenantId");
    if (!tenantId) {
      throw httpError(400, "tenantId query parameter is required");
    }
    jsonResponse(response, 200, readTenantAuditEvents(tenantId));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/audio-objects:read") {
    const body = await readJson(request);
    // The response carries a child's recorded voice. It is returned and never logged: no
    // `console`/`appendAudit` call on this path touches the payload.
    jsonResponse(response, 200, await readAudioObject(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/audio-chunks") {
    const body = await readJson(request);
    const result = await storeAudioChunk(body);
    jsonResponse(response, 200, result);
    return;
  }

  if (request.method !== "POST") {
    textResponse(response, 404, "not found");
    return;
  }

  const body = await readJson(request);
  if (url.pathname === "/v1/alignments:predict") {
    jsonResponse(response, 200, await predictAlignment(body));
    return;
  }

  if (url.pathname === "/v1/session-transcript") {
    jsonResponse(response, 200, await transcribeSession(body));
    return;
  }

  if (url.pathname === "/v1/tajweed-findings:predict") {
    jsonResponse(response, 200, await predictTajweed(body));
    return;
  }

  if (url.pathname === "/v1/privacy/export") {
    jsonResponse(response, 200, await exportPrivacy(body));
    return;
  }

  if (url.pathname === "/v1/privacy/delete") {
    jsonResponse(response, 200, await deletePrivacy(body));
    return;
  }

  textResponse(response, 404, "not found");
}

// === Rate Limiter (sliding window, per-IP) ===
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 100;          // max requests per window
/** @type {Map<string, number[]>} */
const rateLimitMap = new Map();
// Trusting X-Forwarded-For unconditionally lets a DIRECT client bypass the limiter entirely by
// varying the header per request (verified empirically: 130/130 requests succeeded this way,
// vs. 100/130 without a spoofed header). Only trust it when explicitly opted in for a deployment
// that sits behind a real reverse proxy which OVERWRITES the header — mirrors platform-api's
// identical TRUST_PROXY_HEADERS gate for the same problem on its own rate limiter.
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === "1" || process.env.TRUST_PROXY_HEADERS === "true";

// Clean up stale entries every 5 minutes to prevent memory growth. .unref() so importing this
// module for tests does not keep the event loop alive (the timer never fires in a short test run).
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of rateLimitMap) {
    const valid = timestamps.filter((t) => t > cutoff);
    if (valid.length === 0) {
      rateLimitMap.delete(ip);
    } else {
      rateLimitMap.set(ip, valid);
    }
  }
}, 5 * 60_000).unref();

/**
 * Budget for callers holding the server-side `ML_API_KEY` — platform-api and the agents service.
 *
 * ── Why they cannot share the per-IP budget ─────────────────────────────────────────────────────
 * Every learner's analysis reaches this service through platform-api's proxy, and platform-api does
 * not forward `x-forwarded-for`. So from here, ALL traffic from ALL learners in ALL tenants arrives
 * from one address and lands in one bucket: the whole platform was capped at 100 ML requests per
 * minute, shared. A class of twenty children practising would 429 each other.
 *
 * Measured, not theorised — P5.4's k6 run reported a 73.8% error rate at 10 VUs and 78.1% at 50,
 * which is the limiter answering, not the service failing. See specs/dr-rehearsal/evidence/.
 *
 * A ceiling remains rather than an exemption: if the key ever leaks, "authenticated" stops meaning
 * "trustworthy", and an unbounded budget would make this service the easiest way to take the
 * platform down. Tune with ML_TRUSTED_RATE_LIMIT_MAX.
 */
const TRUSTED_RATE_LIMIT_MAX = Number(process.env.ML_TRUSTED_RATE_LIMIT_MAX ?? 6000);

/**
 * @param {string} bucket  the identity being limited
 * @param {number} max     that identity's budget per window
 */
function checkRateLimit(bucket, max = RATE_LIMIT_MAX) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (rateLimitMap.get(bucket) ?? []).filter((t) => t > cutoff);
  if (timestamps.length >= max) {
    return false;
  }
  timestamps.push(now);
  rateLimitMap.set(bucket, timestamps);
  return true;
}

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  // --- Sliding-window rate limiter (non-health endpoints) ---
  //
  // TWO budgets, because the per-IP one answers two different questions badly at once. An anonymous
  // flood and platform-api relaying a whole tenant's practice look identical by address, and sizing
  // one bucket for both means either the flood is cheap or the tenant is throttled. The API key is
  // the only thing that distinguishes them, so it is checked FIRST and the budget follows from it.
  const authenticated = request.headers["x-ml-api-key"] === ML_API_KEY;
  if (url.pathname !== "/health") {
    const forwardedFor = TRUST_PROXY_HEADERS
      ? request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
      : undefined;
    const clientIp = forwardedFor || request.socket.remoteAddress || "unknown";
    // Separate namespaces, so an unauthenticated flood from the proxy's own address — a container
    // on the same network, say — cannot spend the trusted budget it is not entitled to.
    const bucket = authenticated ? `trusted:${clientIp}` : `ip:${clientIp}`;
    const max = authenticated ? TRUSTED_RATE_LIMIT_MAX : RATE_LIMIT_MAX;
    if (!checkRateLimit(bucket, max)) {
      jsonResponse(response, 429, { error: "Too many requests. Please try again later." });
      return;
    }
  }

  if (url.pathname !== "/health") {
    // HEADER ONLY. `?apiKey=` used to be accepted, which puts a live credential in a place that is
    // logged by default almost everywhere a request travels: access logs, proxy logs, browser
    // history, and any `Referer` sent onward. A header is not automatically logged by any of them.
    //
    // Nothing legitimate relied on the query form — the browser reaches this service through the
    // platform-api proxy (`/v1/ml/*`), which sends `x-ml-api-key` server-side and never exposes the
    // key to a page at all.
    const apiKey = request.headers["x-ml-api-key"];
    if (!apiKey || apiKey !== ML_API_KEY) {
      jsonResponse(response, 401, { error: "unauthorized" });
      return;
    }
  }

  route(request, response).catch((error) => {
    jsonResponse(response, error.status ?? 500, {
      error: error.message,
    });
  });
});

// Consent-aware retention TTLs (configurable via env).
const AUDIO_TTL_DISCARD_HOURS = Number(process.env.AUDIO_RETENTION_DISCARD_TTL_HOURS ?? 1);
const AUDIO_TTL_REVIEW_HOURS = Number(process.env.AUDIO_RETENTION_REVIEW_TTL_HOURS ?? 168); // 7 days

// Periodic cleanup for audio-storage: respects consent-based retention.
// - 'discard': delete after AUDIO_TTL_DISCARD_HOURS (default: 1 hour)
// - 'teacher-review': delete after AUDIO_TTL_REVIEW_HOURS (default: 7 days)
// - 'training-opt-in': keep indefinitely (skip)
// Files without metadata default to 'discard' behavior.
/**
 * How long audio under this retention mode may be kept, in hours.
 *
 * Extracted from the retention sweep so a test can execute it. It is the ml-inference half of
 * `mustDiscardAudio` (packages/contracts): anything this returns the DISCARD ttl for is a recording
 * that function must agree is obliged to be destroyed. They used to disagree on an unrecognised
 * mode — this one applied the discard TTL, that one answered "you may keep it" — and nothing
 * noticed, because the contract function had no caller and no corpus case had shown either an
 * out-of-vocabulary value.
 *
 * `training-opt-in` is handled by the caller (kept indefinitely, no TTL at all), so it never
 * reaches here.
 */
export function retentionTtlHours(retention) {
  return retention === "teacher-review" ? AUDIO_TTL_REVIEW_HOURS : AUDIO_TTL_DISCARD_HOURS;
}

setInterval(async () => {
  try {
    const now = Date.now();
    const fs = await import("node:fs");
    const { join } = await import("node:path");

    const cleanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          cleanDir(fullPath);
          // Clean up empty directories
          try {
            if (fs.readdirSync(fullPath).length === 0) {
              fs.rmdirSync(fullPath);
            }
          } catch {}
        } else if (entry.name.endsWith(".bin")) {
          // Determine retention from companion .meta.json
          const metaPath = fullPath.replace(/\.bin$/, ".meta.json");
          let retention = "discard";
          try {
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
              retention = meta.audioRetention ?? "discard";
            }
          } catch {}

          // training-opt-in: keep indefinitely
          if (retention === "training-opt-in") continue;

          const ttlMs = retentionTtlHours(retention) * 60 * 60 * 1000;

          try {
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs < now - ttlMs) {
              fs.unlinkSync(fullPath);
              // Also remove the companion metadata file
              try { fs.unlinkSync(metaPath); } catch {}
              log("info", "Evicted audio file per retention policy", {
                path: fullPath,
                retention,
                ttlHours: ttlMs / (60 * 60 * 1000),
              });
            }
          } catch (err) {
            log("error", "Failed to stat/unlink file", { path: fullPath, error: String(err) });
          }
        }
      }
    };
    cleanDir(AUDIO_STORAGE_DIR);
  } catch (err) {
    log("error", "Failed running periodic audio storage cleanup", { error: String(err) });
  }
}, 60 * 60 * 1000).unref(); // run every hour; .unref() so a test import doesn't block loop exit

const bindHost = process.env.ML_INFERENCE_HOST ?? "127.0.0.1";
const bindPort = Number(process.env.ML_INFERENCE_PORT ?? 8090);

// Bind and install signal handlers only as the process entrypoint. Importing this module (e.g.
// server.test.mjs) must not open a socket — see `isMain`.
if (isMain) {
  server.listen(bindPort, bindHost, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : bindPort;
    log("info", "ml inference server started", {
      bind: `http://${bindHost}:${port}`,
      model: MODEL_VERSION,
      dataset: DATASET_VERSION,
      surahCount: manifest.surahCount,
      totalAyahs: manifest.totalAyahs,
      audioStorage: AUDIO_STORAGE_DIR,
    });
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}
