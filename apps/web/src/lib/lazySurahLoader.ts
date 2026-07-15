// Shared lazy-per-surah loader for bundler-globbed JSON (word timings, translations, …). Pass the
// result of an `import.meta.glob(...)` (the literal glob must stay at the call site so Vite can code-
// split it); this builds the surah→loader map and a cached async getter once, instead of every
// consumer re-writing it.

export function lazySurahLoader<T>(
  modules: Record<string, () => Promise<{ default: T }>>,
): (surahNumber: number) => Promise<T | null> {
  const loaderBySurah = new Map<number, () => Promise<{ default: T }>>();
  for (const [path, loader] of Object.entries(modules)) {
    const m = path.match(/surah-(\d{3})\.json$/);
    if (m) loaderBySurah.set(Number(m[1]), loader);
  }
  const cache = new Map<number, T | null>();

  return async function load(surahNumber: number): Promise<T | null> {
    if (cache.has(surahNumber)) return cache.get(surahNumber) ?? null;
    const loader = loaderBySurah.get(surahNumber);
    if (!loader) {
      cache.set(surahNumber, null);
      return null;
    }
    const mod = await loader();
    cache.set(surahNumber, mod.default);
    return mod.default;
  };
}
