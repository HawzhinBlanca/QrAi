import { readFileSync } from "node:fs";
import { join } from "node:path";

const cache = new Map<string, unknown>();

/**
 * Load a per-surah JSON asset stored as `<baseDir>/<key>/surah-XXX.json`, or null if absent.
 * Cached by path. Shared by the word-timings and translation accessors (both follow this layout).
 */
export function loadSurahJson<T>(baseDir: string, key: string, surahNumber: number): T | null {
  if (surahNumber < 1 || surahNumber > 114) {
    throw new Error(`Invalid surah number: ${surahNumber}. Must be 1-114.`);
  }
  const file = join(baseDir, key, `surah-${String(surahNumber).padStart(3, "0")}.json`);
  if (cache.has(file)) return (cache.get(file) as T | null) ?? null;
  let data: T | null = null;
  try {
    data = JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    data = null; // not ingested yet — callers fall back gracefully
  }
  cache.set(file, data);
  return data;
}
