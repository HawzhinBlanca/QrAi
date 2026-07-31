/**
 * K4 — the reviewer's tool.
 * specs/kurdish-i18n/plan.md
 *
 *   node scripts/i18n-review.mjs                 show the next unreviewed draft
 *   node scripts/i18n-review.mjs --list          every pending draft, one line each
 *   node scripts/i18n-review.mjs --promote <key> approve ONE string into the shipped locale
 *   node scripts/i18n-review.mjs --status        coverage, honestly counted
 *
 * Promotion is one key at a time ON PURPOSE. There is no --promote-all, because the failure this
 * whole mechanism exists to prevent is a reviewer approving 267 fluent-sounding strings in one
 * keystroke. Rejecting a draft is the expected outcome for many of them.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const EN = "apps/web/src/locales/en.json";
const DRAFTS = "specs/kurdish-i18n/drafts/ckb.draft.json";
const LOCALE = "apps/web/src/locales/ckb.json";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const drafts = read(DRAFTS);
const locale = existsSync(LOCALE) ? read(LOCALE) : {};
const en = read(EN);

const leaves = (o, p = "") =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? leaves(v, `${p}${k}.`) : [`${p}${k}`]));
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => {
  const parts = p.split(".");
  const last = parts.pop();
  let node = o;
  for (const part of parts) node = node[part] ??= {};
  node[last] = v;
};

const reviewed = new Set(leaves(locale));
const pending = Object.entries(drafts.entries).filter(([k]) => !reviewed.has(k));

const [flag, arg] = process.argv.slice(2);

if (flag === "--status") {
  const total = leaves(en).length;
  console.log(`reviewed ${reviewed.size} of ${total} strings (${((reviewed.size / total) * 100).toFixed(1)}%)`);
  console.log(`drafts pending review: ${pending.length}`);
  console.log(`undrafted (religious/brand + not yet drafted): ${total - reviewed.size - pending.length}`);
  console.log("\nEverything not reviewed renders ENGLISH via fallbackLng — the app is never broken,");
  console.log("only partly translated.");
} else if (flag === "--list") {
  for (const [key, e] of pending) console.log(`${key}\n   en: ${e.english}\n   ku: ${e.value}${e.note ? `\n   ! ${e.note}` : ""}`);
} else if (flag === "--promote") {
  const entry = drafts.entries[arg];
  if (!entry) {
    console.error(`no draft for "${arg}". Run --list to see pending keys.`);
    process.exit(2);
  }
  // Refuse a stale draft rather than promote a translation of a sentence that has since changed.
  if (entry.english !== getPath(en, arg)) {
    console.error(`REFUSED: the English for "${arg}" changed since it was drafted.\n  drafted from: ${entry.english}\n  now:          ${getPath(en, arg)}`);
    process.exit(1);
  }
  setPath(locale, arg, entry.value);
  writeFileSync(LOCALE, `${JSON.stringify(locale, null, 2)}\n`);
  console.log(`promoted ${arg} -> ${LOCALE}`);
  console.log(`  ${entry.value}`);
  console.log("\nRun `bash scripts/verify.sh` — the parity gate checks it before it can ship.");
} else {
  const [key, e] = pending[0] ?? [];
  if (!key) {
    console.log("no drafts pending review.");
  } else {
    console.log(`key:      ${key}`);
    console.log(`english:  ${e.english}`);
    console.log(`draft:    ${e.value}`);
    if (e.note) console.log(`NOTE:     ${e.note}`);
    console.log(`\n${pending.length} pending. This draft was written by a model that cannot verify its`);
    console.log("Sorani is idiomatic for Erbil. Correcting or rejecting it is the expected outcome.");
    console.log(`\n  approve as-is:  node scripts/i18n-review.mjs --promote ${key}`);
    console.log(`  correct it:     edit ${DRAFTS}, then promote`);
  }
}
