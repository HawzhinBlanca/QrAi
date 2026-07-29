import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CKB_BURHAN_MUHAMMAD_BUNDLE_V2 } from "../src/translation-bundles";

const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "data",
  "translations",
  "ckb-burhan-muhammad",
);
const FETCH_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fetch-translations.mjs");

function observedBundle() {
  const files = readdirSync(DIR)
    .filter((name) => /^surah-\d{3}\.json$/.test(name))
    .sort();
  let translatedAyahCount = 0;
  let missingAyahCount = 0;
  const contentHash = createHash("sha256");

  for (const file of files) {
    const bytes = readFileSync(join(DIR, file));
    const surah = JSON.parse(bytes.toString()) as { ayahs: unknown[]; missingAyahs: unknown[] };
    translatedAyahCount += surah.ayahs.length;
    missingAyahCount += surah.missingAyahs.length;
    contentHash.update(file).update("\0").update(createHash("sha256").update(bytes).digest("hex")).update("\n");
  }

  return {
    fileCount: files.length,
    translatedAyahCount,
    missingAyahCount,
    contentSha256: `sha256:${contentHash.digest("hex")}`,
  };
}

describe("versioned Sorani translation provenance", () => {
  it("pins the exact shipped asset and does not rely on its stale legacy manifest", () => {
    expect(CKB_BURHAN_MUHAMMAD_BUNDLE_V2.assetSlug).toBe("ckb-burhan-muhammad");
    expect(CKB_BURHAN_MUHAMMAD_BUNDLE_V2.supersedes).toBe("manifest.json");
    expect(observedBundle()).toEqual(CKB_BURHAN_MUHAMMAD_BUNDLE_V2.integrity);
  });

  it("refuses an unversioned import before it can modify a licensed source asset", () => {
    const result = spawnSync(process.execPath, [FETCH_SCRIPT, "--surahs", "1"], {
      cwd: join(DIR, "..", "..", "..", "..", ".."),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--version is required; translation imports are append-only");
  });
});
