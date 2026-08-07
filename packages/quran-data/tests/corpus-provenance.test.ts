import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_SOURCE_MANIFESTS,
  buildFullQuranSurahBundle,
} from "../src/index";
import {
  FULL_QURAN_CONTENT_SHA256,
  FULL_QURAN_EDITION,
  FULL_QURAN_PROVENANCE_V2,
  FULL_QURAN_IMPORT_VERSION,
  FULL_QURAN_MANIFEST,
  FULL_QURAN_SOURCE_ID,
  computeFullQuranContentHash,
  computeFullQuranIntegrityHashes,
  computeQuranIntegrityHashes,
  getSurah,
  listAllSurahs,
} from "../src/full-quran";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const provenancePath = resolve(testDir, "../src/data/full-quran/provenance-v1.json");
const provenanceV2Path = resolve(testDir, "../src/data/full-quran/provenance-v2.json");
const hashScriptPath = resolve(testDir, "../scripts/quran-content-hash.mjs");
const seedGeneratorPath = resolve(testDir, "../scripts/write-full-quran-sql-seed.mjs");
const migrationManifestPath = resolve(testDir, "../../../infra/migrations/manifest.json");
const sourceIdMigrationPath = resolve(
  testDir,
  "../../../infra/migrations/0028_canonical_quran_source_id.sql",
);
interface ReviewedCorpusProvenance {
  schemaVersion: number;
  provenanceId: string;
  canonicalSourceId: string;
  directProvider: {
    name: string;
    apiDocumentationUrl: string;
    acquisitionEndpoint: string;
    verificationEndpoint: string;
  };
  edition: {
    identifier: string;
    language: string;
    englishName: string;
    format: string;
    type: string;
    scriptType: string;
  };
  importVersion: string;
  acquiredOn: string;
  reviewedOn: string;
  reviewArtifact: string;
  content: {
    serialization: string;
    sha256: string;
    surahCount: number;
    ayahCount: number;
    wordCount: number;
  };
  terms: {
    providerTermsUrl: string;
    providerTermsLastUpdated: string;
    checkedOn: string;
    requiredAttribution: string;
    preservationRequired: boolean;
  };
  upstreamAttribution: {
    status: string;
    namedProviderSources: string[];
    decision: string;
    conditionalTanzilLicenseUrl: string;
  };
  migration: {
    previousIncorrectSourceId: string;
    canonicalSourceId: string;
    databaseMigrationId: string;
    arabicBytesChanged: boolean;
    reseedRequired: boolean;
  };
}


interface CorpusIntegrityManifestV2 {
  schemaVersion: number;
  provenanceId: string;
  supersedes: {
    provenanceId: string;
    file: string;
    sha256: string;
  };
  canonicalSourceId: string;
  edition: {
    identifier: string;
    scriptType: string;
  };
  importVersion: string;
  integrity: {
    algorithm: string;
    encoding: string;
    lengthPrefix: string;
    recordFraming: string;
    recordOrder: string;
    domains: {
      ayahs: string;
      wordTokens: string;
    };
    ayahs: {
      fields: string[];
      count: number;
      sha256: string;
    };
    wordTokens: {
      fields: string[];
      count: number;
      sha256: string;
    };
    tokenization: {
      reconstruction: string;
      exceptions: Array<{ ref: string; preservedPrefix: string }>;
    };
  };
  seed: {
    generator: string;
    integrityPreflightRequired: boolean;
  };
}

function loadProvenance(): ReviewedCorpusProvenance | undefined {
  if (!existsSync(provenancePath)) return undefined;
  return JSON.parse(readFileSync(provenancePath, "utf8")) as ReviewedCorpusProvenance;
}


function loadIntegrityManifestV2(): CorpusIntegrityManifestV2 | undefined {
  if (!existsSync(provenanceV2Path)) return undefined;
  return JSON.parse(readFileSync(provenanceV2Path, "utf8")) as CorpusIntegrityManifestV2;
}

describe("reviewed canonical corpus provenance", () => {
  it("pins the direct provider, edition, terms, reviewed ambiguity, and shipped content hash", () => {
    const provenance = loadProvenance();

    expect(provenance, "missing reviewed provenance-v1.json").toBeDefined();
    if (!provenance) return;

    expect(provenance).toMatchObject({
      schemaVersion: 1,
      provenanceId: "full-quran-2026-06-26-provenance-v1",
      canonicalSourceId: "alquran-cloud",
      directProvider: {
        name: "Al Quran Cloud",
        apiDocumentationUrl: "https://alquran.cloud/api",
        acquisitionEndpoint: FULL_QURAN_MANIFEST.apiUrl,
        verificationEndpoint: "https://api.alquran.cloud/v1/quran/quran-uthmani",
      },
      edition: {
        identifier: FULL_QURAN_EDITION,
        language: "ar",
        englishName: "Uthmani",
        format: "text",
        type: "quran",
        scriptType: "uthmani",
      },
      importVersion: FULL_QURAN_IMPORT_VERSION,
      acquiredOn: "2026-06-26",
      reviewedOn: "2026-08-06",
      reviewArtifact:
        "specs/lean-flutter-node-consolidation/evidence/W1.1-corpus-provenance-review.md",
      content: {
        serialization: "surah:ayah:text\\n",
        sha256: FULL_QURAN_CONTENT_SHA256,
        surahCount: 114,
        ayahCount: 6236,
        wordCount: FULL_QURAN_MANIFEST.totalWords,
      },
      terms: {
        providerTermsUrl: "https://alquran.cloud/terms-and-conditions",
        providerTermsLastUpdated: "2026-06-14",
        checkedOn: "2026-08-06",
        preservationRequired: true,
      },
      upstreamAttribution: {
        status: "provider-does-not-map-edition-to-exact-upstream",
        conditionalTanzilLicenseUrl: "https://tanzil.net/docs/Text_License",
      },
      migration: {
        previousIncorrectSourceId: "tanzil",
        canonicalSourceId: "alquran-cloud",
        databaseMigrationId: "0028",
        arabicBytesChanged: false,
        reseedRequired: true,
      },
    });
    expect(provenance.terms.requiredAttribution).toContain("Al Quran Cloud");
    expect(provenance.upstreamAttribution.namedProviderSources).toEqual(
      expect.arrayContaining(["GlobalQuran.com", "Tanzil.net", "Quran Academy"]),
    );
    expect(provenance.upstreamAttribution.decision).toContain("Do not label");
    expect(FULL_QURAN_MANIFEST.source).toBe("alquran.cloud");
    expect(FULL_QURAN_MANIFEST.edition).toBe(FULL_QURAN_EDITION);
    expect(computeFullQuranContentHash()).toBe(provenance.content.sha256);
  });

  it("registers the direct acquisition provider and makes the production seed use it", () => {
    const source = CANONICAL_SOURCE_MANIFESTS.find(
      (candidate) => candidate.id === FULL_QURAN_SOURCE_ID,
    );
    const seedGenerator = readFileSync(seedGeneratorPath, "utf8");

    expect(source).toEqual({
      id: "alquran-cloud",
      title: "Al Quran Cloud Uthmani Quran Text",
      url: "https://alquran.cloud/api",
      edition: "quran-uthmani",
      scriptType: "uthmani",
      importVersion: FULL_QURAN_IMPORT_VERSION,
    });
    expect(seedGenerator).toContain("FULL_QURAN_SOURCE_ID");
    const preflightIndex = seedGenerator.indexOf("validateFullQuranIntegrity");
    const firstSqlWriteIndex = seedGenerator.indexOf("process.stdout.write");
    expect(preflightIndex, "seed generator has no integrity preflight").toBeGreaterThan(-1);
    expect(firstSqlWriteIndex, "seed generator emits no SQL").toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(firstSqlWriteIndex);
    expect(seedGenerator).not.toContain('buildFullQuranSurahBundle(surah, "tanzil"');
  });

  it("ships the source-id database change as a checksum-pinned additive migration", () => {
    expect(existsSync(sourceIdMigrationPath), "missing additive source-id migration").toBe(true);
    if (!existsSync(sourceIdMigrationPath)) return;

    const sql = readFileSync(sourceIdMigrationPath, "utf8");
    const migrationManifest = JSON.parse(readFileSync(migrationManifestPath, "utf8")) as {
      migrations: Array<{ id: string; filename: string; sha256: string }>;
    };
    const manifestEntry = migrationManifest.migrations.find(({ id }) => id === "0028");
    const checksum = createHash("sha256").update(sql).digest("hex");

    expect(manifestEntry).toEqual({
      id: "0028",
      filename: "0028_canonical_quran_source_id.sql",
      sha256: checksum,
    });
    expect(sql).toContain("drop constraint canonical_ayahs_source_id_check");
    expect(sql).toContain(
      "source_id in ('alquran-cloud', 'quran-foundation', 'tanzil')",
    );
  });

  it("changes source-bound metadata and checksums without changing any Arabic text bytes", () => {
    let ayahCount = 0;
    let wordCount = 0;

    for (const entry of listAllSurahs()) {
      const surah = getSurah(entry.surahNumber);
      const previous = buildFullQuranSurahBundle(surah, "tanzil", FULL_QURAN_IMPORT_VERSION);
      const corrected = buildFullQuranSurahBundle(
        surah,
        FULL_QURAN_SOURCE_ID,
        FULL_QURAN_IMPORT_VERSION,
      );

      expect(corrected.ayahs.map(({ text }) => text)).toEqual(
        previous.ayahs.map(({ text }) => text),
      );
      expect(corrected.words.map(({ text }) => text)).toEqual(
        previous.words.map(({ text }) => text),
      );
      expect(corrected.ayahs[0]?.sourceChecksum).not.toBe(previous.ayahs[0]?.sourceChecksum);
      expect(corrected.words[0]?.sourceChecksum).not.toBe(previous.words[0]?.sourceChecksum);
      ayahCount += corrected.ayahs.length;
      wordCount += corrected.words.length;
    }

    expect(ayahCount).toBe(FULL_QURAN_MANIFEST.totalAyahs);
    expect(wordCount).toBe(FULL_QURAN_MANIFEST.totalWords);
  });


  it("pins immutable length-delimited ayah and word-token hashes in provenance v2", () => {
    const provenance = loadIntegrityManifestV2();

    expect(provenance, "missing reviewed provenance-v2.json").toBeDefined();
    if (!provenance) return;

    expect(provenance).toMatchObject({
      schemaVersion: 2,
      provenanceId: "full-quran-2026-06-26-provenance-v2",
      supersedes: {
        provenanceId: "full-quran-2026-06-26-provenance-v1",
        file: "provenance-v1.json",
        sha256: "66bac75ce095970d7d40f21f9d3ffa24884d8153068808b3b0e412fc14c7449c",
      },
      canonicalSourceId: FULL_QURAN_SOURCE_ID,
      edition: {
        identifier: FULL_QURAN_EDITION,
        scriptType: "uthmani",
      },
      importVersion: FULL_QURAN_IMPORT_VERSION,
      integrity: {
        algorithm: "sha256",
        encoding: "utf8",
        lengthPrefix: "uint64be",
        recordFraming: "length-prefixed-record-of-length-prefixed-fields",
        recordOrder: "surah-ascending,ayah-ascending,word-index-ascending",
        domains: {
          ayahs: "qrai.full-quran.ayahs.v1",
          wordTokens: "qrai.full-quran.word-tokens.v1",
        },
        ayahs: {
          fields: ["surahNumber", "ayahNumber", "text"],
          count: 6236,
          sha256: "be19912bd87d3a8ad941ab458e5c4e167e49b3749fab704526a2f1430f532fbb",
        },
        wordTokens: {
          fields: ["surahNumber", "ayahNumber", "wordIndex", "text"],
          count: 82456,
          sha256: "580276af15ecb4756b8a02afb922e33867f06faf77482ac6c5b393fc729e23a4",
        },
        tokenization: {
          reconstruction: "join tokens with one U+0020 in stored order",
          exceptions: [{ ref: "1:1", preservedPrefix: "U+FEFF" }],
        },
      },
      seed: {
        generator: "packages/quran-data/scripts/write-full-quran-sql-seed.mjs",
        integrityPreflightRequired: true,
      },
    });

    const provenanceV1Sha256 = createHash("sha256")
      .update(readFileSync(provenancePath))
      .digest("hex");
    expect(provenance.supersedes.sha256).toBe(provenanceV1Sha256);
    expect(FULL_QURAN_PROVENANCE_V2).toEqual(provenance);

    const hashes = computeFullQuranIntegrityHashes();
    expect(hashes).toEqual({
      ayahCount: 6236,
      wordTokenCount: 82456,
      ayahSha256: provenance.integrity.ayahs.sha256,
      wordTokenSha256: provenance.integrity.wordTokens.sha256,
    });
  });

  it("length-delimited hashing detects same-count token drift without changing the ayah hash", () => {
    const source = listAllSurahs().map(({ surahNumber }) => getSurah(surahNumber));
    const changed = structuredClone(source);
    changed[0].ayahs[0].words[0] = `${changed[0].ayahs[0].words[0]}x`;

    const originalHashes = computeQuranIntegrityHashes(source);
    const changedHashes = computeQuranIntegrityHashes(changed);

    expect(changedHashes.ayahCount).toBe(originalHashes.ayahCount);
    expect(changedHashes.wordTokenCount).toBe(originalHashes.wordTokenCount);
    expect(changedHashes.ayahSha256).toBe(originalHashes.ayahSha256);
    expect(changedHashes.wordTokenSha256).not.toBe(originalHashes.wordTokenSha256);
  });

  it("declares the only exact token reconstruction exception without trimming bytes", () => {
    let exact = 0;
    const exceptions: string[] = [];

    for (const { surahNumber } of listAllSurahs()) {
      for (const ayah of getSurah(surahNumber).ayahs) {
        const reconstructed = ayah.words.join(" ");
        if (reconstructed === ayah.text) {
          exact += 1;
        } else {
          exceptions.push(`${ayah.surahNumber}:${ayah.ayahNumber}`);
          expect(ayah.text).toBe(`\uFEFF${reconstructed}`);
        }
      }
    }

    expect(exact).toBe(6235);
    expect(exceptions).toEqual(["1:1"]);
  });

  it("the independent hash regenerator agrees with both v2 manifest hashes", () => {
    const provenance = loadIntegrityManifestV2();
    expect(provenance, "missing reviewed provenance-v2.json").toBeDefined();
    if (!provenance) return;

    const output = execFileSync(process.execPath, [hashScriptPath], { encoding: "utf8" });
    expect(output).toContain(`FULL_QURAN_AYAH_SHA256 = "${provenance.integrity.ayahs.sha256}"`);
    expect(output).toContain(
      `FULL_QURAN_WORD_TOKEN_SHA256 = "${provenance.integrity.wordTokens.sha256}"`,
    );
  });
});
