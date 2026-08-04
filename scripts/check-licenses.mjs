#!/usr/bin/env node
// P4.4 gate: dependency LICENCES.
//
// The P4.4 row names "dependency/license/image/SBOM/provenance/config/TLS/CSP/CORS/security-header
// policy gates". Every one of those had a gate except this one. `pnpm audit` and `cargo audit` cover
// vulnerabilities; the SBOM records what is present; nothing anywhere said whether the project is
// ALLOWED to ship what it depends on.
//
// That is not a hypothetical: a transitive dependency arriving under AGPL-3.0 changes the obligations
// of the whole distribution, and it arrives the same silent way the undici and fast-uri advisories
// did — through someone else's lockfile bump.
//
// ── Allowlist, not denylist ─────────────────────────────────────────────────────────────────────
// A denylist fails OPEN on any licence nobody thought of, which for licensing is the wrong direction:
// the unknown case needs a human, not a default. Same reasoning as `clears_learner_gate`.
//
// ── Scope, stated honestly ──────────────────────────────────────────────────────────────────────
// JavaScript only. `pnpm licenses` cannot see the Rust tree, and `cargo-license` is not installed
// here or in CI. The Rust dependencies are therefore UNGATED for licensing; that is recorded in the
// P4.4 ledger note rather than left for someone to discover.
import { execFileSync } from "node:child_process";

/**
 * Licences this project may ship without asking anyone.
 *
 * Permissive, no copyleft obligation on the combined work. Each was present in the tree when this
 * gate was written; the point is that the FOURTEENTH one fails until a human looks at it.
 */
const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT AND ISC",
  "MIT-0",
  "OFL-1.1", // Fonts (Amiri, Inter). Reserved-name clause only; no source obligation.
  "Unlicense",
]);

/**
 * Present, permitted to stay, and NOT the same claim as "permissive".
 *
 * MPL-2.0 is file-level copyleft: modifying an MPL file creates an obligation to publish that file's
 * source. Merely depending on one does not. All three packages here are build/test tooling that this
 * project consumes unmodified, so the obligation is dormant — but it becomes live the moment someone
 * vendors and patches one, and that is exactly the kind of change that happens without anyone
 * re-reading a licence.
 *
 * Reported on every run rather than silently allowed, so it stays a decision somebody made instead of
 * a fact nobody noticed.
 */
const ACKNOWLEDGED = new Map([
  ["MPL-2.0", "file-level copyleft — dormant while these packages are consumed unmodified"],
]);

export function classify(licenseMap) {
  const unapproved = [];
  const acknowledged = [];
  for (const [license, packages] of Object.entries(licenseMap)) {
    const names = (packages ?? []).map((p) => p.name ?? String(p));
    if (ALLOWED.has(license)) continue;
    if (ACKNOWLEDGED.has(license)) acknowledged.push({ license, names, note: ACKNOWLEDGED.get(license) });
    else unapproved.push({ license, names });
  }
  return { unapproved, acknowledged };
}

if (process.argv.includes("--self-test")) {
  // Guard the guard: a permissive licence passes, an unknown one does NOT.
  const a = classify({ MIT: [{ name: "ok" }] });
  const b = classify({ "AGPL-3.0": [{ name: "viral" }] });
  const c = classify({ "MPL-2.0": [{ name: "axe-core" }] });
  if (a.unapproved.length !== 0 || b.unapproved.length !== 1 || c.unapproved.length !== 0 || c.acknowledged.length !== 1) {
    console.error("self-test FAILED", { a, b, c });
    process.exit(1);
  }
  console.log("check-licenses self-test OK");
  process.exit(0);
}

let raw;
try {
  raw = execFileSync("pnpm", ["licenses", "list", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  // Fail closed. A licence gate that passes because the tool did not run is not a gate.
  console.error(`✗ could not enumerate licences: ${error.message}`);
  process.exit(1);
}

const { unapproved, acknowledged } = classify(JSON.parse(raw));

for (const { license, names, note } of acknowledged) {
  console.log(`• ${license} — ${note}`);
  console.log(`    ${names.join(", ")}`);
}

if (unapproved.length) {
  console.error("✗ dependency licences that nobody has approved:");
  for (const { license, names } of unapproved) {
    console.error(`    ${license}: ${names.join(", ")}`);
  }
  console.error("  Add it to ALLOWED/ACKNOWLEDGED in scripts/check-licenses.mjs — with a reason —");
  console.error("  or remove the dependency. Do not widen the list without reading the licence.");
  process.exit(1);
}

console.log(`✓ dependency licences: ${ALLOWED.size} approved, ${acknowledged.length} acknowledged, 0 unapproved (JS tree)`);
