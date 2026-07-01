import { describe, expect, it } from "vitest";

import type { SurahInfo } from "./api";
import {
  DEFAULT_SURAH,
  MAX_PRACTICE_AYAHS,
  globalAyahOffset,
  practiceRange,
  progressKey,
  surahLabel,
} from "./surah";

describe("practiceRange", () => {
  it("keeps short surahs whole and caps long ones", () => {
    expect(practiceRange({ ayahCount: 7 })).toEqual({ ayahStart: 1, ayahEnd: 7 }); // Al-Faatiha unchanged
    expect(practiceRange({ ayahCount: 286 })).toEqual({ ayahStart: 1, ayahEnd: MAX_PRACTICE_AYAHS }); // Al-Baqara capped
    expect(practiceRange({ ayahCount: 3 })).toEqual({ ayahStart: 1, ayahEnd: 3 }); // Al-Kawthar
  });

  it("guards against a zero/invalid ayah count", () => {
    expect(practiceRange({ ayahCount: 0 })).toEqual({ ayahStart: 1, ayahEnd: 1 });
    expect(practiceRange({ ayahCount: Number.NaN })).toEqual({ ayahStart: 1, ayahEnd: 1 });
  });
});

describe("globalAyahOffset", () => {
  const list: SurahInfo[] = [
    { surahNumber: 1, ayahCount: 7, name: "Al-Faatiha" },
    { surahNumber: 2, ayahCount: 286, name: "Al-Baqara" },
    { surahNumber: 3, ayahCount: 200, name: "Aal-i-Imraan" },
  ];

  it("matches the standard 6236-ayah numbering the audio CDN uses", () => {
    expect(globalAyahOffset(list, 1)).toBe(0); // 1:1 -> global 1
    expect(globalAyahOffset(list, 2)).toBe(7); // 2:1 -> global 8
    expect(globalAyahOffset(list, 3)).toBe(293); // 3:1 -> global 294
  });

  it("is 0 for surah 1 even with an empty list (pre-load fallback)", () => {
    expect(globalAyahOffset([], 1)).toBe(0);
  });
});

describe("progressKey", () => {
  it("encodes surah number and ayah range so each passage tracks its own mastery", () => {
    expect(progressKey(1, { ayahStart: 1, ayahEnd: 7 })).toBe("1:1-7");
    expect(progressKey(114, { ayahStart: 1, ayahEnd: 6 })).toBe("114:1-6");
  });
});

describe("surahLabel / DEFAULT_SURAH", () => {
  it("labels a surah and the default matches the API's surah-1 record", () => {
    expect(surahLabel(DEFAULT_SURAH)).toBe("Surah Al-Faatiha");
    expect(DEFAULT_SURAH.surahNumber).toBe(1);
    expect(DEFAULT_SURAH.ayahCount).toBe(7);
  });
});
