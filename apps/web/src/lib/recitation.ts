import type { QuranVerse, QuranWord, RecitationEvent, WordStatus } from "../data/quran";

export function flattenWords(verses: QuranVerse[]): QuranWord[] {
  return verses.flatMap((verse) => verse.words);
}

export function getFlaggedWords(verses: QuranVerse[], status?: Exclude<WordStatus, "good">): QuranWord[] {
  const words = flattenWords(verses).filter((word) => word.status !== "good");
  return status ? words.filter((word) => word.status === status) : words;
}

export function summarizeSession(verses: QuranVerse[], events: RecitationEvent[]) {
  const words = flattenWords(verses);
  const flagged = getFlaggedWords(verses);
  const correctWords = words.length - flagged.length;
  const accuracy = Math.round((correctWords / words.length) * 100);

  return {
    totalWords: words.length,
    correctWords,
    accuracy,
    mistakes: events.filter((event) => event.kind === "mistake").length,
    needsWork: events.filter((event) => event.kind === "needs-work").length,
    missed: events.filter((event) => event.kind === "missed").length,
  };
}

export function createWaveform(seed = 29, bars = 96): number[] {
  let value = seed;
  return Array.from({ length: bars }, (_, index) => {
    value = (value * 48271) % 2147483647;
    const base = 18 + (value % 52);
    const phraseLift = index % 11 === 0 ? 26 : 0;
    return Math.min(92, base + phraseLift);
  });
}

export function nextActiveWordIndex(currentIndex: number, totalWords: number): number {
  if (totalWords <= 0) {
    return 0;
  }
  return (currentIndex + 1) % totalWords;
}
