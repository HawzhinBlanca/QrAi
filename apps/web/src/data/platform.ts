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

// Static UI configuration (not mock data — these are app config, not learner data)
export const supportedLanguages: Array<{
  code: SupportedLanguageCode;
  label: string;
  nativeName: string;
  direction: "ltr" | "rtl";
  readiness: "live" | "reviewing" | "pilot";
}> = [
  { code: "ar", label: "Arabic", nativeName: "العربية", direction: "rtl", readiness: "live" },
  { code: "ckb", label: "Kurdish Sorani", nativeName: "کوردیی ناوەندی", direction: "rtl", readiness: "pilot" },
  { code: "en", label: "English", nativeName: "English", direction: "ltr", readiness: "live" },
  { code: "tr", label: "Turkish", nativeName: "Türkçe", direction: "ltr", readiness: "reviewing" },
  { code: "ur", label: "Urdu", nativeName: "اردو", direction: "rtl", readiness: "reviewing" },
  { code: "id", label: "Indonesian", nativeName: "Indonesia", direction: "ltr", readiness: "reviewing" },
  { code: "ms", label: "Malay", nativeName: "Melayu", direction: "ltr", readiness: "reviewing" },
  { code: "fr", label: "French", nativeName: "Français", direction: "ltr", readiness: "reviewing" },
  { code: "de", label: "German", nativeName: "Deutsch", direction: "ltr", readiness: "reviewing" },
];

export const platformApps = [
  { id: "learner", label: "Learner", icon: AudioWaveform, description: "Live alignment and memorization" },
  { id: "teacher", label: "Teacher", icon: GraduationCap, description: "Classrooms and review loops" },
  { id: "scholar", label: "Scholar", icon: BookCheck, description: "Approved religious content" },
  { id: "model-ops", label: "Model Ops", icon: Microscope, description: "Benchmarks and data flywheel" },
] as const;

export const platformTabs = [
  { id: "recitation", label: "Recitation", icon: AudioWaveform },
  { id: "classroom", label: "Classroom", icon: UsersRound },
  { id: "review", label: "Review", icon: ShieldCheck },
  { id: "model-ops", label: "Model Ops", icon: LineChart },
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
  { label: "Canonical Quran text", status: "locked", icon: BookCheck },
  { label: "Human reviewed", status: "teacher + scholar gates", icon: ShieldCheck },
  { label: "9 languages", status: "UI ready, content gated", icon: Languages },
  { label: "Data flywheel", status: "opt-in only", icon: Bot },
];

// === Real API-backed data ===

const API_BASE = import.meta.env.VITE_PLATFORM_API_URL || "http://127.0.0.1:8080";

export interface LearnerProgress {
  learnerId: string;
  tenantId: string;
  totalSessions: number;
  streak: number;
  mastery: number;
  nextReviewAt: string | null;
}

export async function fetchLearnerProgress(tenantId: string, userId: string): Promise<LearnerProgress> {
  const response = await fetch(`${API_BASE}/v1/learner/progress`, {
    headers: {
      "x-tenant-id": tenantId,
      "x-user-id": userId,
      "x-user-role": "learner",
    },
  });
  if (!response.ok) throw new Error(`Progress API ${response.status}`);
  return response.json();
}

export interface MemorizationPlan {
  learnerId: string;
  nextReviewAt: string;
  currentFocus: string;
  intervals: Array<{ label: string; dueCount: number; retention: number }>;
}

export async function fetchMemorizationPlan(tenantId: string, userId: string): Promise<MemorizationPlan | null> {
  try {
    const progress = await fetchLearnerProgress(tenantId, userId);
    return {
      learnerId: progress.learnerId,
      nextReviewAt: progress.nextReviewAt ?? "Not scheduled",
      currentFocus: "Al-Fatihah stability before Al-Baqarah opener",
      intervals: [
        { label: "Today", dueCount: Math.min(progress.totalSessions, 4), retention: progress.mastery || 0.5 },
        { label: "3 days", dueCount: 0, retention: 0 },
        { label: "7 days", dueCount: 0, retention: 0 },
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

export async function fetchEvalRun(tenantId: string, modelVersion: string): Promise<EvalRun | null> {
  try {
    const response = await fetch(`${API_BASE}/v1/eval-runs/${modelVersion}`, {
      headers: {
        "x-tenant-id": tenantId,
        "x-user-id": "admin-1",
        "x-user-role": "admin",
      },
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export interface BenchmarkMetric {
  label: string;
  value: string;
  target: string;
  status: "passing" | "watch" | "blocked";
}

export async function fetchBenchmarkMetrics(tenantId: string): Promise<BenchmarkMetric[]> {
  const evalRun = await fetchEvalRun(tenantId, "model-v0.3");
  if (!evalRun) return [];
  return [
    { label: "Word alignment F1", value: evalRun.wordAlignmentF1.toFixed(2), target: "≥0.90", status: evalRun.wordAlignmentF1 >= 0.9 ? "passing" : "watch" },
    { label: "Tajweed F1", value: evalRun.tajweedF1.toFixed(2), target: "≥0.82", status: evalRun.tajweedF1 >= 0.82 ? "passing" : "watch" },
    { label: "False-positive rate", value: `${(evalRun.falsePositiveRate * 100).toFixed(1)}%`, target: "≤8%", status: evalRun.falsePositiveRate <= 0.08 ? "passing" : "watch" },
    { label: "Teacher agreement", value: `${(evalRun.teacherAgreementRate * 100).toFixed(0)}%`, target: "≥90%", status: evalRun.teacherAgreementRate >= 0.9 ? "passing" : "watch" },
    { label: "Unsourced outputs", value: String(evalRun.unsourcedLearnerOutputs), target: "0", status: evalRun.unsourcedLearnerOutputs === 0 ? "passing" : "blocked" },
  ];
}

// === Internal Command console data (admin/teacher/scholar/model-ops views) ===
// Real, DB-backed reads. Header-auth admin identity works in dev (ALLOW_HEADER_AUTH=1);
// production requires a real admin/ops JWT (platform-api gates header auth off by default).

const ADMIN_HEADERS = (tenantId: string): Record<string, string> => ({
  "x-tenant-id": tenantId,
  "x-user-id": "admin-1",
  "x-user-role": "admin",
});

async function fetchConsole<T>(path: string, tenantId: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${API_BASE}${path}`, { headers: ADMIN_HEADERS(tenantId) });
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

export function fetchAgentRuns(tenantId: string): Promise<AgentRunSummary[]> {
  return fetchConsole<AgentRunSummary[]>("/v1/agent-runs", tenantId, []);
}

export interface ScholarApprovalSummary {
  id: string;
  topic: string;
  reviewer: string;
  status: "draft" | "scholar-approved" | "blocked";
  risk: "low" | "medium" | "high";
  sourceCount: number;
}

export function fetchScholarApprovals(tenantId: string): Promise<ScholarApprovalSummary[]> {
  return fetchConsole<ScholarApprovalSummary[]>("/v1/scholar-approvals", tenantId, []);
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

export function fetchTeacherReviewQueue(tenantId: string): Promise<TeacherReviewItem[]> {
  return fetchConsole<TeacherReviewItem[]>("/v1/teacher-review-queue", tenantId, []);
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

export function fetchTajweedFindings(tenantId: string): Promise<TajweedFindingSummary[]> {
  return fetchConsole<TajweedFindingSummary[]>("/v1/tajweed-findings", tenantId, []);
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

export function fetchRecitationSessions(tenantId: string): Promise<RecitationSessionSummary[]> {
  return fetchConsole<RecitationSessionSummary[]>("/v1/recitation-sessions", tenantId, []);
}

export function fetchSessionAlignments(tenantId: string, sessionId: string): Promise<SessionAlignment[]> {
  return fetchConsole<SessionAlignment[]>(
    `/v1/recitation-sessions/${sessionId}/alignments`,
    tenantId,
    [],
  );
}

// Currently deployed model version (matches the seeded eval run surfaced in benchmarks).
export const DEPLOYED_MODEL_VERSION = "model-v0.3";
