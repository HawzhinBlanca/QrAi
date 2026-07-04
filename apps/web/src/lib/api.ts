/**
 * Platform API client — talks to the real Postgres-backed Rust API.
 */

import type { ReviewStatus, SourceReference } from "@quran-ai/contracts";

import { fetchWithTimeout } from "./http";

const API_BASE = import.meta.env.VITE_PLATFORM_API_URL || "http://127.0.0.1:8080";

function actorHeaders(tenantId: string, userId: string, role: string, authToken?: string): Record<string, string> {
  if (authToken) {
    return {
      authorization: `Bearer ${authToken}`,
    };
  }
  return {
    "x-tenant-id": tenantId,
    "x-user-id": userId,
    "x-user-role": role,
  };
}

export interface SurahInfo {
  surahNumber: number;
  ayahCount: number;
  name: string;
  arabicName?: string;
  translation?: string;
  revelationType?: string;
}

export interface AyahWord {
  id: string;
  wordIndex: number;
  text: string;
  sourceChecksum: string;
}

export interface AyahInfo {
  id: string;
  surahNumber: number;
  ayahNumber: number;
  text: string;
  sourceChecksum: string;
  words: AyahWord[];
}

export interface SurahDetail {
  surahNumber: number;
  ayahs: Array<{
    id: string;
    surahNumber: number;
    ayahNumber: number;
    text: string;
    sourceChecksum: string;
  }>;
}

export interface AlignmentResult {
  wordId: string;
  canonicalText: string;
  heardText: string;
  status: "matched" | "misread" | "missed" | "extra" | "needs-review";
  confidence: number;
}

export interface TajweedFinding {
  wordId: string;
  rule: string;
  arabicName: string;
  category: string;
  severity: "practice" | "warning" | "critical";
  explanation: string;
  confidence: number;
  /** Review state of this finding — "ai-suggested" for live practice output (not yet human-reviewed). */
  reviewStatus: ReviewStatus;
  sources: SourceReference[];
}

export interface RecitationConsent {
  /** Affirmative consent to record and analyze the recitation. Required before any recording starts;
   *  the local Quran ASR still processes the audio and it may be stored per audioRetention. */
  recordingConsent: boolean;
  audioRetention: "discard" | "teacher-review" | "training-opt-in";
  anonymizedLearning: boolean;
  externalAsrProcessing: boolean;
  guardianApproved: boolean;
  consentVersion: string;
}

export interface CreatedSession {
  id: string;
  tenantId: string;
  learnerId: string;
}

/**
 * Create a real recitation session (persisted, with the learner's actual consent choices).
 * The returned id is used for the alignment/tajweed calls so the session is traceable.
 */
export async function createRecitationSession(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
  learnerId: string;
  surahNumber: number;
  ayahStart: number;
  ayahEnd: number;
  language: string;
  consent: RecitationConsent;
}): Promise<CreatedSession> {
  const response = await fetchWithTimeout(`${API_BASE}/v1/recitation-sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
    },
    body: JSON.stringify({
      learnerId: params.learnerId,
      quranRef: {
        surahNumber: params.surahNumber,
        ayahStart: params.ayahStart,
        ayahEnd: params.ayahEnd,
        display: `Surah ${params.surahNumber} ${params.ayahStart}-${params.ayahEnd}`,
      },
      sourceChecksum: "tanzil:uthmani:v1",
      modelVersion: "model-v0.3",
      language: params.language,
      mode: "guided-recite",
      practicePlanId: "fatihah-mastery-v1",
      consent: params.consent,
    }),
  });
  if (!response.ok) {
    throw new Error(`Create session ${response.status}`);
  }
  return response.json() as Promise<CreatedSession>;
}

/**
 * Persist a session's computed alignment so it reaches `word_alignments` and becomes visible
 * in the Command console (which reads real alignment, not just seeded demo rows). Synthetic
 * "extra" words are dropped server-side. Best-effort: callers fire-and-forget.
 */
export async function persistSessionAlignments(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
  sessionId: string;
  alignments: AlignmentResult[];
  modelVersion?: string;
}): Promise<{ persisted: number; skippedInvalidStatus: number; skippedUnknownWord: number }> {
  const response = await fetchWithTimeout(
    `${API_BASE}/v1/recitation-sessions/${encodeURIComponent(params.sessionId)}/alignments`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
      },
      body: JSON.stringify({
        modelVersion: params.modelVersion ?? "model-v0.3",
        alignments: params.alignments.map((a) => ({
          wordId: a.wordId,
          heardText: a.heardText ?? "",
          startMs: 0,
          endMs: 0,
          confidence: a.confidence,
          status: a.status,
        })),
      }),
    },
  );
  if (!response.ok) throw new Error(`Persist alignments ${response.status}`);
  return response.json() as Promise<{
    persisted: number;
    skippedInvalidStatus: number;
    skippedUnknownWord: number;
  }>;
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetchWithTimeout(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${path}`);
  }
  return response.json();
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${path}`);
  }
  return response.json();
}

export async function fetchSurahList(): Promise<SurahInfo[]> {
  return fetchJson("/v1/quran/surahs") as Promise<SurahInfo[]>;
}

export async function fetchSurah(surahNumber: number): Promise<SurahDetail> {
  return fetchJson(`/v1/quran/surahs/${surahNumber}`) as Promise<SurahDetail>;
}

export async function fetchAyah(surahNumber: number, ayahNumber: number): Promise<AyahInfo> {
  return fetchJson(`/v1/quran/ayahs/${surahNumber}/${ayahNumber}`) as Promise<AyahInfo>;
}

export async function predictAlignment(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
  sessionId: string;
  surahNumber: number;
  ayahStart: number;
  ayahEnd: number;
  recognizedText?: string[];
}): Promise<{ alignments: AlignmentResult[]; confidence: number }> {
  const response = await fetchWithTimeout(`${API_BASE}/v1/ml/alignments:predict`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
    },
    body: JSON.stringify({
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      quranRef: {
        surahNumber: params.surahNumber,
        ayahStart: params.ayahStart,
        ayahEnd: params.ayahEnd,
        display: `Surah ${params.surahNumber} ${params.ayahStart}-${params.ayahEnd}`,
      },
      ...(params.recognizedText ? { recognizedText: params.recognizedText } : {}),
    }),
  });
  if (!response.ok) throw new Error(`ML alignment ${response.status}`);
  return response.json();
}

export async function predictTajweed(params: {
  tenantId: string;
  userId: string;
  authToken?: string;
  sessionId: string;
  surahNumber: number;
  ayahStart: number;
  ayahEnd: number;
}): Promise<{ findings: TajweedFinding[]; confidence: number }> {
  const response = await fetchWithTimeout(`${API_BASE}/v1/ml/tajweed-findings:predict`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...actorHeaders(params.tenantId, params.userId, "learner", params.authToken),
    },
    body: JSON.stringify({
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      quranRef: {
        surahNumber: params.surahNumber,
        ayahStart: params.ayahStart,
        ayahEnd: params.ayahEnd,
        display: `Surah ${params.surahNumber} ${params.ayahStart}-${params.ayahEnd}`,
      },
    }),
  });
  if (!response.ok) throw new Error(`ML tajweed ${response.status}`);
  return response.json();
}

