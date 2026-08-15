import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every consent choice a learner is offered must do something on the server, or say why it does not.
 *
 * The consent panel offers five. Three are enforced server-side. Two are not, and one of those is
 * labelled "(Required to record.)":
 *
 *   session create with recordingConsent=false -> 200
 *   realtime ticket for that session          -> 200  TICKET ISSUED
 *   stored consent snapshot recordingConsent  =  false
 *
 * Reproduced against a running service on 2026-08-12. ADR-0062 holds the question of how to enforce
 * it, because 4,615 existing sessions record `false` and `false` is also the default — so the data
 * cannot distinguish "declined" from "never asked", and a naive gate would deny most of them.
 *
 * ── Why a checkbox that does nothing is worse than no checkbox ──────────────────────────────────
 * It ends the investigation. A learner who unticks "Help improve the model with anonymized data"
 * believes they have made a choice; a reviewer seeing the field in the contract, the UI, the export
 * and the erasure assumes it is wired. `anonymizedLearning` appears 52 times in this repository and
 * its only conditional use is a `typeof` check.
 *
 * ── The two lists ───────────────────────────────────────────────────────────────────────────────
 * A: the fields of `ConsentSnapshot`, read from the contract — so a sixth flag appears here the
 *    moment someone adds one.
 * B: the gates below, each naming a file and a marker that must still be present in it.
 *
 * A flag in A with no gate must be declared, with a reason. This is the same shape as the erasure
 * guard: not "everything must be enforced", but "say what each one does and be checked on it".
 *
 * Hermetic: reads the contract and a handful of sources.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACT = join(root, "packages/contracts/src/index.ts");

/** Long enough that a shrug cannot pass for an argument. Mirrors the erasure and P2.6 guards. */
const MIN_REASON = 40;

/**
 * Where each enforced flag is actually decided.
 *
 * A file plus a marker, not just a filename: a gate that was deleted while the file survived would
 * otherwise still count. Rust and Node are both listed where both implement it, because the parity
 * suite compares them and a gate present in one is not a gate.
 */
const GATES = {
  audioRetention: [
    { file: "packages/contracts/src/index.ts", marker: "export function mustDiscardAudio" },
    { file: "server/src/inference/runtime.mjs", marker: 'retention === "teacher-review"' },
  ],
  externalAsrProcessing: [
    { file: "packages/contracts/src/index.ts", marker: "export function canUseExternalAsr" },
    { file: "services/platform-api/src/handlers/recitation.rs", marker: "external_asr_processing && req.consent.guardian_approved" },
    { file: "server/src/routes/session-writes.mjs", marker: "consent.externalAsrProcessing && consent.guardianApproved" },
  ],
  guardianApproved: [
    { file: "packages/contracts/src/index.ts", marker: "consent.externalAsrProcessing && consent.guardianApproved" },
    { file: "server/src/routes/ml-proxy.mjs", marker: "guardian_approved" },
  ],
};

/** Flags with no gate, and the recorded reason. Both point at ADR-0062. */
const UNENFORCED = {
  recordingConsent: {
    why:
      "no server reads it: `consent_records` has no recording_consent column, so the ticket mint " +
      "joins a table that cannot contain it. Reproduced — a session whose snapshot says false is " +
      "issued an audio ticket. Enforcement needs a ruling on 4,615 rows where false is also the " +
      "default: ADR-0062.",
  },
  anonymizedLearning: {
    why:
      "records a preference for a capability that does not exist — there is no training pipeline " +
      "(P3.4/P3.5), so no data is used for learning either way. Harmless today, which is why it " +
      "could stay unwired: ADR-0062 asks whether to build the gate or remove the checkbox.",
  },
};

/** List A — the consent fields the contract defines. */
function consentFields() {
  const src = readFileSync(CONTRACT, "utf8");
  const start = src.indexOf("export interface ConsentSnapshot");
  assert.ok(start >= 0, "ConsentSnapshot is gone from the contract");
  const body = src.slice(start, src.indexOf("}", start));
  return [...body.matchAll(/^\s*(\w+)\??:/gm)]
    .map((m) => m[1])
    .filter((f) => f !== "consentVersion"); // a version string, not a choice
}

test("the contract still declares a consent shape this can read", () => {
  // Non-vacuity: a renamed interface would yield zero fields and every assertion below would pass
  // over an empty set, reporting that every consent choice is accounted for.
  const fields = consentFields();
  assert.ok(
    fields.length >= 4,
    `parsed only ${fields.length} consent fields — fix this parser, do not delete the check. ` +
      `Found: ${fields.join(", ")}`,
  );
});

test("every consent choice is enforced somewhere, or declared as not enforced", () => {
  const unaccounted = consentFields().filter((f) => !GATES[f] && !UNENFORCED[f]);
  assert.deepEqual(
    unaccounted,
    [],
    `these consent choices are offered to a learner and nothing here says what they do:\n  ` +
      `${unaccounted.join("\n  ")}\n` +
      `A checkbox that does nothing is worse than no checkbox: it ends the investigation.`,
  );
});

/**
 * Does `src` still contain `marker` as a whole thing?
 *
 * A plain `includes` is not enough, and the negative control is what proved it: renaming
 * `mustDiscardAudio` to `mustDiscardAudioRenamed` left the marker `"export function
 * mustDiscardAudio"` matching as a PREFIX, so the control did not fire and the guard reported a
 * gate that no caller could reach any more. When a marker ends in an identifier character, the next
 * character must not extend it.
 */
function containsMarker(src, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = /[A-Za-z0-9_]$/.test(marker) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(escaped + suffix).test(src);
}

test("every claimed gate is still present in the file that claims it", () => {
  // The assertion that makes this more than a list of names. A gate deleted from a file that
  // survives would otherwise keep counting, and the flag would look enforced forever.
  const broken = [];
  for (const [flag, gates] of Object.entries(GATES)) {
    for (const { file, marker } of gates) {
      let src;
      try {
        src = readFileSync(join(root, file), "utf8");
      } catch {
        broken.push(`${flag}: ${file} does not exist`);
        continue;
      }
      if (!containsMarker(src, marker)) {
        broken.push(`${flag}: ${file} no longer contains ${JSON.stringify(marker)}`);
      }
    }
  }
  assert.deepEqual(broken, [], `consent gates that have moved or gone:\n  ${broken.join("\n  ")}`);
});

test("an unenforced flag carries a reason worth reading, and ADR-0062 is still open", () => {
  const thin = Object.entries(UNENFORCED)
    .filter(([, v]) => (v.why ?? "").length < MIN_REASON)
    .map(([flag, v]) => `${flag}: ${v.why?.length ?? 0} chars, need ${MIN_REASON}`);
  assert.deepEqual(thin, [], `unenforced flags with no argument:\n  ${thin.join("\n  ")}`);

  const adrs = readFileSync(join(root, "docs/DECISIONS.md"), "utf8");
  assert.match(adrs, /## ADR-0062 —/, "ADR-0062 is gone, so two unenforced consent flags have no recorded reason");
  assert.match(
    adrs.slice(adrs.indexOf("## ADR-0062 —")),
    /\*\*Status:\*\* Proposed/,
    "ADR-0062 is no longer Proposed — if the ruling was made, these flags need gates, not declarations",
  );
});

test("a flag declared unenforced has not quietly acquired a gate", () => {
  // The reverse direction. If someone wires `recordingConsent` without revisiting ADR-0062, this
  // fails — because enforcing it against 4,615 rows where `false` is the default is the decision
  // the ADR exists to make, and shipping it silently is how consenting learners get denied.
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (["node_modules", "target", "dist"].includes(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(rs|mjs)$/.test(p)) files.push(p);
    }
  };
  walk(join(root, "services"));

  const gated = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // A refusal keyed on the flag: a comparison next to an error, a 403, or a rejection.
    for (const m of src.matchAll(/^.*(recording_consent|recordingConsent).*$/gm)) {
      const line = m[0];
      if (/\b(403|Forbidden|RejectionError|ApiError::|reject|refus)/i.test(line)) {
        gated.push(`${file.slice(root.length + 1)}: ${line.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(
    gated,
    [],
    `recordingConsent now appears to be enforced:\n  ${gated.join("\n  ")}\n` +
      `That is the right destination, but ADR-0062 must be decided first — 4,615 existing sessions ` +
      `record false, and false is also the default.`,
  );
});
