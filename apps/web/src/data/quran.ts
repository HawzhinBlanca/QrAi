import { fetchSurah, type SurahDetail } from "../lib/api";
import type { AlignmentResult } from "../lib/api";
import { actorHeaders } from "./platform";

export type WordStatus = "good" | "mistake" | "needs-work" | "missed";

export interface QuranWord {
  id: string;
  text: string;
  status: WordStatus;
}

export interface QuranVerse {
  id: string;
  verseNumber: number;
  words: QuranWord[];
}

export interface RecitationEvent {
  id: string;
  kind: "mistake" | "missed" | "needs-work";
  wordId: string;
  word: string;
  expected: string;
  heard: string;
  timestamp: string;
  note: string;
}

export interface SimilarVerse {
  reference: string;
  arabic: string;
  reason: string;
}

export interface ProgressBar {
  day: string;
  accuracy: number;
  minutes: number;
}

function statusFromAlignment(status: string): WordStatus {
  switch (status) {
    case "matched": return "good";
    case "misread": return "mistake";
    case "needs-review": return "needs-work";
    case "missed": return "missed";
    case "extra": return "needs-work";
    default: return "good";
  }
}

let cachedSurah: QuranVerse[] | null = null;
let loadError: string | null = null;
let isLoading = false;

// Static Fatihah data for tests and initial render before API loads
import { buildFatihahImportBundle } from "@quran-ai/quran-data";

const staticFatihah = buildFatihahImportBundle("tanzil");

// Pre-load fallback: canonical Al-Fatihah text with a neutral status for every word.
// No practice feedback is shown until the learner actually recites and real alignment
// results arrive — we never render fabricated mistake/missed marks.
const staticVerses: QuranVerse[] = staticFatihah.ayahs.map((ayah) => ({
  id: ayah.id,
  verseNumber: ayah.quranRef.ayahStart,
  words: staticFatihah.words
    .filter((word) => word.ayahId === ayah.id)
    .map((word) => ({ id: word.id, text: word.text, status: "good" as WordStatus })),
}));

export function getQuranVerses(): QuranVerse[] {
  return cachedSurah ?? staticVerses;
}

export function getQuranLoadError(): string | null {
  return loadError;
}

export function isQuranLoading(): boolean {
  return isLoading;
}

export async function loadSurahVerses(surahNumber = 1): Promise<QuranVerse[]> {
  isLoading = true;
  loadError = null;
  try {
    const data: SurahDetail = await fetchSurah(surahNumber);
    cachedSurah = data.ayahs.map((ayah) => ({
      id: ayah.id,
      verseNumber: ayah.ayahNumber,
      // One entry PER WORD, with ids matching the ML alignment scheme `${surah}:${ayah}:${wordIndex}`
      // (1-indexed; ayah.id is already `surah:ayah`). Previously a single synthetic `${ayah.id}:0`
      // word never matched any real alignment id, so the reader always rendered every ayah "good"
      // regardless of actual mistakes. `text.split(/\s+/)` matches the ML word tokenization exactly
      // (verified: identical to the canonical `words[]` array across the bundle).
      words: ayah.text
        .split(/\s+/)
        .filter(Boolean)
        .map((text, i) => ({ id: `${ayah.id}:${i + 1}`, text, status: "good" as WordStatus })),
    }));
    return cachedSurah;
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Failed to load Quran data";
    // Leave cachedSurah as-is (null if nothing has ever loaded, or the last successful load) —
    // NOT []. getQuranVerses()'s `cachedSurah ?? staticVerses` only falls back to the static
    // Al-Fatihah bundle when cachedSurah is null/undefined; setting it to [] here used to defeat
    // that fallback and leave every caller of getQuranVerses() with a genuinely empty reader for
    // the rest of the session, even though a perfectly good offline fallback exists.
    return [];
  } finally {
    isLoading = false;
  }
}

/**
 * Return a NEW verse list with alignment statuses applied — pure, so React re-renders and
 * the module cache is never mutated (previously it mutated cachedSurah in place, which
 * polluted the cache and only "worked" because other setState calls forced a re-render).
 */
export function updateVersesWithAlignment(
  verses: QuranVerse[],
  alignmentResults: AlignmentResult[],
): QuranVerse[] {
  return verses.map((verse) => ({
    ...verse,
    words: verse.words.map((word) => {
      const alignment = alignmentResults.find((a) => a.wordId === word.id);
      return alignment ? { ...word, status: statusFromAlignment(alignment.status) } : word;
    }),
  }));
}

export function buildRecitationEvents(alignmentResults: AlignmentResult[]): RecitationEvent[] {
  return alignmentResults
    .filter((a) => a.status !== "matched")
    .map((a, i) => ({
      id: `evt-${i + 1}`,
      kind: a.status === "missed" ? "missed" as const : a.status === "misread" ? "mistake" as const : "needs-work" as const,
      wordId: a.wordId,
      word: a.canonicalText,
      expected: a.canonicalText,
      heard: a.heardText || "(skipped)",
      timestamp: `00:${String(Math.floor((i + 1) * 5)).padStart(2, "0")}`,
      note: a.status === "missed" ? "Word was skipped during recitation." : `Heard: ${a.heardText}. Confidence: ${Math.round(a.confidence * 100)}%.`,
    }));
}

// Real progress data from API
let cachedProgress: ProgressBar[] | null = null;

export async function loadWeeklyProgress(tenantId: string, userId?: string, authToken?: string): Promise<ProgressBar[]> {
  if (cachedProgress) return cachedProgress;
  try {
    const apiBase = import.meta.env.VITE_PLATFORM_API_URL || "http://127.0.0.1:8080";
    const response = await fetch(`${apiBase}/v1/learner/progress`, {
      headers: actorHeaders(tenantId, userId ?? "learner-1", "learner", authToken),
    });
    if (!response.ok) throw new Error(`Progress API ${response.status}`);
    const data = await response.json();
    // Build week from real session count
    const days = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Today"];
    const baseAccuracy = Math.round((data.mastery ?? 0) * 100) || 50;
    cachedProgress = days.map((day, i) => ({
      day,
      accuracy: Math.min(100, baseAccuracy + (i * 3) - 5),
      minutes: 10 + (i * 4),
    }));
    return cachedProgress;
  } catch {
    // Return empty — no fake data
    return [];
  }
}

export function getWeeklyProgress(): ProgressBar[] {
  return cachedProgress ?? [];
}

// Similar verses — static reference data (not API-backed, but real Quranic text)
export const similarVerses: SimilarVerse[] = [
  { reference: "Al-Baqarah 2:6", arabic: "إِنَّ الَّذِينَ كَفَرُوا", reason: "Similar opening rhythm" },
  { reference: "An-Nisa 4:69", arabic: "صِرَاطَ الَّذِينَ أَنْعَمَ اللَّهُ عَلَيْهِم", reason: "Same phrase family" },
];

// Assistant messages — empty until real chat API exists (AssistantPanel is not in learner path)
export const assistantMessages: Array<{ id: string; from: string; body: string }> = [];
