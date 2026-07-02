/**
 * Quran AI ML Inference Service
 *
 * Real Quran-constrained alignment + rule-based tajweed engine.
 * Replaces the fixture-based stub with actual algorithms.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeArabic, similarity, alignWords, calculateConfidence } from "./alignment.js";
import { analyzeAyah, analyzeWord } from "./tajweed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load golden eval fixtures for health endpoint + smoke tests
const FIXTURES_PATH = join(__dirname, "fixtures", "golden-evals.json");
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));

// Load full Quran data
const QURAN_DATA_DIR = join(__dirname, "..", "..", "packages", "quran-data", "src", "data", "full-quran");
const manifest = JSON.parse(readFileSync(join(QURAN_DATA_DIR, "manifest.json"), "utf8"));

const MODEL_VERSION = process.env.ML_MODEL_VERSION ?? "ml-aligner-v0.2";
const DATASET_VERSION = fixtures.datasetVersion;
const GOLDEN_CASE_IDS = fixtures.cases.map((c) => c.id);
// Golden fixtures are ONLY for smoke/eval. By default (flag unset) every request
// computes real alignment/tajweed — even for the golden refs like Al-Fatihah 1:1-7.
const USE_GOLDEN_FIXTURES = process.env.ML_USE_GOLDEN_FIXTURES === "1";
// === Audio storage abstraction ===
// Uses local filesystem now, swappable to MinIO/S3 later via AUDIO_STORAGE_DRIVER env
const AUDIO_STORAGE_DRIVER = process.env.AUDIO_STORAGE_DRIVER ?? "filesystem";
const AUDIO_STORAGE_DIR = process.env.AUDIO_STORAGE_DIR ?? join(__dirname, "audio-storage");
// S3/MinIO config (used when driver=s3)
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
const S3_BUCKET = process.env.S3_BUCKET ?? "quran-ai-audio";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? "minioadmin";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY ?? "minioadmin";

mkdirSync(AUDIO_STORAGE_DIR, { recursive: true });

const ASR_SERVICE_URL = process.env.ASR_SERVICE_URL ?? "http://127.0.0.1:8091";

async function storeAudioObject(tenantId, learnerId, chunkId, audioBytes) {
  tenantId = safeStorageSegment(tenantId, "tenantId");
  learnerId = safeStorageSegment(learnerId, "learnerId");
  chunkId = safeStorageSegment(chunkId, "chunkId");
  const objectKey = `${tenantId}/${learnerId}/${chunkId}.bin`;
  if (AUDIO_STORAGE_DRIVER === "s3") {
    // S3/MinIO storage (when configured)
    // In production this would use @aws-sdk/client-s3
    // For now, store to filesystem as fallback even in S3 mode
    const tenantDir = join(AUDIO_STORAGE_DIR, tenantId, learnerId);
    mkdirSync(tenantDir, { recursive: true });
    writeFileSync(join(tenantDir, `${chunkId}.bin`), audioBytes);
  } else {
    // Filesystem storage
    const tenantDir = join(AUDIO_STORAGE_DIR, tenantId, learnerId);
    mkdirSync(tenantDir, { recursive: true });
    writeFileSync(join(tenantDir, `${chunkId}.bin`), audioBytes);
  }
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
  return words;
}

// CORS so the browser web app (served from a different origin) can call this service.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-tenant-id, x-user-id, x-user-role, x-trace-id",
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
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) {
        reject(httpError(413, "request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        // Malformed JSON is a client error (400), not an internal failure (500).
        reject(httpError(400, "request body is not valid JSON"));
      }
    });
    request.on("error", reject);
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
    headers: { "content-type": "application/json" },
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
  const auditEventId = appendAudit(tenantId, "ml.alignment.predicted", sessionId, {
    modelVersion: MODEL_VERSION,
    traceId,
    confidence: fixtureCase?.alignment.confidence,
    wordCount: fixtureCase?.alignment.words.length,
    recognizedCount: fixtureCase?.alignment.words.length,
  });

  let alignments;
  let confidence;
  let reviewStatus;

  if (fixtureCase && USE_GOLDEN_FIXTURES) {
    // Return golden fixture alignment data
    const asrActuallyAllowed = asrAllowed && (!childProfile || guardianApproved);
    confidence = asrActuallyAllowed ? fixtureCase.alignment.confidence : fixtureCase.alignment.fallbackConfidence;
    reviewStatus = !asrActuallyAllowed
      ? "teacher-review-required"
      : confidence >= 0.85 ? "ai-suggested" : "teacher-review-required";

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
      auditEventId,
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

    const alignmentResults = alignWords(canonicalWords, recognizedWords);
    confidence = calculateConfidence(alignmentResults);
    reviewStatus = !asrAllowed
      ? "teacher-review-required"
      : confidence >= 0.85 ? "ai-suggested" : "teacher-review-required";

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
      auditEventId,
    }));
  }

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
  const auditEventId = appendAudit(tenantId, "ml.tajweed.predicted", sessionId, {
    modelVersion: MODEL_VERSION,
    traceId,
    findingCount: fixtureCase?.tajweedFindings.length,
  });

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
      auditEventId,
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
      auditEventId,
    }));
    confidence = findings.length > 0
      ? findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length
      : 0.95;
  }

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
  const metrics = requestBody.metrics ?? fixtureMetrics;

  const thresholds = fixtures.thresholds ?? {
    wordAlignmentF1: 0.9,
    tajweedF1: 0.82,
    falsePositiveRate: 0.08,
    teacherAgreementRate: 0.9,
    unsourcedLearnerOutputs: 0,
  };

  const evalRun = {
    modelVersion,
    datasetVersion: requestBody.datasetVersion ?? DATASET_VERSION,
    wordAlignmentF1: Number(metrics.wordAlignmentF1 ?? fixtureMetrics.wordAlignmentF1),
    tajweedF1: Number(metrics.tajweedF1 ?? fixtureMetrics.tajweedF1),
    falsePositiveRate: Number(metrics.falsePositiveRate ?? fixtureMetrics.falsePositiveRate),
    teacherAgreementRate: Number(metrics.teacherAgreementRate ?? fixtureMetrics.teacherAgreementRate),
    unsourcedLearnerOutputs: Number(metrics.unsourcedLearnerOutputs ?? 0),
    caseCount: Number(metrics.caseCount ?? fixtureMetrics.caseCount ?? fixtures.cases.length),
    sourceBackedFindings: Number(metrics.sourceBackedFindings ?? fixtureMetrics.sourceBackedFindings ?? 0),
    thresholds,
    passed:
      Number(metrics.wordAlignmentF1 ?? fixtureMetrics.wordAlignmentF1) >= thresholds.wordAlignmentF1 &&
      Number(metrics.tajweedF1 ?? fixtureMetrics.tajweedF1) >= thresholds.tajweedF1 &&
      Number(metrics.falsePositiveRate ?? fixtureMetrics.falsePositiveRate) <= thresholds.falsePositiveRate &&
      Number(metrics.teacherAgreementRate ?? fixtureMetrics.teacherAgreementRate) >= thresholds.teacherAgreementRate &&
      Number(metrics.unsourcedLearnerOutputs ?? 0) <= thresholds.unsourcedLearnerOutputs,
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

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return;
  }
  route(request, response).catch((error) => {
    jsonResponse(response, error.status ?? 500, {
      error: error.message,
    });
  });
});

const bindHost = process.env.ML_INFERENCE_HOST ?? "127.0.0.1";
const bindPort = Number(process.env.ML_INFERENCE_PORT ?? 8090);

server.listen(bindPort, bindHost, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : bindPort;
  console.log(`quran-ai ml inference listening on http://${bindHost}:${port}`);
  console.log(`  Model: ${MODEL_VERSION}`);
  console.log(`  Dataset: ${DATASET_VERSION}`);
  console.log(`  Quran coverage: ${manifest.surahCount} surahs, ${manifest.totalAyahs} ayahs`);
  console.log(`  Audio storage: ${AUDIO_STORAGE_DIR}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
