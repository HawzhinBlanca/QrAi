/**
 * CU1 — the cutover readiness state, derived from the repo rather than remembered.
 * specs/cutover/plan.md
 *
 *   node scripts/cutover-readiness.mjs
 *
 * ── What this is, and what it deliberately is NOT ───────────────────────────────────────────────
 * Phase 9's gate is a HUMAN SIGNATURE: P1.7 requires a security reviewer to challenge the deployed
 * identity boundary and *sign* the result. No script produces that.
 *
 * So this tool is **structurally incapable of printing GO.** It reports the six mechanically
 * decidable preconditions and names the two that only a person can settle. A tool that could
 * conclude "ready" would invite exactly the rubber-stamp this repo has spent nine phases avoiding —
 * the point is to make the distance measurable, not to shorten it.
 *
 * Every check takes its SOURCE TEXT as an argument rather than reading a path, so
 * tests/contract/cutover-readiness.test.mjs can feed synthetic inputs and prove each verdict
 * actually FLIPS. A checker that reads the right file and extracts the wrong thing looks identical
 * to a correct one until something moves — which is precisely how Phase 7's route parser silently
 * missed five chained registrations until Phase 8's contract disagreed with it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MET = "MET";
export const UNMET = "UNMET";
export const NEEDS_HUMAN = "NEEDS-HUMAN";

const check = (id, state, detail) => ({ id, state, detail });

/** How much traffic would the Node shell actually take? */
export function checkTrafficShare(serverSrc, totalPairs) {
  const portable = serverSrc.match(/export const PORTABLE = \[([^\]]*)\]/s);
  const count = portable ? (portable[1].match(/"/g)?.length ?? 0) / 2 : 0;
  // The DEFAULT is what production runs. `NODE_API_PORTED ?? ""` means zero routes served.
  const defaultsEmpty = /NODE_API_PORTED\s*\?\?\s*""/.test(serverSrc);
  const served = defaultsEmpty ? 0 : null;
  return check(
    "traffic-share",
    served === totalPairs ? MET : UNMET,
    served === 0
      ? `Node serves 0 of ${totalPairs} routes by default (${count} portable). Nothing to cut over.`
      : `default routing is not the empty set — read services/node-api/server.mjs before trusting this`,
  );
}

/** Is there an artifact to roll back TO? */
export function checkRollbackArtifact(workflowSources) {
  const pattern = /docker\s+build|docker\s+push|docker\/build-push|ghcr\.io|registry\.|buildx/i;
  const hit = workflowSources.find(({ text }) => pattern.test(text));
  return check(
    "rollback-artifact",
    hit ? MET : UNMET,
    hit
      ? `an image build/push exists in ${hit.name}`
      : "no workflow builds or pushes an image, so rollback means `git checkout && docker compose build` — a rebuild, not a rollback (ADR-0022)",
  );
}

export function checkAdr0022(decisionsSrc) {
  const section = decisionsSrc.split("## ADR-0022")[1] ?? "";
  const status = /\*\*Status:\*\*\s*([A-Za-z]+)/.exec(section)?.[1] ?? "missing";
  return check(
    "adr-0022-accepted",
    status.toLowerCase() === "accepted" ? MET : UNMET,
    `ADR-0022 (immutable, digest-pinned deployable artifacts) is ${status}`,
  );
}

/** The readiness rows that ARE the gate. Signatures, so never mechanically MET. */
export function checkSignOffRows(tasksSrc) {
  const rows = ["P1.7", "P4.1"];
  const open = rows.filter((id) => new RegExp(`^- \\[ \\] ${id.replace(".", "\\.")} `, "m").test(tasksSrc));
  return check(
    "security-sign-off",
    NEEDS_HUMAN,
    open.length === 0
      ? `${rows.join(" and ")} are marked done — verify a REAL reviewer signed them, not a script`
      : `${open.join(" and ")} still open; both require a person to sign, by construction`,
  );
}

export function checkOperationalProof(tasksSrc) {
  const rows = ["P5.5", "P5.6"];
  const open = rows.filter((id) => new RegExp(`^- \\[ \\] ${id.replace(".", "\\.")} `, "m").test(tasksSrc));
  return check(
    "operational-proof",
    open.length === 0 ? MET : UNMET,
    open.length === 0
      ? "rollback, kill switch and DR drill all proven"
      : `${open.join(" and ")} open — kill switch / rollback / DR drill not proven`,
  );
}

/** How much of the boundary has an executable check behind it? */
export function checkOracleCoverage(coveredPairs, totalPairs) {
  return check(
    "boundary-oracle-coverage",
    coveredPairs === totalPairs ? MET : UNMET,
    `${coveredPairs} of ${totalPairs} method+path pairs have a fixture or a parity test; ` +
      `${totalPairs - coveredPairs} have neither`,
  );
}

/** How many contracted operations have a real response schema rather than a permissive one? */
export function checkSchemaValidation(openapiDoc) {
  let total = 0;
  let unvalidated = 0;
  for (const item of Object.values(openapiDoc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      total += 1;
      if (op["x-unvalidated"] === true) unvalidated += 1;
    }
  }
  return check(
    "response-schemas-validated",
    unvalidated === 0 ? MET : UNMET,
    `${total - unvalidated} of ${total} operations have a validated response schema; ` +
      `${unvalidated} are marked x-unvalidated`,
  );
}

/**
 * Summarise — and REFUSE to conclude.
 *
 * NEEDS-HUMAN is counted in its own bucket and never added to `met`. That is the invariant
 * tests/contract/cutover-readiness.test.mjs pins: no combination of inputs may make this report
 * readiness, because readiness is a signature and this is a script.
 */
export function summarise(checks) {
  const met = checks.filter((c) => c.state === MET).length;
  const unmet = checks.filter((c) => c.state === UNMET).length;
  const human = checks.filter((c) => c.state === NEEDS_HUMAN);
  return {
    met,
    unmet,
    human: human.length,
    mechanicalComplete: unmet === 0,
    // Deliberately not a boolean called `ready`. There is no such field, so nothing can read one.
    conclusion:
      unmet > 0
        ? `NOT READY — ${unmet} mechanical precondition(s) unmet, plus ${human.length} requiring a signature`
        : `mechanical preconditions met — ${human.length} signature(s) still required, which no script can give`,
  };
}

/**
 * Which of the service's pairs have a fixture or a parity test behind them.
 *
 * Compares on SEGMENT SHAPE — a path parameter, a fixture's concrete id and a template literal all
 * collapse to the same token — because the three sources spell ids three different ways and matching
 * them literally is how Phase 7 produced three different coverage numbers in a row.
 */
export function coveredPairs(rustPairs, fixtureSteps, paritySourceText) {
  const shape = (path) =>
    path
      .split("?")[0]
      .split("/")
      .filter(Boolean)
      .map((seg) =>
        /^\{.*\}$|^\$\{.*\}$|^<ID:.*>$|^\d+$|^[a-z-]*[0-9a-f]{8}-[0-9a-f-]{27}$|^session-does-not-exist$/.test(seg)
          ? "*"
          : seg,
      )
      .join("/");

  const covered = new Set();
  for (const step of fixtureSteps) {
    covered.add(`${step.request.method} ${shape(step.request.path)}`);
  }
  // The parity suite builds paths from template literals, so match on the path shape for ANY method:
  // a parity test that exercises a path proves that path is reachable and asserted.
  const parityShapes = new Set(
    [...paritySourceText.matchAll(/["\'`](\/(?:v1\/[^"\'`\s]*|health|ready|metrics))["\'`]/g)].map((m) =>
      shape(m[1]),
    ),
  );

  return rustPairs.filter(
    ({ method, path }) => covered.has(`${method} ${shape(path)}`) || parityShapes.has(shape(path)),
  ).length;
}

async function main() {
  const { readdirSync } = await import("node:fs");
  const { loadOpenapi, routePairsFromRust } = await import("../tests/contract/lib/openapi.mjs");

  const read = (p) => readFileSync(p, "utf8");
  const rustPairs = routePairsFromRust(read("services/platform-api/src/lib.rs"));
  const openapi = loadOpenapi("specs/flutter-client/openapi.yaml");
  const fixtures = JSON.parse(read("specs/api-golden-fixtures/fixtures/platform-api.json"));
  const parityText = readdirSync("tests/api-parity")
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => read(join("tests/api-parity", f)))
    .join("\n");
  const workflows = readdirSync(".github/workflows").map((name) => ({
    name,
    text: read(join(".github/workflows", name)),
  }));
  const readiness = read("specs/readiness-recovery-10-10/tasks.md");

  const checks = [
    checkTrafficShare(read("services/node-api/server.mjs"), rustPairs.length),
    checkOracleCoverage(coveredPairs(rustPairs, fixtures.steps, parityText), rustPairs.length),
    checkSchemaValidation(openapi),
    checkRollbackArtifact(workflows),
    checkAdr0022(read("docs/DECISIONS.md")),
    checkOperationalProof(readiness),
    checkSignOffRows(readiness),
  ];

  const pad = (s) => s.padEnd(12);
  console.log("cutover readiness — derived from the repo, not from a document\n");
  for (const c of checks) console.log(`  ${pad(c.state)} ${c.id}\n               ${c.detail}`);

  const s = summarise(checks);
  console.log(`\n  ${s.met} met · ${s.unmet} unmet · ${s.human} needing a signature`);
  console.log(`\n  ${s.conclusion}`);
  console.log(
    "\n  This tool cannot report GO. Phase 9's gate is a security reviewer's signature (P1.7),\n" +
      "  and a script that could conclude 'ready' would be a rubber stamp.",
  );
}

// Informational by design: `verify.sh` runs it for the record, and "not ready to cut over" is the
// correct expected state — a gate that went red for that would be noise, and noise gets silenced.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
