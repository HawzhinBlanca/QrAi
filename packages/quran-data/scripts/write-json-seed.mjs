import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFatihahImportBundle, validateCanonicalImportBundle } from "../src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const target = resolve(root, "infra/canonical/fatihah.json");
const bundle = buildFatihahImportBundle("tanzil");
const validation = validateCanonicalImportBundle(bundle);

if (!validation.isValid) {
  throw new Error(`Cannot write invalid canonical seed: ${validation.errors.join("; ")}`);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(
  target,
  `${JSON.stringify(
    {
      generatedBy: "@quran-ai/quran-data",
      validation,
      source: bundle.source,
      ayahs: bundle.ayahs,
      words: bundle.words,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${target}`);
