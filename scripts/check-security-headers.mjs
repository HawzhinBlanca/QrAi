#!/usr/bin/env node
// P4.4 gate: assert the web nginx configs still emit the security headers ADR-0010 committed to.
// Static check (CI serves no nginx), so it catches the real regression class: a header/CSP directive
// silently dropped from apps/web/nginx*.conf. Node builtins only; wired into scripts/verify.sh.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Requirement = a substring that must appear in the config. `always` on add_header ensures the
// header is emitted on error responses too, so we require the full `... always;` form.
const COMMON = [
  ['add_header X-Content-Type-Options "nosniff" always;', "X-Content-Type-Options: nosniff"],
  ['add_header X-Frame-Options "DENY" always;', "X-Frame-Options: DENY"],
  ["add_header Referrer-Policy", "Referrer-Policy"],
  ["add_header Permissions-Policy", "Permissions-Policy"],
  ["camera=()", "Permissions-Policy denies camera"],
  ["add_header Content-Security-Policy", "Content-Security-Policy present"],
  // Key CSP directives — the load-bearing ones for a no-inline-script SPA.
  ["default-src 'none'", "CSP default-src 'none'"],
  ["frame-ancestors 'none'", "CSP frame-ancestors 'none' (clickjacking)"],
  ["object-src 'none'", "CSP object-src 'none'"],
  ["base-uri 'self'", "CSP base-uri 'self'"],
  ["script-src 'self'", "CSP script-src 'self'"],
];

// nginx-tls.conf serves the HTTPS deployment, so it must additionally pin HSTS.
const TLS_ONLY = [["add_header Strict-Transport-Security", "Strict-Transport-Security (HSTS)"]];

/** Return the labels of requirements NOT satisfied by `text`. Pure, so it is unit-testable. */
export function missingFrom(text, requirements) {
  return requirements.filter(([needle]) => !text.includes(needle)).map(([, label]) => label);
}

function checkFile(relPath, requirements) {
  const abs = path.join(ROOT, relPath);
  const text = readFileSync(abs, "utf8");
  const missing = missingFrom(text, requirements);
  return { relPath, missing };
}

if (process.argv.includes("--self-test")) {
  // Prove the checker actually fails when a header is absent (guards the guard).
  const good = 'add_header X-Frame-Options "DENY" always;';
  const bad = "add_header Something-Else always;";
  const r1 = missingFrom(good, [['add_header X-Frame-Options "DENY" always;', "xfo"]]);
  const r2 = missingFrom(bad, [['add_header X-Frame-Options "DENY" always;', "xfo"]]);
  if (r1.length !== 0 || r2.length !== 1) {
    console.error("self-test FAILED", { r1, r2 });
    process.exit(1);
  }
  console.log("check-security-headers self-test OK");
  process.exit(0);
}

const results = [
  checkFile("apps/web/nginx.conf", COMMON),
  checkFile("apps/web/nginx-tls.conf", [...COMMON, ...TLS_ONLY]),
];

let failed = false;
for (const { relPath, missing } of results) {
  if (missing.length) {
    failed = true;
    console.error(`✗ ${relPath} is missing required security headers:`);
    for (const m of missing) console.error(`    - ${m}`);
  } else {
    console.log(`✓ ${relPath} — all required security headers present`);
  }
}

if (failed) {
  console.error("Security-header policy check FAILED (see ADR-0010).");
  process.exit(1);
}
console.log("Security-header policy check passed.");
