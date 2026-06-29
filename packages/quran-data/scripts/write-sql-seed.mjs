import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFatihahImportBundle, toCanonicalSqlSeed } from "../src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const target = resolve(root, "infra/sql/0002_seed_fatihah.sql");
const sql = [
  "-- Generated from packages/quran-data. Do not edit Arabic text by hand.",
  "-- Regenerate with: pnpm --filter @quran-ai/quran-data seed:sql",
  toCanonicalSqlSeed(buildFatihahImportBundle("tanzil")),
  "",
].join("\n");

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, sql);
console.log(`wrote ${target}`);
