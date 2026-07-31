/**
 * F4 — replay golden fixtures against ANY implementation and report differences.
 * specs/api-golden-fixtures/plan.md
 *
 *   FIXTURE_TARGET_URL=http://127.0.0.1:8098 node scripts/diff-api-fixtures.mjs
 *
 * This is what makes the fixture set an executable baseline rather than a folder nobody opens. In
 * Phase 7 it is pointed at the Node port; today it is pointed at the Rust service to prove the
 * fixtures still describe reality.
 *
 * Exits non-zero on ANY difference. Reports status, contractual headers, and the normalized body —
 * including KEY CASING, which is the whole reason the normalizer never touches it.
 */
import { readFileSync } from "node:fs";

import {
  canonicalJson,
  comparePlaceholderEquivalent,
  createNormalizer,
} from "./lib/fixture-normalize.mjs";

const target = process.env.FIXTURE_TARGET_URL;
if (!target) {
  console.error("error: FIXTURE_TARGET_URL is required and has NO default.");
  process.exit(2);
}
const fixturePath =
  process.env.FIXTURE_IN ?? "specs/api-golden-fixtures/fixtures/platform-api.json";
const TENANT = process.env.FIXTURE_TENANT ?? "hikmah-pilot-erbil";

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const normalizer = createNormalizer();

const CONTRACTUAL_HEADERS = [
  "content-type",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "www-authenticate",
];

function cookieShape(setCookie) {
  if (!setCookie) return undefined;
  const [pair, ...attrs] = setCookie.split(";").map((s) => s.trim());
  return { name: pair.split("=")[0], attributes: attrs.map((a) => a.split("=")[0]).sort() };
}

/**
 * The recorded path may contain placeholders (`<ID:session#2>`). Replay needs a REAL id.
 *
 * The fixture's ordinals and this run's ordinals differ (they are assignment-order dependent), so
 * resolution goes through the BIJECTION built while comparing bodies: expected placeholder ->
 * actual placeholder -> the raw id this run actually produced. An unresolvable placeholder is
 * reported as unreplayable rather than silently skipped.
 */
function resolvePath(path, bij, actualToRaw) {
  return path.replace(/<[^>]+>/g, (ph) => {
    const actualPh = bij.fwd.get(ph);
    const raw = actualPh === undefined ? undefined : actualToRaw.get(actualPh);
    return raw ?? ph;
  });
}

const diffs = [];
/** Shared across steps so a reference bound in one step resolves in the next. */
const bijection = { fwd: new Map(), rev: new Map() };
const actualToRaw = new Map();

for (const step of fixture.steps) {
  const { method, path, body } = step.request;
  const realPath = resolvePath(path, bijection, actualToRaw);

  if (realPath.includes("<")) {
    diffs.push({ step: step.name, kind: "unreplayable", detail: `unresolved placeholder in ${realPath}` });
    continue;
  }

  // Auth headers come from the FIXTURE, not from guessing at the step name.
  const init = { method, headers: { ...(step.request.headers ?? {}) } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${target}${realPath}`, init);
  } catch (err) {
    diffs.push({ step: step.name, kind: "unreachable", detail: err.message });
    continue;
  }

  const raw = await res.text();
  let parsed;
  try {
    parsed = raw === "" ? null : JSON.parse(raw);
  } catch {
    parsed = { "<non-json-body>": `${raw.split("\n").length} lines` };
  }

  // Remember this run's real ids against THIS run's placeholders, so a later step can resolve a
  // fixture placeholder through the bijection.
  if (parsed && typeof parsed === "object") {
    const rawId = parsed.id ?? parsed.sessionId;
    if (typeof rawId === "string") {
      const ph = normalizer.normalize({ id: rawId }).id;
      if (typeof ph === "string" && ph.startsWith("<")) actualToRaw.set(ph, rawId);
    }
  }

  if (res.status !== step.response.status) {
    diffs.push({
      step: step.name,
      kind: "status",
      detail: `expected ${step.response.status}, got ${res.status}`,
    });
  }

  const actualHeaders = {};
  for (const h of CONTRACTUAL_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) actualHeaders[h] = v;
  }
  const cookie = cookieShape(res.headers.get("set-cookie"));
  if (cookie) actualHeaders["set-cookie"] = cookie;

  const headerDiff = comparePlaceholderEquivalent(step.response.headers ?? {}, actualHeaders, "$", bijection);
  if (headerDiff) diffs.push({ step: step.name, kind: "headers", detail: headerDiff });

  // Compared by placeholder BIJECTION, not exact equality: ordinals are assignment-order
  // dependent, so a capture and a replay legitimately number the same entity differently. The
  // bijection still catches a port that loses a reference (one expected placeholder mapping to two
  // different actual ones). Key names and CASING are compared exactly.
  const bodyDiff = comparePlaceholderEquivalent(step.response.body, normalizer.normalize(parsed), "$", bijection);
  if (bodyDiff) diffs.push({ step: step.name, kind: "body", detail: bodyDiff });
}

if (diffs.length === 0) {
  console.log(`ok   ${fixture.steps.length}/${fixture.steps.length} steps match the golden fixtures`);
  process.exit(0);
}

console.error(`FAIL ${diffs.length} difference(s) against ${fixturePath}:`);
for (const d of diffs) console.error(`  [${d.kind}] ${d.step}\n      ${d.detail}`);
process.exit(1);
