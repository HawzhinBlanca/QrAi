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

// nginx-tls.conf serves the HTTPS deployment, so it must additionally pin HSTS and its TLS policy.
//
// The protocol line was already correct and NOTHING asserted it (P4.4 audit): the row names a "TLS
// policy gate" and `ssl_protocols TLSv1.2 TLSv1.3;` sat in the config with no check, so adding
// TLSv1.0 back would have been invisible to every gate.
const TLS_ONLY = [
  ["add_header Strict-Transport-Security", "Strict-Transport-Security (HSTS)"],
  ["ssl_protocols TLSv1.2 TLSv1.3;", "ssl_protocols pinned to TLS 1.2/1.3"],
];

// The other direction, and the one that actually matters.
//
// `missingFrom` can only notice something REMOVED. A weak protocol is ADDED, and a config keeping
// `ssl_protocols TLSv1.2 TLSv1.3;` while enabling TLSv1.0 in another server block would satisfy
// every requirement above. Downgrade is the attack; presence-checking cannot see it.
const FORBIDDEN = [
  [/TLSv1\.0/, "TLSv1.0 (deprecated by RFC 8996)"],
  [/TLSv1\.1/, "TLSv1.1 (deprecated by RFC 8996)"],
  [/SSLv[23]/, "SSLv2/SSLv3"],
  [/ssl_protocols[^;]*\bTLSv1\b(?!\.)/, "bare TLSv1"],
];

/** Labels of forbidden patterns PRESENT in `text`. Pure, like `missingFrom`, for the same reason. */
export function forbiddenIn(text, patterns = FORBIDDEN) {
  return patterns.filter(([re]) => re.test(text)).map(([, label]) => label);
}

/** Return the labels of requirements NOT satisfied by `text`. Pure, so it is unit-testable. */
export function missingFrom(text, requirements) {
  return requirements.filter(([needle]) => !text.includes(needle)).map(([, label]) => label);
}

function checkFile(relPath, requirements) {
  const abs = path.join(ROOT, relPath);
  const text = readFileSync(abs, "utf8");
  return { relPath, missing: missingFrom(text, requirements), forbidden: forbiddenIn(text) };
}

if (process.argv.includes("--self-test")) {
  // Prove the checker actually fails when a header is absent (guards the guard).
  const good = 'add_header X-Frame-Options "DENY" always;';
  const bad = "add_header Something-Else always;";
  const r1 = missingFrom(good, [['add_header X-Frame-Options "DENY" always;', "xfo"]]);
  const r2 = missingFrom(bad, [['add_header X-Frame-Options "DENY" always;', "xfo"]]);
  // And the downgrade direction, which presence-checking cannot express.
  const r3 = forbiddenIn("ssl_protocols TLSv1.2 TLSv1.3;");
  const r4 = forbiddenIn("ssl_protocols TLSv1 TLSv1.1 TLSv1.2;");
  if (r1.length !== 0 || r2.length !== 1 || r3.length !== 0 || r4.length === 0) {
    console.error("self-test FAILED", { r1, r2, r3, r4 });
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
for (const { relPath, missing, forbidden } of results) {
  if (forbidden.length) {
    failed = true;
    console.error(`✗ ${relPath} enables protocols that must not be served:`);
    for (const f of forbidden) console.error(`    - ${f}`);
  }
  if (missing.length) {
    failed = true;
    console.error(`✗ ${relPath} is missing required security headers:`);
    for (const m of missing) console.error(`    - ${m}`);
  } else if (!forbidden.length) {
    console.log(`✓ ${relPath} — all required security headers present`);
  }
}

if (failed) {
  console.error("Security-header policy check FAILED (see ADR-0010).");
  process.exit(1);
}
console.log("Security-header policy check passed.");
