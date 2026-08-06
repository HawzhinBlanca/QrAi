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

import { SHELL_URLS, request } from "./harness.mjs";

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

  // ── The B side must be RUST ─────────────────────────────────────────────────────────────────────
  // Under `PARITY_THROUGH_SHELL=1`, `startApi().baseUrl` is a Node shell and Rust is `upstreamUrl`.
  // `assertAB(shell.baseUrl, api.baseUrl, …)` therefore compared Node with Node — a shell in front of
  // a shell, differed against that inner shell — and no divergence between the implementations could
  // ever fail it. Measured: `Meccan` from Rust vs `MECCAN` from Node on canonical surah metadata left
  // all 10 probes in quran-parity GREEN in both verify.sh passes.
  //
  // Thrown, not asserted, and thrown BEFORE the requests: a differ that cannot differ should not
  // report a passing comparison, and this must fire even inside a `t.skip`ped or try/caught probe.
  if (SHELL_URLS.has(apiUrl)) {
    throw new Error(
      `${label}: the B side of the differ is a Node shell (${apiUrl}), so this compares Node with ` +
        `itself and cannot fail. Pass the Rust url — \`api.upstreamUrl ?? api.baseUrl\`.`,
    );
  }

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

/**
 * The A/B for a route that MUTATES, or whose response embeds `now()`.
 *
 * `assertAB` sends one identical request to both implementations. That is wrong twice over here:
 *
 *  1. **State.** `POST /v1/learner/progress` advances an SM-2 schedule. Sending the same request to
 *     both would have the second call read the first's write, so the two responses would legitimately
 *     differ and the differ would report a port bug that is really a test bug.
 *  2. **Time.** `nextReviewAt` is `now() + interval`. Two calls a few milliseconds apart produce
 *     different bytes no matter how correct the port is. Byte equality is simply not the property.
 *
 * So each side gets its OWN subject (a distinct ayahRef, learner, session), and the bodies are
 * compared after `normalize` blanks the fields that are allowed to differ. What is left must still
 * match exactly — including the SM-2 arithmetic, which is the whole point of the comparison.
 *
 * `normalize` must be explicit about what it erases. A normalizer that blanks a field the port got
 * WRONG turns this into a test that cannot fail, so every key it touches should be one that
 * provably varies with time or identity, never one that merely turned out to be inconvenient.
 */
export async function assertABMutating(shellUrl, apiUrl, { name, probeFor, normalize }) {
  const label = name ?? "mutating A/B";

  const [shell, api] = await Promise.all([
    (async () => {
      const p = probeFor("shell");
      return request(shellUrl, p.path, p);
    })(),
    (async () => {
      const p = probeFor("rust");
      return request(apiUrl, p.path, p);
    })(),
  ]);

  assert.equal(shell.status, api.status, `${label}: status differs (shell ${shell.status} vs rust ${api.status})`);
  assert.deepEqual(
    comparableHeaders(shell.headers),
    comparableHeaders(api.headers),
    `${label}: response headers differ`,
  );
  assert.deepEqual(
    normalize(shell.body, "shell"),
    normalize(api.body, "rust"),
    `${label}: normalized response bodies differ`,
  );

  // Key ORDER is wire contract (serde_json is BTreeMap-backed) and `normalize` operates on a parsed
  // object, which loses it. Compare it separately rather than silently dropping the guarantee.
  if (shell.body && typeof shell.body === "object" && !Array.isArray(shell.body)) {
    assert.deepEqual(Object.keys(shell.body), Object.keys(api.body), `${label}: key ORDER differs`);
  }

  return { shell, api };
}
