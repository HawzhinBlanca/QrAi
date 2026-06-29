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

// === Internal platform demo data (admin/teacher/scholar views) ===
// These are used by PlatformCommand for internal views. Not learner-facing.
// Will be replaced by real API calls when admin endpoints are built.

import type {
  AgentRun,
  BenchmarkMetric as BenchmarkMetricType,
  MemorizationPlan as MemorizationPlanType,
  RecitationSession,
  ScholarApproval,
  TajweedFinding,
  TeacherReview,
  TraceableRecord,
  WordAlignment,
  QuranReference,
  SourceReference,
} from "../types/platform";

const fatihahRef: QuranReference = {
  surahNumber: 1,
  ayahStart: 1,
  ayahEnd: 7,
  display: "Al-Fatihah 1:1-7",
};

function traceRecord(evidenceId: string, overrides: Partial<TraceableRecord> = {}): TraceableRecord {
  return {
    tenantId: "tenant-hikmah-kri",
    quranRef: fatihahRef,
    sourceChecksum: "tanzil:uthmani:al-fatihah:v1",
    evidenceId,
    modelVersion: "Model v0.3",
    confidence: 0.9,
    reviewStatus: "teacher-reviewed",
    createdBy: "system",
    auditEventId: `audit-${evidenceId}`,
    ...overrides,
  };
}

export const activeSession: RecitationSession = {
  ...traceRecord("session-kri-00031", {
    confidence: 0.86,
    createdBy: "learner-1842",
    reviewStatus: "teacher-reviewed",
  }),
  id: "session-kri-00031",
  learnerId: "learner-1842",
  learnerName: "Soran Othman",
  institutionId: "hikmah-pilot-erbil",
  surah: "Al-Fatihah",
  ayahRange: "1:1-7",
  language: "ckb",
  startedAt: "2026-06-23T19:40:00Z",
  latencyMs: 428,
  mode: "guided-recite",
  practicePlanId: "mem-plan-1842",
  externalProcessingAllowed: false,
  consent: {
    audioRetention: "teacher-review",
    anonymizedLearning: true,
    externalAsrProcessing: false,
    guardianApproved: true,
    consentVersion: "pilot-consent-v1",
  },
};

export const alignments: WordAlignment[] = [
  {
    ...traceRecord("alignment-1-5-4", {
      quranRef: { ...fatihahRef, ayahStart: 5, ayahEnd: 5, wordStart: 4, wordEnd: 4, display: "Al-Fatihah 1:5:4" },
      confidence: 0.84,
      createdBy: "ml-aligner-v0.1",
      reviewStatus: "teacher-reviewed",
    }),
    wordId: "1:5:4",
    canonicalText: "نَسْتَعِينُ",
    heardText: "نَسْتَغِينُ",
    startMs: 17020,
    endMs: 18480,
    status: "misread",
  },
  {
    ...traceRecord("alignment-1-6-2", {
      quranRef: { ...fatihahRef, ayahStart: 6, ayahEnd: 6, wordStart: 2, wordEnd: 2, display: "Al-Fatihah 1:6:2" },
      confidence: 0.79,
      createdBy: "ml-aligner-v0.1",
      reviewStatus: "ai-suggested",
    }),
    wordId: "1:6:2",
    canonicalText: "الصِّرَاطَ",
    heardText: "السِّرَاطَ",
    startMs: 23240,
    endMs: 24680,
    status: "needs-review",
  },
  {
    ...traceRecord("alignment-1-7-4", {
      quranRef: { ...fatihahRef, ayahStart: 7, ayahEnd: 7, wordStart: 4, wordEnd: 4, display: "Al-Fatihah 1:7:4" },
      confidence: 0.72,
      createdBy: "ml-aligner-v0.1",
      reviewStatus: "ai-suggested",
    }),
    wordId: "1:7:4",
    canonicalText: "عَلَيْهِمْ",
    heardText: "",
    startMs: 31340,
    endMs: 32020,
    status: "missed",
  },
];

export const tajweedFindings: TajweedFinding[] = [
  {
    ...traceRecord("finding-ayn-exit", {
      quranRef: { ...fatihahRef, ayahStart: 5, ayahEnd: 5, wordStart: 4, wordEnd: 4, display: "Al-Fatihah 1:5:4" },
      confidence: 0.84,
      reviewStatus: "teacher-reviewed",
      createdBy: "tajweed-classifier-v0.1",
    }),
    id: "finding-ayn-exit",
    wordId: "1:5:4",
    rule: "Makhraj of ع",
    severity: "warning",
    explanation: "The model suggests the middle-throat sound drifted toward غ. Teacher review is requested.",
    sources: [canonicalSources[2]],
  },
  {
    ...traceRecord("finding-sad-tafkhim", {
      quranRef: { ...fatihahRef, ayahStart: 6, ayahEnd: 6, wordStart: 2, wordEnd: 2, display: "Al-Fatihah 1:6:2" },
      confidence: 0.79,
      reviewStatus: "ai-suggested",
      createdBy: "tajweed-classifier-v0.1",
    }),
    id: "finding-sad-tafkhim",
    wordId: "1:6:2",
    rule: "Tafkhim of ص",
    severity: "practice",
    explanation: "The ص appears light. Phrase feedback stays advisory until scholar-approved examples are attached.",
    sources: [canonicalSources[2]],
  },
];

export const memorizationPlan: MemorizationPlanType = {
  ...traceRecord("mem-plan-1842", {
    confidence: 0.88,
    createdBy: "memorization-planner-v0.1",
    reviewStatus: "teacher-reviewed",
  }),
  id: "mem-plan-1842",
  learnerId: activeSession.learnerId,
  horizonDays: 42,
  currentFocus: "Al-Fatihah stability before Al-Baqarah opener",
  nextReviewAt: "Tonight 20:30",
  intervals: [
    { label: "Today", dueCount: 4, retention: 0.9 },
    { label: "3 days", dueCount: 9, retention: 0.84 },
    { label: "7 days", dueCount: 12, retention: 0.78 },
  ],
};

export const teacherReviews: TeacherReview[] = [
  {
    ...traceRecord("teacher-review-1", {
      confidence: 0.91,
      reviewStatus: "teacher-reviewed",
      createdBy: "teacher-ustadh-barzan",
    }),
    id: "teacher-review-1",
    teacherName: "Ustadh Barzan",
    classroomName: "Hikmah Erbil Pilot",
    pendingCount: 18,
    medianReviewMinutes: 6,
    agreementRate: 0.91,
  },
  {
    ...traceRecord("teacher-review-2", {
      confidence: 0.88,
      reviewStatus: "teacher-reviewed",
      createdBy: "teacher-ustadha-rojin",
    }),
    id: "teacher-review-2",
    teacherName: "Ustadha Rojin",
    classroomName: "Family Plan Cohort A",
    pendingCount: 11,
    medianReviewMinutes: 4,
    agreementRate: 0.88,
  },
];

export const scholarApprovals: ScholarApproval[] = [
  {
    ...traceRecord("scholar-approval-1", {
      confidence: 0.94,
      reviewStatus: "scholar-approved",
      createdBy: "scholar-board",
    }),
    id: "scholar-approval-1",
    topic: "Tajweed explanation for ع vs غ",
    reviewer: "Scholar Board",
    status: "scholar-approved",
    risk: "low",
    sourceCount: 3,
  },
  {
    ...traceRecord("scholar-approval-2", {
      confidence: 0.66,
      reviewStatus: "draft",
      createdBy: "curriculum-builder-agent",
    }),
    id: "scholar-approval-2",
    topic: "Mutashabihat examples in Al-Fatihah lesson",
    reviewer: "Pending reviewer",
    status: "draft",
    risk: "medium",
    sourceCount: 1,
  },
  {
    ...traceRecord("scholar-approval-3", {
      confidence: 0.97,
      reviewStatus: "blocked",
      createdBy: "policy-gate",
    }),
    id: "scholar-approval-3",
    topic: "Unsupported religious ruling response",
    reviewer: "Policy gate",
    status: "blocked",
    risk: "high",
    sourceCount: 0,
  },
];

export const agentRuns: AgentRun[] = [
  {
    ...traceRecord("agent-run-recitation", {
      confidence: 0.86,
      reviewStatus: "teacher-reviewed",
      createdBy: "recitation-coach-agent",
    }),
    id: "agent-run-recitation",
    name: "Recitation Coach",
    goal: "Explain the flagged word without making a religious ruling.",
    status: "approved",
    sources: [canonicalSources[0], canonicalSources[2]],
    lastEvent: "Teacher accepted revised learner-facing explanation.",
  },
  {
    ...traceRecord("agent-run-tajweed", {
      confidence: 0.78,
      reviewStatus: "ai-suggested",
      createdBy: "tajweed-explainer-agent",
      modelVersion: "gpt-5.5",
    }),
    id: "agent-run-tajweed",
    name: "Tajweed Explainer",
    goal: "Generate nine-language micro-drill for ص tafkhim.",
    status: "needs-human-review",
    sources: [canonicalSources[2]],
    lastEvent: "Awaiting scholar-approved example text.",
  },
  {
    ...traceRecord("agent-run-localization", {
      confidence: 0.82,
      reviewStatus: "draft",
      createdBy: "localization-agent",
      modelVersion: "gpt-5.5",
    }),
    id: "agent-run-localization",
    name: "Localization Agent",
    goal: "Prepare Sorani, Turkish, Urdu, Indonesian, Malay, French, and German UI strings.",
    status: "running",
    sources: [canonicalSources[2]],
    lastEvent: "RTL QA queued for Sorani and Urdu.",
  },
  {
    ...traceRecord("agent-run-safety", {
      confidence: 0.97,
      reviewStatus: "blocked",
      createdBy: "scholar-review-agent",
      modelVersion: "gpt-5.5",
    }),
    id: "agent-run-safety",
    name: "Scholar Review Agent",
    goal: "Block unsourced fatwa-like answer and request approved source.",
    status: "blocked",
    sources: [],
    lastEvent: "Policy stopped answer: no approved source references.",
  },
];

export const benchmarkMetrics: BenchmarkMetricType[] = [
  { label: "Live alignment latency", value: "428ms", target: "<600ms", status: "passing" },
  { label: "Teacher agreement", value: "91%", target: ">90%", status: "passing" },
  { label: "Tajweed F1", value: "0.82", target: "0.88", status: "watch" },
  { label: "False-positive rate", value: "6.4%", target: "<5%", status: "watch" },
  { label: "Unsourced answers", value: "0", target: "0", status: "passing" },
];
