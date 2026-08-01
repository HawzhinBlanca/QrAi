/**
 * The A/B differ: same request to the Node shell and to Rust, compared.
 * specs/migration-completion/plan.md §2
 *
 * ── Why this exists as a helper and not as 36 test files ────────────────────────────────────────
 * Every wave of the port needs the identical comparison, and the comparison is the part that is easy
 * to get subtly wrong — forgetting to compare a header, or comparing a parsed body when the bytes
 * are what the client sees. One implementation, one place to fix, and a per-route CASE TABLE.
 *
 * ── The property that makes this a real oracle ──────────────────────────────────────────────────
 * It is run BOTH ways: with the route proxied (shell forwards to Rust — must be identical, trivially)
 * and with the route ported (shell answers itself — must STILL be identical). Only the second run
 * proves anything about the port, and the first proves the harness itself is sound. A differ that
 * has only ever been run against a proxy has never been shown to detect a difference at all.
 */
import assert from "node:assert/strict";

import { request } from "./harness.mjs";

/**
 * Headers a proxy legitimately changes, and comparing them would produce noise rather than findings.
 * `date` differs by a second, `content-length` follows the body (already compared), `connection` and
 * `keep-alive` are hop-by-hop by definition.
 */
const VOLATILE_HEADERS = new Set([
  "date",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

function comparableHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) {
    if (!VOLATILE_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Run one probe against both implementations and assert they agree.
 *
 * `probe` is `{ name, path, ...requestOptions }` plus optional overrides:
 *   - `compareBody(shellText, apiText)` — for responses whose bytes legitimately differ (see the
 *     /metrics case in infra-parity: Rust renders from a HashMap, whose iteration order is not
 *     stable even between two runs of Rust itself).
 *   - `skipHeaders: [...]` — additional headers to ignore for this probe only.
 */
export async function assertAB(shellUrl, apiUrl, probe) {
  const { name, path, compareBody, skipHeaders = [], ...options } = probe;
  const label = name ?? `${options.method ?? "GET"} ${path}`;

  const [shell, api] = await Promise.all([
    request(shellUrl, path, options),
    request(apiUrl, path, options),
  ]);

  assert.equal(shell.status, api.status, `${label}: status differs (shell ${shell.status} vs rust ${api.status})`);

  const shellHeaders = comparableHeaders(shell.headers);
  const apiHeaders = comparableHeaders(api.headers);
  for (const h of skipHeaders) {
    delete shellHeaders[h.toLowerCase()];
    delete apiHeaders[h.toLowerCase()];
  }
  assert.deepEqual(shellHeaders, apiHeaders, `${label}: response headers differ`);

  if (compareBody) {
    compareBody(shell.text, api.text, label);
  } else {
    // BYTES, not the parsed body. A client sees bytes, and `JSON.parse` erases key order — which is
    // wire contract here, because serde_json without `preserve_order` serializes alphabetically.
    assert.equal(shell.text, api.text, `${label}: response body bytes differ`);
  }

  return { shell, api };
}

/** Run a whole case table. Returns the probe results in order. */
export async function assertABTable(shellUrl, apiUrl, probes) {
  const out = [];
  for (const probe of probes) out.push(await assertAB(shellUrl, apiUrl, probe));
  return out;
}
