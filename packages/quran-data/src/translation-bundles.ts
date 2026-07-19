/**
 * Immutable provenance records for shipped licensed translation assets.
 *
 * The original `ckb-burhan-muhammad/manifest.json` was produced during a
 * partial import and is retained untouched as historical source material. This
 * v2 record is the authoritative, content-addressed correction for the exact
 * asset the application currently loads. A changed file changes the aggregate
 * hash and fails the integrity test; a refreshed import must use a new version.
 */
export interface TranslationBundleProvenance {
  bundleVersion: string;
  assetSlug: string;
  supersedes: string;
  source: string;
  publisher: string;
  language: string;
  fetchedAt: string;
  integrity: {
    fileCount: number;
    translatedAyahCount: number;
    missingAyahCount: number;
    contentSha256: string;
  };
}

export const CKB_BURHAN_MUHAMMAD_BUNDLE_V2: TranslationBundleProvenance = Object.freeze({
  bundleVersion: "2026-07-19-provenance-v2",
  assetSlug: "ckb-burhan-muhammad",
  supersedes: "manifest.json",
  source: "api.quran.com v4 translation 81",
  publisher: "QuranEnc.com",
  language: "ckb",
  fetchedAt: "2026-07-15",
  integrity: Object.freeze({
    fileCount: 39,
    translatedAyahCount: 856,
    missingAyahCount: 1,
    contentSha256: "sha256:837dbb9265585b2d9d3ad27afe62f1e5624da11c3b35720858eb7ff2aadb3765",
  }),
});
