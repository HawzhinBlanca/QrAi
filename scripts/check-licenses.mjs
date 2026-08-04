#!/usr/bin/env node
// P4.4 gate: dependency LICENCES, across BOTH dependency trees.
//
// The P4.4 row names "dependency/license/image/SBOM/provenance/config/TLS/CSP/CORS/security-header
// policy gates". Every one of those had a gate except this one. `pnpm audit` and `cargo audit` cover
// vulnerabilities; the SBOM records what is present; neither says whether the project is ALLOWED to
// ship what it depends on.
//
// That is not a hypothetical: a transitive dependency arriving under AGPL-3.0 changes the obligations
// of the whole distribution, and it arrives the same silent way the undici and fast-uri advisories
// did — through someone else's lockfile bump.
//
// ── Allowlist, not denylist ─────────────────────────────────────────────────────────────────────
// A denylist fails OPEN on any licence nobody thought of, which for licensing is the wrong direction:
// the unknown case needs a human, not a default. Same reasoning as `clears_learner_gate`.
//
// ── One policy, two ecosystems ──────────────────────────────────────────────────────────────────
// This gate covers the JavaScript tree (`pnpm licenses`) AND the Rust tree (`cargo metadata`). The
// first version covered JS only, on the stated grounds that `cargo-license` was not installed. That
// was the wrong conclusion from a true fact: `cargo metadata` already carries every crate's `license`
// field, so the Rust tree needed no new tooling at all — only someone to read what was already there.
// 320 crates were shipping ungated on that reasoning.
//
// ALLOWED and ACKNOWLEDGED are deliberately SHARED between the two ecosystems. Two allowlists would
// drift, and "may this project ship AGPL code" has one answer regardless of which package manager
// delivered it.
import { execFileSync } from "node:child_process";

/**
 * Licences this project may ship without asking anyone.
 *
 * Permissive, no copyleft obligation on the combined work. Each was present in one of the two trees
 * when this gate was written; the point is that the NEXT one fails until a human looks at it.
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
  "MIT-0",
  "OFL-1.1", // Fonts (Amiri, Inter). Reserved-name clause only; no source obligation.
  "Unicode-3.0", // 18 Rust crates (icu_*, unicode-*). Permissive; attribution only.
  "Unlicense",
  "Zlib",
]);

/**
 * Present, permitted to stay, and NOT the same claim as "permissive".
 *
 * Reported on every run rather than silently allowed, so each stays a decision somebody made instead
 * of a fact nobody noticed. An OR expression that can be satisfied by an ALLOWED licence never lands
 * here — `MPL-2.0 OR MIT` resolves as MIT, because it may be taken under MIT.
 */
const ACKNOWLEDGED = new Map([
  [
    "MPL-2.0",
    "file-level copyleft — dormant while these packages are consumed unmodified, live the moment one is vendored and patched",
  ],
  [
    "CDLA-Permissive-2.0",
    "a DATA licence, not a code one (webpki-roots ships Mozilla's CA set) — permissive, but redistribution carries the disclaimer text",
  ],
]);

// ── SPDX expression evaluation ───────────────────────────────────────────────────────────────────
// `pnpm licenses` mostly emits bare identifiers. `cargo metadata` emits real SPDX expressions, and
// they cannot be handled by string matching in either direction:
//
//   "MIT OR Apache-2.0 OR LGPL-2.1-or-later"   r-efi. Contains LGPL — but may be taken under MIT.
//                                              A denylist substring match REJECTS this wrongly.
//   "MIT AND BSD-3-Clause"                     matchit. BOTH apply, both must be approved.
//   "MIT AND AGPL-3.0"                         hypothetical. Contains MIT — but AGPL also binds.
//                                              An "any approved token wins" match ACCEPTS this
//                                              wrongly, which is the direction that ships a licence
//                                              violation.
//   "(MIT OR Apache-2.0) AND Unicode-3.0"      unicode-ident. Needs real precedence and parentheses.
//
// So: parse, then evaluate over a three-valued lattice.
//
//   grammar   expr := or ; or := and (OR and)* ; and := atom (AND atom)*
//                     atom := '(' expr ')' | LICENCE ('WITH' EXCEPTION)?
//   verdicts  allowed > acknowledged > unapproved
//   OR        takes the BEST branch  (a choice — take the cleanest one available)
//   AND       takes the WORST branch (a conjunction — every obligation binds)

const ALLOWED_RANK = 2;
const ACKNOWLEDGED_RANK = 1;
const UNAPPROVED_RANK = 0;

function tokenize(expression) {
  // Legacy Cargo shorthand: `MIT/Apache-2.0` means OR. No SPDX identifier contains a slash, so this
  // rewrite is unambiguous.
  return expression
    .replace(/\//g, " OR ")
    .replace(/([()])/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Parse and evaluate in one pass. Returns {rank, licenses} — `licenses` is what actually applies. */
function evaluate(expression) {
  const tokens = tokenize(expression);
  let pos = 0;

  const parseAtom = () => {
    if (tokens[pos] === "(") {
      pos += 1;
      const inner = parseOr();
      if (tokens[pos] !== ")") throw new Error(`unbalanced parentheses in "${expression}"`);
      pos += 1;
      return inner;
    }
    const id = tokens[pos];
    if (!id || id === "AND" || id === "OR" || id === ")") {
      throw new Error(`expected a licence identifier in "${expression}"`);
    }
    pos += 1;
    // `Apache-2.0 WITH LLVM-exception`: an SPDX exception grants ADDITIONAL permission on top of the
    // base licence — it can only widen what is allowed, never narrow it. Evaluating the base licence
    // is therefore sound.
    if (tokens[pos] === "WITH") pos += 2;

    if (ALLOWED.has(id)) return { rank: ALLOWED_RANK, licenses: [id] };
    if (ACKNOWLEDGED.has(id)) return { rank: ACKNOWLEDGED_RANK, licenses: [id] };
    return { rank: UNAPPROVED_RANK, licenses: [id] };
  };

  const parseAnd = () => {
    let left = parseAtom();
    while (tokens[pos] === "AND") {
      pos += 1;
      const right = parseAtom();
      // Every obligation binds: the conjunction is only as clean as its dirtiest term, and the
      // licences that APPLY are all of them.
      left = { rank: Math.min(left.rank, right.rank), licenses: [...left.licenses, ...right.licenses] };
    }
    return left;
  };

  const parseOr = () => {
    let left = parseAnd();
    while (tokens[pos] === "OR") {
      pos += 1;
      const right = parseAnd();
      // A choice: take the cleanest branch on offer, and record only that branch's licences.
      left = right.rank > left.rank ? right : left;
    }
    return left;
  };

  const result = parseOr();
  if (pos !== tokens.length) throw new Error(`trailing tokens in "${expression}"`);
  return result;
}

/**
 * @param {Array<{name: string, license: string}>} packages
 * @returns {{unapproved: Array, acknowledged: Array}}
 */
export function classify(packages) {
  const unapproved = new Map();
  const acknowledged = new Map();

  for (const { name, license } of packages) {
    let verdict;
    try {
      verdict = evaluate(license);
    } catch (error) {
      // An expression this gate cannot parse is NOT a pass. Unknown means a human looks at it.
      verdict = { rank: UNAPPROVED_RANK, licenses: [`${license} (unparseable: ${error.message})`] };
    }
    if (verdict.rank === ALLOWED_RANK) continue;

    const bucket = verdict.rank === ACKNOWLEDGED_RANK ? acknowledged : unapproved;
    // Report against the licence that CAUSED the verdict, not the whole expression — for
    // `MIT AND AGPL-3.0` the thing a human needs to look at is AGPL-3.0.
    for (const id of verdict.licenses) {
      if (verdict.rank === ACKNOWLEDGED_RANK && !ACKNOWLEDGED.has(id)) continue;
      if (verdict.rank === UNAPPROVED_RANK && (ALLOWED.has(id) || ACKNOWLEDGED.has(id))) continue;
      if (!bucket.has(id)) bucket.set(id, []);
      bucket.get(id).push(name);
    }
  }

  const shape = (map) =>
    [...map].map(([license, names]) => ({
      license,
      names: names.sort(),
      note: ACKNOWLEDGED.get(license),
    }));
  return { unapproved: shape(unapproved), acknowledged: shape(acknowledged) };
}

// ── Enumerators ──────────────────────────────────────────────────────────────────────────────────

/** Every JS package in the installed tree, flattened to {name, license}. */
function enumerateJs() {
  const raw = execFileSync("pnpm", ["licenses", "list", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = [];
  for (const [license, packages] of Object.entries(JSON.parse(raw))) {
    for (const pkg of packages ?? []) out.push({ name: pkg.name ?? String(pkg), license });
  }
  return out;
}

/**
 * Every third-party crate across all three Rust crates, deduped by name@version.
 *
 * There is no workspace root, so each crate is resolved independently and the results merged.
 * `source === null` is exactly the set of local path crates (this project's own three) — they carry
 * no `license` field and are not third-party dependencies, so they are excluded by PROVENANCE rather
 * than by a name pattern that a rename would silently break.
 */
function enumerateRust(crateDirs) {
  const seen = new Map();
  for (const dir of crateDirs) {
    const raw = execFileSync("cargo", ["metadata", "--format-version", "1"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    for (const pkg of JSON.parse(raw).packages) {
      if (pkg.source === null) continue; // first-party
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) continue;
      // A third-party crate with NO declared licence is the worst case, not an absent one.
      seen.set(key, { name: key, license: pkg.license ?? "NOASSERTION" });
    }
  }
  return [...seen.values()];
}

// ── Self-test ────────────────────────────────────────────────────────────────────────────────────
// Guard the guard. Each case below is one a plausible simpler implementation gets WRONG.

if (process.argv.includes("--self-test")) {
  const verdictOf = (license) => {
    const { unapproved, acknowledged } = classify([{ name: "probe", license }]);
    if (unapproved.length) return `unapproved:${unapproved.map((u) => u.license).join("+")}`;
    if (acknowledged.length) return `acknowledged:${acknowledged.map((a) => a.license).join("+")}`;
    return "allowed";
  };

  const cases = [
    ["MIT", "allowed"],
    ["AGPL-3.0", "unapproved:AGPL-3.0"],
    ["MPL-2.0", "acknowledged:MPL-2.0"],
    // An OR may be taken under its cleanest branch. A DENYLIST substring match fails these.
    ["MIT OR Apache-2.0 OR LGPL-2.1-or-later", "allowed"], // r-efi, real
    ["MPL-2.0 OR MIT", "allowed"], // prefer the clean branch over acknowledging
    ["Apache-2.0 OR BSL-1.0 OR MIT", "allowed"], // whoami, real — BSL never needs approving
    // An AND binds EVERY term. "Any approved token wins" ships a violation on these.
    ["MIT AND BSD-3-Clause", "allowed"], // matchit, real
    ["MIT AND AGPL-3.0", "unapproved:AGPL-3.0"], // the one that matters
    ["Apache-2.0 AND ISC", "allowed"], // ring, real
    // Precedence and parentheses.
    ["(MIT OR Apache-2.0) AND Unicode-3.0", "allowed"], // unicode-ident, real
    ["(MIT OR Apache-2.0) AND AGPL-3.0", "unapproved:AGPL-3.0"],
    ["AGPL-3.0 AND MIT OR MIT", "allowed"], // AND binds tighter than OR
    // Syntax that is not modern SPDX but is in the real tree.
    ["MIT/Apache-2.0", "allowed"], // flume, real — legacy slash means OR
    ["Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT", "allowed"], // wasi, real
    // Failure modes must fail CLOSED.
    ["NOASSERTION", "unapproved:NOASSERTION"],
    ["MIT AND (", "unapproved:MIT AND ( (unparseable: expected a licence identifier in \"MIT AND (\")"],
  ];

  let failed = 0;
  for (const [license, expected] of cases) {
    const actual = verdictOf(license);
    if (actual !== expected) {
      console.error(`  self-test FAILED  ${JSON.stringify(license)}\n    expected ${expected}\n    actual   ${actual}`);
      failed += 1;
    }
  }
  if (failed) {
    console.error(`check-licenses self-test: ${failed}/${cases.length} cases failed`);
    process.exit(1);
  }
  console.log(`check-licenses self-test OK (${cases.length} SPDX cases)`);
  process.exit(0);
}

// ── Gate ─────────────────────────────────────────────────────────────────────────────────────────

const TREES = [
  { label: "JS", enumerate: enumerateJs },
  {
    label: "Rust",
    enumerate: () =>
      enumerateRust(["services/platform-api", "services/realtime-gateway", "services/shared-ticket"]),
  },
];

const packages = [];
for (const { label, enumerate } of TREES) {
  try {
    const found = enumerate();
    // An enumerator that RAN but returned nothing is the more dangerous half of this failure, and
    // the first version of this file missed it: it caught the throw and then reported
    // "0 unapproved" over an empty list, which is a pass produced by having checked nothing.
    // Both trees have hundreds of dependencies; zero means the enumerator broke or the layout moved,
    // and either way a human should look rather than a green tick appear.
    if (found.length === 0) {
      console.error(`✗ ${label} licence enumeration returned NO packages.`);
      console.error("  That is not a clean tree — it is a gate that checked nothing. Either the");
      console.error("  enumerator is broken or the project layout moved; fix it rather than");
      console.error("  accepting a pass over an empty list.");
      process.exit(1);
    }
    packages.push(...found);
    console.log(`  ${label}: ${found.length} third-party packages`);
  } catch (error) {
    // Fail closed. A licence gate that passes because the tool did not run is not a gate — it is the
    // same "guard that passes for the wrong reason" this file exists to prevent.
    console.error(`✗ could not enumerate ${label} licences: ${error.message}`);
    process.exit(1);
  }
}

const { unapproved, acknowledged } = classify(packages);

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

console.log(
  `✓ dependency licences: ${packages.length} packages across JS + Rust, ` +
    `${ALLOWED.size} licences approved, ${acknowledged.length} acknowledged, 0 unapproved`,
);
