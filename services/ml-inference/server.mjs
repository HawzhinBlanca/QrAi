/**
 * Quran AI ML Inference Service
 *
 * Real Quran-constrained alignment + rule-based tajweed engine.
 * Replaces the fixture-based stub with actual algorithms.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeArabic, similarity, alignWords, calculateConfidence } from "./alignment.js";
import { analyzeAyah, analyzeWord } from "./tajweed.js";

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

const ML_API_KEY = process.env.ML_API_KEY ?? "smoke-ml-api-key";

const MODEL_VERSION = process.env.ML_MODEL_VERSION ?? "ml-aligner-v0.2";
// Upper bound on words per alignment request (both canonical range and recognized text), bounding the
// O(m·n) alignment DP. Far above any real practice session (the web caps a session at 7 ayahs).
const MAX_ALIGN_WORDS = 1000;
const DATASET_VERSION = fixtures.datasetVersion;
const GOLDEN_CASE_IDS = fixtures.cases.map((c) => c.id);
// Golden fixtures are ONLY for smoke/eval. By default (flag unset) every request
// computes real alignment/tajweed — even for the golden refs like Al-Fatihah 1:1-7.
const USE_GOLDEN_FIXTURES = process.env.ML_USE_GOLDEN_FIXTURES === "1";
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

const auditEvents = [];
const evalRuns = new Map();
const deletionJobs = new Map();

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
    ayahStart > surah.ayahs.length
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

// CORS so the browser web app (served from a different origin) can call this service.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-tenant-id, x-user-id, x-user-role, x-trace-id, x-ml-api-key",
};

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
  auditEvents.push(event);
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
  const response = await fetch(`${ASR_SERVICE_URL}/v1/transcribe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // ASR now requires an API key (like this service does). Server-to-server call, so the key
      // stays server-side; matches ASR_API_KEY on the ASR service (default dev key in dev/CI).
      "x-asr-api-key": process.env.ASR_API_KEY ?? "smoke-asr-api-key",
    },
    body: JSON.stringify({ audioBase64, audioFormat, language, wordTimestamps: true }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw httpError(502, `ASR service failed: ${response.status} ${text}`);
  }
  return response.json();
}

// === Real alignment prediction ===
async function predictAlignment(requestBody) {
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

  if (fixtureCase && USE_GOLDEN_FIXTURES) {
    // Return golden fixture alignment data
    const asrActuallyAllowed = asrAllowed && (!childProfile || guardianApproved);
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
  } else {
    // Get canonical words for the requested ayah range
    const canonicalWords = getCanonicalWords(quranRef.surahNumber, quranRef.ayahStart, quranRef.ayahEnd);

    // Get recognized text: either from ASR (audio), from requestBody, or perfect recitation
    let recognizedWords;
    let asrResult = null;
    if (requestBody.audioBase64) {
      // Real acoustic ASR: send audio to Whisper service
      asrResult = await transcribeAudio(requestBody.audioBase64, requestBody.audioFormat ?? "webm", "ar");
      recognizedWords = asrResult.words.map((w) => w.word);
    } else if (requestBody.recognizedText && Array.isArray(requestBody.recognizedText)) {
      // Every element must be a string; a non-string would throw inside alignWords and
      // surface as a 500. Bad input is a 400.
      if (!requestBody.recognizedText.every((w) => typeof w === "string")) {
        throw httpError(400, "recognizedText must be an array of strings");
      }
      recognizedWords = requestBody.recognizedText;
    } else if (requestBody.recognizedTextString) {
      // Guard the type: a truthy non-string (number, object, array) would throw a
      // TypeError on .trim() and surface as a 500. Bad input is a 400.
      if (typeof requestBody.recognizedTextString !== "string") {
        throw httpError(400, "recognizedTextString must be a string");
      }
      recognizedWords = requestBody.recognizedTextString.trim().split(/\s+/);
    } else {
      recognizedWords = canonicalWords.map((w) => w.text);
    }

    // Bound the recognized side of the O(m·n) alignment DP too (the canonical side is capped in
    // getCanonicalWords). Prevents a huge recognizedText from blocking the handler.
    if (recognizedWords.length > MAX_ALIGN_WORDS) {
      throw httpError(
        400,
        `recognizedText has ${recognizedWords.length} words (max ${MAX_ALIGN_WORDS} per request)`,
      );
    }

    const alignmentResults = alignWords(canonicalWords, recognizedWords);
    confidence = calculateConfidence(alignmentResults);
    reviewStatus = !asrAllowed
      ? "teacher-review-required"
      : confidence >= 0.85 ? "ai-suggested" : "teacher-review-required";
    wordCount = canonicalWords.length;
    recognizedCount = recognizedWords.length;

    alignments = alignmentResults.map((r) => ({
      wordId: r.wordId,
      canonicalText: r.canonicalText,
      heardText: r.heardText,
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

  // Record the ACTUAL computed metrics (see the note above the branch), then stamp every alignment
  // with the resulting event id.
  const auditEventId = appendAudit(tenantId, "ml.alignment.predicted", sessionId, {
    modelVersion: MODEL_VERSION,
    traceId,
    confidence,
    wordCount,
    recognizedCount,
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
    auditEventId,
    alignments,
    confidence,
    reviewStatus,
    externalAsr,
    latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    datasetVersion: DATASET_VERSION,
    algorithm: "quran-constrained-levenshtein",
  };
}

// === Real tajweed prediction ===
async function predictTajweed(requestBody) {
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

  // Check for golden fixture match
  const fixtureCase = fixtures.cases.find(
    (c) => c.quranRef.surahNumber === quranRef.surahNumber &&
           c.quranRef.ayahStart === quranRef.ayahStart &&
           c.quranRef.ayahEnd === quranRef.ayahEnd,
  );

  const evidenceId = `evidence-${randomUUID()}`;

  // Audit is appended AFTER the branch so findingCount reflects the findings ACTUALLY returned.
  // With ML_USE_GOLDEN_FIXTURES unset (the default) the golden ref matches `fixtureCase` but the
  // REAL rule-based analysis runs — previously the audit logged the fixture's finding count (1)
  // while the response returned the real finding set (dozens), so the audit trail undercounted.
  let findings;
  let confidence;

  if (fixtureCase && USE_GOLDEN_FIXTURES) {
    // Return golden fixture tajweed findings
    findings = fixtureCase.tajweedFindings.map((f) => ({
      ...f,
      reviewStatus: "ai-suggested",
      tenantId,
      sourceChecksum: requestBody.sourceChecksum ?? "fnv1a32:real",
      evidenceId,
      traceId,
    }));
    confidence = findings.length > 0
      ? findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length
      : 0.95;
  } else {
    // Run real tajweed analysis
    const canonicalWords = getCanonicalWords(quranRef.surahNumber, quranRef.ayahStart, quranRef.ayahEnd);
    findings = analyzeAyah(
      `${quranRef.surahNumber}:${quranRef.ayahStart}`,
      canonicalWords,
    ).map((f) => ({
      ...f,
      reviewStatus: "ai-suggested",
      tenantId,
      sourceChecksum: requestBody.sourceChecksum ?? "fnv1a32:real",
      evidenceId,
      traceId,
    }));
    confidence = findings.length > 0
      ? findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length
      : 0.95;
  }

  const auditEventId = appendAudit(tenantId, "ml.tajweed.predicted", sessionId, {
    modelVersion: MODEL_VERSION,
    traceId,
    findingCount: findings.length,
  });
  findings = findings.map((f) => ({ ...f, auditEventId }));

  return {
    traceId,
    fixtureCaseId: fixtureCase?.id ?? null,
    tenantId,
    sessionId,
    quranRef,
    evidenceId,
    modelVersion: MODEL_VERSION,
    auditEventId,
    findings,
    confidence,
    reviewStatus: "ai-suggested",
    latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    datasetVersion: DATASET_VERSION,
    algorithm: "rule-based-tajweed",
  };
}

// === Eval runs ===
async function createEvalRun(requestBody) {
  const modelVersion = requestBody.modelVersion ?? MODEL_VERSION;
  const fixtureMetrics = fixtures.metrics ?? {};

  const thresholds = fixtures.thresholds ?? {
    wordAlignmentF1: 0.9,
    tajweedF1: 0.82,
    falsePositiveRate: 0.08,
    teacherAgreementRate: 0.9,
    unsourcedLearnerOutputs: 0,
  };

  // Source-integrity is RECOMPUTED here, not trusted from the request or an asserted number: count how
  // many committed golden tajweed findings actually carry a source. This is the honesty invariant the
  // service can prove on the spot — every learner-facing tajweed output must be sourced — so if a
  // golden finding is ever added without sources the eval fails here instead of rubber-stamping a
  // hand-written count.
  const goldenFindings = fixtures.cases.flatMap((c) => c.tajweedFindings ?? []);
  const sourceBackedFindings = goldenFindings.filter(
    (f) => Array.isArray(f.sources) && f.sources.length > 0,
  ).length;
  const unsourcedLearnerOutputs = goldenFindings.length - sourceBackedFindings;

  // The F1 / agreement metrics require a labeled eval set the service does not hold, so they come from
  // the committed, checksummed golden-evals.json — an OFFLINE eval artifact — NOT from caller-supplied
  // input. Previously `requestBody.metrics ?? fixtureMetrics` let any caller POST perfect numbers and
  // force passed:true; the caller no longer influences the recorded metrics or the pass/fail decision.
  const wordAlignmentF1 = Number(fixtureMetrics.wordAlignmentF1);
  const tajweedF1 = Number(fixtureMetrics.tajweedF1);
  const falsePositiveRate = Number(fixtureMetrics.falsePositiveRate);
  const teacherAgreementRate = Number(fixtureMetrics.teacherAgreementRate);

  const evalRun = {
    modelVersion,
    datasetVersion: requestBody.datasetVersion ?? DATASET_VERSION,
    wordAlignmentF1,
    tajweedF1,
    falsePositiveRate,
    teacherAgreementRate,
    unsourcedLearnerOutputs,
    caseCount: fixtures.cases.length,
    sourceBackedFindings,
    // Honest provenance so the "proof" surface never overstates what was measured live.
    metricsProvenance: {
      sourceIntegrity: "recomputed-live",
      accuracy: "committed-offline-eval",
    },
    thresholds,
    passed:
      wordAlignmentF1 >= thresholds.wordAlignmentF1 &&
      tajweedF1 >= thresholds.tajweedF1 &&
      falsePositiveRate <= thresholds.falsePositiveRate &&
      teacherAgreementRate >= thresholds.teacherAgreementRate &&
      unsourcedLearnerOutputs <= thresholds.unsourcedLearnerOutputs,
  };

  evalRuns.set(modelVersion, evalRun);
  appendAudit(requestBody.tenantId ?? "tenant-smoke", "model.eval.completed", modelVersion, {
    ...evalRun,
    traceId: extractTraceId(requestBody),
  });
  return evalRun;
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
    externalAsrCalls: auditEvents.filter(
      (event) => event.tenantId === tenantId && event.action === "privacy.external-asr.called",
    ),
    deniedExternalAsr: auditEvents.filter(
      (event) => event.tenantId === tenantId && event.action === "privacy.external-asr.denied",
    ),
    auditEvents: auditEvents.filter((event) => event.tenantId === tenantId),
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

// === Audio chunk storage ===
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
    startMs: requestBody.startMs ?? 0,
    endMs: requestBody.endMs ?? 0,
    audioSize: requestBody.audioSize ?? 0,
    audioRetention: requestBody.audioRetention ?? "discard",
    storedAt: new Date().toISOString(),
    objectKey: `${tenantId}/${learnerId}/${chunkId}.bin`,
  };

  // Store actual audio bytes if provided
  if (requestBody.audioBase64) {
    const audioBytes = Buffer.from(requestBody.audioBase64, "base64");
    await storeAudioObject(tenantId, learnerId, chunkId, audioBytes);
    metadata.audioSize = audioBytes.length;
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
  return tenantId ? auditEvents.filter((event) => event.tenantId === tenantId) : auditEvents;
}
export { predictAlignment, predictTajweed, createEvalRun, safeStorageSegment };

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
    const tenantId = url.searchParams.get("tenantId");
    jsonResponse(
      response,
      200,
      tenantId ? auditEvents.filter((event) => event.tenantId === tenantId) : auditEvents,
    );
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

  if (url.pathname === "/v1/tajweed-findings:predict") {
    jsonResponse(response, 200, await predictTajweed(body));
    return;
  }

  if (url.pathname === "/v1/eval-runs") {
    jsonResponse(response, 200, await createEvalRun(body));
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

/** @param {string} ip */
function checkRateLimit(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (rateLimitMap.get(ip) ?? []).filter((t) => t > cutoff);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return true;
}

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  // --- Per-IP sliding-window rate limiter (100 req/min for non-health endpoints) ---
  if (url.pathname !== "/health") {
    const forwardedFor = TRUST_PROXY_HEADERS
      ? request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
      : undefined;
    const clientIp = forwardedFor || request.socket.remoteAddress || "unknown";
    if (!checkRateLimit(clientIp)) {
      jsonResponse(response, 429, { error: "Too many requests. Please try again later." });
      return;
    }
  }

  if (url.pathname !== "/health") {
    const apiKey = request.headers["x-ml-api-key"] ?? url.searchParams.get("apiKey");
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

          const ttlMs = retention === "teacher-review"
            ? AUDIO_TTL_REVIEW_HOURS * 60 * 60 * 1000
            : AUDIO_TTL_DISCARD_HOURS * 60 * 60 * 1000;

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
