import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * If a service is told to trust forwarded headers, the proxy in front of it must overwrite them.
 *
 * `TRUST_PROXY_HEADERS=1` swaps tower_governor's key extractor from the raw TCP peer address to
 * `SmartIpKeyExtractor`. That is necessary behind a proxy — otherwise every request arrives from
 * nginx's address and the per-client rate limit collapses into one global bucket. It is also the
 * moment the rate-limit key stops being something the client cannot forge, and starts being a
 * header, and a header is only trustworthy if the proxy replaces it.
 *
 * ── What the library actually does ──────────────────────────────────────────────────────────────
 * `SmartIpKeyExtractor` (tower_governor 0.7, src/key_extractor.rs:105) reads:
 *
 *     maybe_x_forwarded_for(headers).or_else(|| maybe_x_real_ip(headers)).or_else(...)
 *
 * `x-forwarded-for` FIRST, and `maybe_x_forwarded_for` takes the LEFTMOST parseable entry
 * (`s.split(',').find_map(...)`). Both configs set `X-Real-IP` and neither used to set
 * `X-Forwarded-For` at all, so the header the extractor consults was the one nobody controlled but
 * the caller. The comment in nginx-tls.conf said the gateway "keys off X-Real-IP (set above)" —
 * a reasonable belief, and not what the library does.
 *
 * ── What was measured ───────────────────────────────────────────────────────────────────────────
 * One client, one process, rate limiting on, `TRUST_PROXY_HEADERS=1`, 400 requests each:
 *
 *     one client, no X-Forwarded-For             2xx=204  429=196
 *     one client, spoofed X-Forwarded-For        2xx=400  429=  0
 *     nginx X-Real-IP + client-spoofed XFF       2xx=400  429=  0
 *
 * The third line is the deployment: nginx sets `X-Real-IP` to the real peer, the client sends its
 * own `X-Forwarded-For`, and the client's value wins. The limiter works (line one) and is opted out
 * of by anyone who knows the header's name.
 *
 * ── Why `$remote_addr` and not `$proxy_add_x_forwarded_for` ─────────────────────────────────────
 * The idiomatic nginx line APPENDS the peer to whatever the client sent, preserving the client's
 * value at the LEFT — exactly the position `maybe_x_forwarded_for` reads. It would look like a fix
 * and change nothing. Overwriting with `$remote_addr` is the only form that works here.
 *
 * ── Scope, stated honestly ──────────────────────────────────────────────────────────────────────
 * The measurement above is of the service, and is exact. The claim that nginx forwards a client's
 * `X-Forwarded-For` to the upstream untouched is nginx's documented default (client headers pass
 * through unless a `proxy_set_header` overrides them) and is NOT reproduced here — this container
 * has no nginx binary and no docker daemon. The fix does not depend on it: `proxy_set_header
 * X-Forwarded-For $remote_addr` is what the code's own comment already required of any proxy in
 * front of it ("must only be enabled behind a proxy that OVERWRITES those headers",
 * services/platform-api/src/lib.rs), and it is correct whether or not the pass-through occurs.
 *
 * No database, no network: this reads the configs that ship.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every nginx `location` block that proxies to a service that keys rate limits off forwarded
 * headers. Both configs ship; `nginx.conf`'s `/ws/` block is dormant today and is listed anyway,
 * because a dormant block is one compose change away from being the live one.
 */
const CONFIGS = ["apps/web/nginx.conf", "apps/web/nginx-tls.conf"];

/** Split a config into `location <path> { ... }` blocks, so a directive in one cannot cover another. */
function locationBlocks(src) {
  const blocks = [];
  const re = /location\s+([^\s{]+)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    blocks.push({ path: m[1], body: src.slice(re.lastIndex, i - 1) });
  }
  return blocks;
}

/** A block that forwards to an upstream — the only kind where any of this matters. */
const isProxyBlock = (b) => /proxy_pass\s/.test(b.body);

function proxyBlocks() {
  const found = [];
  for (const rel of CONFIGS) {
    const src = readFileSync(join(root, rel), "utf8");
    for (const b of locationBlocks(src)) {
      if (isProxyBlock(b)) found.push({ ...b, file: rel });
    }
  }
  return found;
}

test("the parser finds the proxy blocks at all", () => {
  // Without this, a regex that stopped matching would yield zero blocks, every assertion below
  // would hold vacuously, and the guard would report that every proxy overwrites its headers.
  const blocks = proxyBlocks();
  assert.ok(
    blocks.length >= 4,
    `parsed only ${blocks.length} proxying location blocks across ${CONFIGS.join(", ")} — fix this ` +
      `parser, do not delete the check. Found: ${blocks.map((b) => `${b.file}${b.path}`).join(", ")}`,
  );
});

test("every proxying block overwrites X-Forwarded-For", () => {
  // The header SmartIpKeyExtractor reads first. Left unset, the rate-limit key is whatever the
  // client says it is.
  const missing = [];
  for (const b of proxyBlocks()) {
    if (!/proxy_set_header\s+X-Forwarded-For\s/i.test(b.body)) {
      missing.push(
        `${b.file} location ${b.path} — proxies upstream and never sets X-Forwarded-For. Any ` +
          `client can then choose its own rate-limit bucket, because SmartIpKeyExtractor reads ` +
          `that header before X-Real-IP.`,
      );
    }
  }
  assert.deepEqual(missing, [], `proxy blocks leaving X-Forwarded-For to the caller:\n  ${missing.join("\n  ")}`);
});

test("no block APPENDS the caller's X-Forwarded-For", () => {
  // `$proxy_add_x_forwarded_for` is the line most nginx configs use and it is wrong here: it keeps
  // the client's value leftmost, which is the entry the extractor takes. This is the failure mode
  // that would otherwise pass the test above while changing nothing.
  const appending = [];
  for (const b of proxyBlocks()) {
    const line = b.body.match(/proxy_set_header\s+X-Forwarded-For\s+([^;]+);/i);
    if (!line) continue;
    const value = line[1].trim();
    if (value !== "$remote_addr") {
      appending.push(
        `${b.file} location ${b.path} — X-Forwarded-For is set to \`${value}\`, not $remote_addr. ` +
          `$proxy_add_x_forwarded_for appends, leaving the client's value in the leftmost position ` +
          `that maybe_x_forwarded_for() reads, so the bypass survives the fix.`,
      );
    }
  }
  assert.deepEqual(appending, [], `X-Forwarded-For values that do not replace the caller's:\n  ${appending.join("\n  ")}`);
});

test("X-Real-IP is still set, so the fallback is a real address too", () => {
  // Belt and braces: if a future version of the extractor stops preferring x-forwarded-for, the
  // next header it reads must not be missing.
  const missing = [];
  for (const b of proxyBlocks()) {
    if (!/proxy_set_header\s+X-Real-IP\s+\$remote_addr\s*;/i.test(b.body)) {
      missing.push(`${b.file} location ${b.path} — X-Real-IP is not set from $remote_addr`);
    }
  }
  assert.deepEqual(missing, [], `proxy blocks without a trustworthy X-Real-IP:\n  ${missing.join("\n  ")}`);
});

test("the services still read these headers the way this guard assumes", () => {
  // The guard's whole premise is that TRUST_PROXY_HEADERS switches on SmartIpKeyExtractor. If a
  // service swaps to a custom extractor or drops the flag, these config lines may no longer be the
  // thing that matters, and the reasoning above needs re-reading rather than silent inheritance.
  for (const rel of ["services/platform-api/src/lib.rs", "services/realtime-gateway/src/lib.rs"]) {
    const src = readFileSync(join(root, rel), "utf8");
    assert.match(
      src,
      /TRUST_PROXY_HEADERS/,
      `${rel} no longer reads TRUST_PROXY_HEADERS — re-check what keys its rate limiter`,
    );
    assert.match(
      src,
      /SmartIpKeyExtractor/,
      `${rel} no longer uses SmartIpKeyExtractor — the header PRECEDENCE this guard is built on ` +
        `(x-forwarded-for before x-real-ip) may not apply to whatever replaced it`,
    );
  }
});
