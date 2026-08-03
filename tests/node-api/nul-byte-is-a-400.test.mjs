import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The NUL-byte translation, and the reason the widened Node-port parity run exists.
 *
 * `tests/api-parity/hostile-input.test.mjs` is the real oracle — it drives fourteen live surfaces
 * against both implementations and needs Postgres. This file is the cheap half: it runs in the
 * hermetic Node suite, on every build, with no database, and it pins the two things a future edit
 * could quietly get wrong.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────────────────────────
 * Postgres text cannot hold U+0000. Rust translates the resulting SQLSTATE into a 400 that names the
 * problem (`impl From<sqlx::Error> for ApiError`). The Node port never mirrored it, so the same
 * input answered `500 {"error":"internal error"}` on fourteen surfaces: bad input reported as a
 * server fault, with nothing telling the caller what to fix.
 *
 * It survived because the gate ran the Node-port A/B over two of thirty-six routes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const server = readFileSync(join(root, "services/node-api/server.mjs"), "utf8");

test("both NUL SQLSTATEs are translated, not just the text-column one", () => {
  // 22021 is `text`; 22P05 is `jsonb`. The Rust original shipped with only 22021 and POST
  // /v1/agent-runs — which writes `sources` into a jsonb column — kept 500ing until 22P05 was added.
  // Same defect, same byte, different column type. A port that copies only the first half inherits
  // exactly one route's worth of the bug.
  for (const code of ["22021", "22P05"]) {
    assert.match(
      server,
      new RegExp(`"${code}"`),
      `SQLSTATE ${code} is not translated, so a NUL byte into that column type is still a 500`,
    );
  }
});

test("the translation is NOT widened to the rest of SQLSTATE class 22", () => {
  // Class 22 is "Data Exception", and mapping the whole class would be the obvious generalisation.
  // It is wrong: 22003 numeric_value_out_of_range is how the SM-2 interval overflow surfaced — a
  // SERVER bug. Reporting that as 400 would blame the caller and hide it.
  for (const code of ["22003", "22001", "22012"]) {
    assert.ok(
      !server.includes(`"${code}"`),
      `SQLSTATE ${code} is being reported as a client error; it is not unambiguously caller-supplied`,
    );
  }
  assert.ok(
    !/code\.startsWith\(["']22["']\)/.test(server),
    "the whole of class 22 is being mapped to 400, which would report server bugs as bad input",
  );
});

test("the 400 does not forward the database's own error text", () => {
  // The 500 branch redacts driver text because it can carry table and constraint names and, on a
  // conflict, the offending values. A 400 must not become the way around that redaction.
  assert.match(
    server,
    /request contains a NUL byte \(U\+0000\), which cannot be stored/,
    "the fixed message is missing — byte-identical to Rust, because the A/B compares bodies",
  );
  assert.ok(
    !/code\(400\)[\s\S]{0,200}err\.message/.test(server),
    "the NUL branch is forwarding err.message, which is the driver's text",
  );
});

test("the gate reads the ported route list from PORTABLE instead of a copy", () => {
  // The whole point of widening the run. A hardcoded list in verify.sh is a second place to
  // remember, and the forgotten one is always the gate: a route added to PORTABLE would be servable
  // in production with nothing comparing it to the Rust original.
  const verify = readFileSync(join(root, "scripts/verify.sh"), "utf8");
  const line = verify
    .split("\n")
    .find((l) => l.includes("PARITY_THROUGH_SHELL=1") && l.includes("NODE_API_PORTED"));
  assert.ok(line, "verify.sh no longer runs the parity suite through the Node port at all");
  assert.ok(
    /PORTABLE/.test(verify.slice(verify.indexOf(line), verify.indexOf(line) + 900)),
    "NODE_API_PORTED is being built from something other than PORTABLE, so the two can drift",
  );
});
