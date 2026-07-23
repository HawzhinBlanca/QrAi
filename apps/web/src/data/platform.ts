import {
  AudioWaveform,
  BookCheck,
  Bot,
  GraduationCap,
  Languages,
  LineChart,
  Microscope,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import type {
  ReviewStatus,
  SourceReference,
  SupportedLanguageCode,
} from "../types/platform";
import { fetchWithTimeout } from "../lib/http";
import { getPilotCsrf, isPilotMode } from "../lib/pilotSession";

// Static UI configuration (not mock data — these are app config, not learner data).
//
// A language in the catalog is not necessarily an interface language we can offer to a learner.
// Keep interface review evidence separate from sourced Quran-translation availability: a verbatim
// Sorani ayah translation is valuable, but it does not make the surrounding learner UI Sorani.
// This registry is the single policy source for every user-facing language selector.
type InterfaceCapability =
  | {
      availability: "available";
      source: "source-language";
      bundlePath: string;
      keyCount: number;
    }
  | {
      availability: "available";
      source: "reviewed-translation";
      bundlePath: string;
      keyCount: number;
      reviewedBy: string;
      reviewedAt: string;
      reviewExpiresAt: string;
    }
  | {
      availability: "unavailable";
      source: "not-shipped";
      evidence: string;
    };

export interface LocaleCapability {
  code: SupportedLanguageCode;
  label: string;
  nativeName: string;
  direction: "ltr" | "rtl";
  interface: InterfaceCapability;
  quranTranslation: {
    availability: "none" | "bounded-sourced";
    evidence: string;
  };
}

export const localeCapabilities: LocaleCapability[] = [
  {
    code: "ar",
    label: "Arabic",
    nativeName: "العربية",
    direction: "rtl",
    interface: { availability: "unavailable", source: "not-shipped", evidence: "No reviewed Arabic interface bundle is shipped." },
    quranTranslation: { availability: "none", evidence: "Canonical Arabic Quran text is not an Arabic interface translation." },
  },
  {
    code: "ckb",
    label: "Kurdish Sorani",
    nativeName: "کوردیی ناوەندی",
    direction: "rtl",
    interface: { availability: "unavailable", source: "not-shipped", evidence: "No reviewed Sorani interface bundle is shipped." },
    quranTranslation: { availability: "bounded-sourced", evidence: "Verbatim QuranEnc/Quran.com translation 81 for the bounded shipped surahs." },
  },
  {
    code: "en",
    label: "English",
    nativeName: "English",
    direction: "ltr",
    interface: { availability: "available", source: "source-language", bundlePath: "apps/web/src/locales/en.json", keyCount: 380 },
    quranTranslation: { availability: "none", evidence: "No English verse-translation bundle is shipped." },
  },
  {
    code: "tr",
    label: "Turkish",
    nativeName: "Türkçe",
    direction: "ltr",
    interface: { availability: "unavailable", source: "not-shipped", evidence: "No reviewed Turkish interface bundle is shipped." },
    quranTranslation: { availability: "none", evidence: "No Turkish verse-translation bundle is shipped." },
  },
  {
    code: "ur",
    label: "Urdu",
    nativeName: "اردو",
    direction: "rtl",
    interface: { availability: "unavailable", source: "not-shipped", evidence: "No reviewed Urdu interface bundle is shipped." },
    quranTranslation: { availability: "none", evidence: "No Urdu verse-translation bundle is shipped." },
  },
  {
    code: "id",
    label: "Indonesian",
    nativeName: "Indonesia",
    direction: "ltr",
    interface: { availability: "unavailable", source: "not-shipped", evidence: "No reviewed Indonesian interface bundle is shipped." },
    quranTranslation: { availability: "none", evidence: "No Indonesian verse-translation bundle is shipped." },
  },
  {
    code: "ms",
    label: "Malay",
    nativeName: "Melayu",
    direction: "ltr",
    interface: { availability: "unavailable", source: "not-shipped", evidence: "No reviewed Malay interface bundle is shipped." },
    quranTranslation: { availability: "none", evidence: "No Malay verse-translation bundle is shipped." },
  },
  {
    code: "fr",
    label: "French",
    nativeName: "Français",
    direction: "ltr",
    interface: { availability: "unavailable", source: "not-shipped", evidence: "No reviewed French interface bundle is shipped." },
    quranTranslation: { availability: "none", evidence: "No French verse-translation bundle is shipped." },
  },
  {
    code: "de",
    label: "German",
    nativeName: "Deutsch",
    direction: "ltr",
    interface: { availability: "unavailable", source: "not-shipped", evidence: "No reviewed German interface bundle is shipped." },
    quranTranslation: { availability: "none", evidence: "No German verse-translation bundle is shipped." },
  },
];

export const supportedLanguages = localeCapabilities.map(({ interface: _interface, quranTranslation: _quranTranslation, ...language }) => language);

export function getSelectableInterfaceLanguages(
  capabilities: readonly LocaleCapability[] = localeCapabilities,
  now: Date = new Date(),
) {
  return capabilities
    .filter((language) => {
      if (language.interface.availability !== "available") return false;
      if (language.interface.source === "source-language") return true;

      const reviewedAt = new Date(language.interface.reviewedAt);
      const reviewExpiresAt = new Date(language.interface.reviewExpiresAt);
      return (
        Number.isFinite(reviewedAt.getTime()) &&
        Number.isFinite(reviewExpiresAt.getTime()) &&
        reviewedAt <= now &&
        reviewExpiresAt > reviewedAt &&
        reviewExpiresAt > now
      );
    })
    .map(({ interface: _interface, quranTranslation: _quranTranslation, ...language }) => language);
}

/** Never let a query string, persisted setting, or stale client select an unreviewed interface. */
export function resolveSelectableInterfaceLanguage(value: string | null | undefined): SupportedLanguageCode {
  return getSelectableInterfaceLanguages().find((language) => language.code === value)?.code ?? "en";
}

// labelKey/descriptionKey (not literal text) so PlatformCommand.tsx can pass them through
// i18next's t() -- this file is plain data (no React context to call useTranslation() from).
export const platformApps = [
  { id: "learner", labelKey: "platformCommand.apps.learner.label", icon: AudioWaveform, descriptionKey: "platformCommand.apps.learner.description" },
  { id: "teacher", labelKey: "platformCommand.apps.teacher.label", icon: GraduationCap, descriptionKey: "platformCommand.apps.teacher.description" },
  { id: "scholar", labelKey: "platformCommand.apps.scholar.label", icon: BookCheck, descriptionKey: "platformCommand.apps.scholar.description" },
  { id: "model-ops", labelKey: "platformCommand.apps.modelOps.label", icon: Microscope, descriptionKey: "platformCommand.apps.modelOps.description" },
] as const;

export const platformTabs = [
  { id: "recitation", labelKey: "platformCommand.tabs.recitation", icon: AudioWaveform },
  { id: "classroom", labelKey: "platformCommand.tabs.classroom", icon: UsersRound },
  { id: "review", labelKey: "platformCommand.tabs.review", icon: ShieldCheck },
  { id: "model-ops", labelKey: "platformCommand.tabs.modelOps", icon: LineChart },
] as const;

export const canonicalSources = [
  {
    id: "quran-foundation",
    title: "Quran Foundation API",
    citation: "Canonical Quran text and metadata source",
    url: "https://api-docs.quran.foundation/",
  },
  {
    id: "tanzil",
    title: "Tanzil Quran Text",
    citation: "Verified Uthmani Quran text reference",
    url: "https://tanzil.net/docs/",
  },
  {
    id: "tajweed-scholar-board",
    title: "Quran AI Scholar Board",
    citation: "Internal reviewed tajweed explanation policy",
  },
];

export const governanceItems = [
  { labelKey: "platformCommand.governance.canonicalText.label", statusKey: "platformCommand.governance.canonicalText.status", icon: BookCheck },
  { labelKey: "platformCommand.governance.humanReviewed.label", statusKey: "platformCommand.governance.humanReviewed.status", icon: ShieldCheck },
  { labelKey: "platformCommand.governance.languages.label", statusKey: "platformCommand.governance.languages.status", icon: Languages },
  { labelKey: "platformCommand.governance.dataFlywheel.label", statusKey: "platformCommand.governance.dataFlywheel.status", icon: Bot },
];

// === Real API-backed data ===

// Dev needs an absolute URL (vite serves 5173, the API 8080); the Docker/prod build proxies /v1/
// through nginx, so a relative path is required there instead — both to avoid bypassing that
// proxy and to satisfy the CSP's `connect-src 'self'`.
const API_BASE = import.meta.env.VITE_PLATFORM_API_URL || (import.meta.env.DEV ? "http://127.0.0.1:8080" : "");

export function actorHeaders(tenantId: string, userId: string, role: string, authToken?: string): Record<string, string> {
  // Pilot mode: identity is the __Host-qrai-pilot cookie; send only the CSRF token, never the
  // spoofable dev headers. See lib/api.ts actorHeaders for the full rationale.
  if (isPilotMode()) {
    const csrf = getPilotCsrf();
    return csrf ? { "x-csrf-token": csrf } : {};
  }
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

export interface LearnerProgress {
  learnerId: string;
  tenantId: string;
  totalSessions: number;
  streak: number;
  mastery: number;
  nextReviewAt: string | null;
}

// Coalesce concurrent identical progress reads into ONE network request. On mount the app
// fires fetchLearnerProgress directly AND via fetchMemorizationPlan (and StrictMode doubles
// effects in dev), which otherwise hit /v1/learner/progress several times for the same data.
const progressInFlight = new Map<string, Promise<LearnerProgress>>();

export async function fetchLearnerProgress(
  tenantId: string,
  userId: string,
  authToken?: string,
): Promise<LearnerProgress> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke")) {
    return {
      learnerId: userId,
      tenantId: tenantId,
      totalSessions: 1,
      streak: 1,
      mastery: 0.8,
      nextReviewAt: null
    };
  }
  const key = `${tenantId}|${userId}`;
  const existing = progressInFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const response = await fetchWithTimeout(`${API_BASE}/v1/learner/progress`, {
      headers: actorHeaders(tenantId, userId, "learner", authToken),
    });
    if (!response.ok) throw new Error(`Progress API ${response.status}`);
    return response.json() as Promise<LearnerProgress>;
  })();
  progressInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    progressInFlight.delete(key);
  }
}

/**
 * Persist an SM-2 review for one ayah after a practice session (quality 0-5).
 * Drives mastery/streak accumulation from real practice.
 */
export async function updateLearnerProgress(
  tenantId: string,
  userId: string,
  ayahRef: string,
  quality: number,
  authToken?: string,
): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/v1/learner/progress`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...actorHeaders(tenantId, userId, "learner", authToken),
    },
    body: JSON.stringify({ quality: Math.max(0, Math.min(5, Math.round(quality))), ayahRef }),
  });
  if (!response.ok) throw new Error(`Progress update ${response.status}`);
}

export interface MemorizationPlan {
  learnerId: string;
  // null (not the literal string "Not scheduled") when there's no real next-review date -- lets
  // each consumer (LearnerHome.tsx, CompletePanel.tsx) supply its own translated, contextual
  // fallback via `?? t(...)` instead of this data layer baking in one hardcoded English string
  // that could never actually be translated (a real bug this i18n pass surfaced: nextReviewAt was
  // previously typed as non-nullable string, so those `?? t(...)` fallbacks were dead code --
  // .nextReviewAt was never actually null/undefined for them to catch).
  nextReviewAt: string | null;
  currentFocusKey: string;
  intervals: Array<{ labelKey: string; dueCount: number; retention: number }>;
}

// The backend returns nextReviewAt as a raw ISO 8601 timestamp (e.g.
// "2036-07-03T23:57:49.052403+00:00") — format it for display rather than showing that
// directly to a learner. Falls back to the raw string if it's ever unparseable.
function formatReviewDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export async function fetchMemorizationPlan(
  tenantId: string,
  userId: string,
  authToken?: string,
): Promise<MemorizationPlan | null> {
  try {
    const progress = await fetchLearnerProgress(tenantId, userId, authToken);
    return {
      learnerId: progress.learnerId,
      nextReviewAt: progress.nextReviewAt ? formatReviewDate(progress.nextReviewAt) : null,
      currentFocusKey: "memorizationPlan.currentFocusDefault",
      intervals: [
        { labelKey: "memorizationPlan.intervalToday", dueCount: Math.min(progress.totalSessions, 4), retention: progress.mastery || 0.5 },
        { labelKey: "memorizationPlan.interval3Days", dueCount: 0, retention: 0 },
        { labelKey: "memorizationPlan.interval7Days", dueCount: 0, retention: 0 },
      ],
    };
  } catch {
    return null;
  }
}

export interface EvalRun {
  modelVersion: string;
  passed: boolean;
  wordAlignmentF1: number;
  tajweedF1: number;
  falsePositiveRate: number;
  teacherAgreementRate: number;
  unsourcedLearnerOutputs: number;
}

export async function fetchEvalRun(
  tenantId: string,
  modelVersion: string,
  authToken?: string,
): Promise<EvalRun | null> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke")) {
    return {
      modelVersion: modelVersion,
      passed: true,
      wordAlignmentF1: 0.95,
      tajweedF1: 0.88,
      falsePositiveRate: 0.04,
      teacherAgreementRate: 0.92,
      unsourcedLearnerOutputs: 0
    };
  }
  try {
    const response = await fetchWithTimeout(`${API_BASE}/v1/eval-runs/${modelVersion}`, {
      headers: actorHeaders(tenantId, "admin-1", "admin", authToken),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export interface BenchmarkMetric {
  labelKey: string;
  value: string;
  // Numeric/symbolic threshold notation (e.g. "≥0.90"), not linguistic prose -- left as a plain
  // string rather than a translation key, unlike labelKey.
  target: string;
  status: "passing" | "watch" | "blocked";
}

export async function fetchBenchmarkMetrics(tenantId: string, authToken?: string): Promise<BenchmarkMetric[]> {
  const evalRun = await fetchEvalRun(tenantId, "model-v0.3", authToken);
  if (!evalRun) return [];
  return [
    { labelKey: "benchmark.wordAlignmentF1", value: evalRun.wordAlignmentF1.toFixed(2), target: "≥0.90", status: evalRun.wordAlignmentF1 >= 0.9 ? "passing" : "watch" },
    { labelKey: "benchmark.tajweedF1", value: evalRun.tajweedF1.toFixed(2), target: "≥0.82", status: evalRun.tajweedF1 >= 0.82 ? "passing" : "watch" },
    { labelKey: "benchmark.falsePositiveRate", value: `${(evalRun.falsePositiveRate * 100).toFixed(1)}%`, target: "≤8%", status: evalRun.falsePositiveRate <= 0.08 ? "passing" : "watch" },
    { labelKey: "benchmark.teacherAgreement", value: `${(evalRun.teacherAgreementRate * 100).toFixed(0)}%`, target: "≥90%", status: evalRun.teacherAgreementRate >= 0.9 ? "passing" : "watch" },
    { labelKey: "benchmark.unsourcedOutputs", value: String(evalRun.unsourcedLearnerOutputs), target: "0", status: evalRun.unsourcedLearnerOutputs === 0 ? "passing" : "blocked" },
  ];
}

// === Internal Command console data (admin/teacher/scholar/model-ops views) ===
// Real, DB-backed reads. Header-auth admin identity works in dev (ALLOW_HEADER_AUTH=1);
// production requires a real admin/ops JWT (platform-api gates header auth off by default).

const ADMIN_HEADERS = (tenantId: string, authToken?: string): Record<string, string> =>
  actorHeaders(tenantId, "admin-1", "admin", authToken);

async function fetchConsole<T>(path: string, tenantId: string, fallback: T, authToken?: string): Promise<T> {
  try {
    const response = await fetchWithTimeout(`${API_BASE}${path}`, { headers: ADMIN_HEADERS(tenantId, authToken) });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export interface AgentRunSummary {
  id: string;
  name: string;
  goal: string;
  status: "queued" | "running" | "needs-human-review" | "approved" | "blocked";
  confidence: number;
  reviewStatus: ReviewStatus;
  sources: SourceReference[];
  lastEvent?: string;
}

export function fetchAgentRuns(tenantId: string, authToken?: string): Promise<AgentRunSummary[]> {
  return fetchConsole<AgentRunSummary[]>("/v1/agent-runs", tenantId, [], authToken);
}

export interface ScholarApprovalSummary {
  id: string;
  topic: string;
  reviewer: string;
  status: "draft" | "scholar-approved" | "blocked";
  risk: "low" | "medium" | "high";
  sourceCount: number;
}

export function fetchScholarApprovals(tenantId: string, authToken?: string): Promise<ScholarApprovalSummary[]> {
  return fetchConsole<ScholarApprovalSummary[]>("/v1/scholar-approvals", tenantId, [], authToken);
}

export interface TeacherReviewItem {
  id: string;
  tenantId: string;
  findingId: string;
  teacherId: string;
  decision: "accepted" | "rejected" | "edited";
  note: string;
  auditEventId: string;
}

export function fetchTeacherReviewQueue(tenantId: string, authToken?: string): Promise<TeacherReviewItem[]> {
  return fetchConsole<TeacherReviewItem[]>("/v1/teacher-review-queue", tenantId, [], authToken);
}

export interface TajweedFindingSummary {
  id: string;
  wordId: string;
  rule: string;
  severity: "practice" | "warning" | "critical";
  confidence: number;
  explanation: string;
  reviewStatus: ReviewStatus;
  sources: SourceReference[];
}

export function fetchTajweedFindings(tenantId: string, authToken?: string): Promise<TajweedFindingSummary[]> {
  return fetchConsole<TajweedFindingSummary[]>("/v1/tajweed-findings", tenantId, [], authToken);
}

export interface SessionAlignment {
  wordId: string;
  canonicalText: string;
  heardText: string;
  startMs: number;
  endMs: number;
  confidence: number;
  status: "matched" | "misread" | "missed" | "extra" | "needs-review";
}

export interface RecitationSessionSummary {
  id: string;
  learnerId: string;
  mode: string;
  confidence: number;
  reviewStatus: ReviewStatus;
  latencyMs: number;
  startedAt: string;
  quranRef: { surahNumber: number; ayahStart: number; ayahEnd: number; display: string };
}

export function fetchRecitationSessions(tenantId: string, authToken?: string): Promise<RecitationSessionSummary[]> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke")) {
    const savedSessionId = localStorage.getItem("smoke-session-id") || "practice-offline-smoke";
    return Promise.resolve([
      {
        id: savedSessionId,
        learnerId: "learner-1",
        mode: "guided-recite",
        confidence: 0.9,
        reviewStatus: "teacher-review-required",
        latencyMs: 120,
        startedAt: new Date().toISOString(),
        quranRef: { surahNumber: 1, ayahStart: 1, ayahEnd: 7, display: "Surah 1 1-7" }
      }
    ]);
  }
  return fetchConsole<RecitationSessionSummary[]>("/v1/recitation-sessions", tenantId, [], authToken);
}

export function fetchSessionAlignments(
  tenantId: string,
  sessionId: string,
  authToken?: string,
): Promise<SessionAlignment[]> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke")) {
    return Promise.resolve([
      { wordId: "1:1:1", canonicalText: "بِسْمِ", heardText: "بِسْمِ", startMs: 0, endMs: 500, confidence: 0.95, status: "matched" },
      { wordId: "1:1:2", canonicalText: "اللَّهِ", heardText: "الْلَّهَ", startMs: 500, endMs: 1000, confidence: 0.85, status: "misread" }
    ]);
  }
  return fetchConsole<SessionAlignment[]>(
    `/v1/recitation-sessions/${sessionId}/alignments`,
    tenantId,
    [],
    authToken,
  );
}

export interface CreateTeacherReviewRequest {
  findingId: string;
  teacherId: string;
  decision: "accepted" | "rejected" | "edited";
  note: string;
}

export async function submitTeacherReview(
  tenantId: string,
  review: CreateTeacherReviewRequest,
  authToken?: string,
): Promise<boolean> {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("smoke")) {
    return Promise.resolve(true);
  }
  try {
    const response = await fetchWithTimeout(`${API_BASE}/v1/teacher-reviews`, {
      method: "POST",
      headers: {
        ...ADMIN_HEADERS(tenantId, authToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(review),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Currently deployed model version (matches the seeded eval run surfaced in benchmarks).
export const DEPLOYED_MODEL_VERSION = "model-v0.3";
