#!/usr/bin/env node
/**
 * P4.4 — produce the SPDX SBOM the release evidence chain requires, and refuse to produce an empty
 * one.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────────
 * `scripts/release-manifest.mjs` demands an SBOM as a material input: it hashes the file, checks
 * `spdxVersion` starts with `SPDX-`, requires `SPDXID`, `name`, `documentNamespace` and a populated
 * `creationInfo`, and binds the hash into the signed manifest. `.github/workflows/release-challenge.yml`
 * passes `--sbom "$PWD/evidence/sbom.spdx.json"`.
 *
 * NOTHING PRODUCED ONE. The only SBOM step in the repository is `.github/workflows/ci.yml`'s
 * `cdxgen`, which writes `sbom.cdx.json` — CycloneDX, a different format with none of those fields —
 * and is explicitly non-blocking (`|| echo "::warning::…"`), so it can also produce nothing at all
 * and leave CI green. A release assembled from what this repository actually builds would reach
 * `release-manifest.mjs --generate` and stop, on release day, in front of whoever is holding it.
 *
 * ── And an SBOM with no packages satisfied every check ──────────────────────────────────────────
 * The manifest validates the SPDX document HEADER and never looks inside. `packages: []` passes all
 * of it — which is not a hypothesis: `scripts/release-manifest.test.mjs` builds its fixture SBOM
 * with exactly that, so the suite proving the evidence chain works has never seen an SBOM that
 * inventories anything. A component inventory that may be empty is not evidence of components.
 *
 * ── Why this generates rather than shells out to a scanner ──────────────────────────────────────
 * `scripts/check-licenses.mjs` already enumerates BOTH dependency trees — `pnpm licenses list` for
 * JavaScript and `cargo metadata` for the three Rust crates — because the licence gate needed the
 * same facts. Reading them again from the lockfiles the build actually resolves is more faithful
 * than a network scanner's opinion, needs no new dependency, and produces the same answer on a
 * runner with no registry access.
 *
 * The document is deterministic apart from `creationInfo.created` and the namespace's candidate SHA:
 * packages are sorted, so two runs on one tree differ in the timestamp alone.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The three Rust crates, matching `check-licenses.mjs` — there is no cargo workspace root. */
const CRATE_DIRS = ["services/platform-api", "services/realtime-gateway", "services/shared-ticket"];

/**
 * Floors, per ecosystem.
 *
 * The point of the whole file. An inventory that lists three packages is as useless as one that
 * lists none, and both look like success to a header check. These are set FAR below the real counts
 * (209 npm packages and 300+ crates when written) so ordinary dependency churn never trips them —
 * they catch an enumerator that returned nothing or nearly nothing, which is the way this breaks:
 * `pnpm licenses` run before `pnpm install`, or `cargo metadata` in a directory with no lockfile.
 */
export const FLOORS = { npm: 50, cargo: 100 };

/** SPDX forbids anything outside `[A-Za-z0-9.-]` in an element id. */
export function spdxId(kind, name, version) {
  const slug = `${name}@${version}`.replace(/[^A-Za-z0-9.-]/g, "-");
  return `SPDXRef-${kind}-${slug}`;
}

/** Package URL. The identifier a security reviewer can actually look a component up by. */
export function purl(ecosystem, name, version) {
  if (ecosystem === "npm") {
    // A scoped name's `@` and `/` are structural in a purl and must survive: `@scope/pkg` is
    // `pkg:npm/%40scope/pkg`.
    const encoded = name.startsWith("@")
      ? `%40${encodeURIComponent(name.slice(1).split("/")[0])}/${encodeURIComponent(name.split("/")[1] ?? "")}`
      : encodeURIComponent(name);
    return `pkg:npm/${encoded}@${version}`;
  }
  return `pkg:cargo/${encodeURIComponent(name)}@${version}`;
}

/**
 * Turn flattened `{ecosystem, name, version, license}` records into SPDX package entries.
 *
 * Throws rather than emitting a degraded document. An SBOM is read when something has gone wrong
 * somewhere else; it is the wrong artifact to make best-effort.
 */
export function toSpdxPackages(components) {
  const byId = new Map();
  for (const { ecosystem, name, version, license } of components) {
    if (!name || !version) {
      throw new Error(`component with no name or version: ${JSON.stringify({ ecosystem, name, version })}`);
    }
    const id = spdxId(ecosystem === "npm" ? "npm" : "crate", name, version);
    if (byId.has(id)) continue; // the same package reached through two paths
    byId.set(id, {
      SPDXID: id,
      name,
      versionInfo: version,
      // `NOASSERTION` is SPDX's word for "this document does not say", and it is the honest value:
      // the licence recorded is the one the package DECLARES, which is not the same as a conclusion
      // somebody reached about it. `check-licenses.mjs` is where the declared value is judged.
      licenseDeclared: license || "NOASSERTION",
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: purl(ecosystem, name, version),
        },
      ],
    });
  }
  return [...byId.values()].sort((a, b) => (a.SPDXID < b.SPDXID ? -1 : a.SPDXID > b.SPDXID ? 1 : 0));
}

/**
 * What is wrong with a finished SPDX document, as a list.
 *
 * Pure and exported: this is the assertion the tests exercise on synthetic documents, and the same
 * one `--check` applies to a real file. A validator that can only run against a correct tree has
 * never been shown a wrong one.
 */
export function documentProblems(document, floors = FLOORS) {
  const problems = [];
  if (typeof document?.spdxVersion !== "string" || !document.spdxVersion.startsWith("SPDX-")) {
    problems.push("spdxVersion is missing or is not an SPDX- version");
  }
  for (const field of ["SPDXID", "name", "documentNamespace", "dataLicense"]) {
    if (typeof document?.[field] !== "string" || !document[field]) problems.push(`${field} is missing`);
  }
  if (!Array.isArray(document?.creationInfo?.creators) || document.creationInfo.creators.length === 0) {
    problems.push("creationInfo.creators is empty");
  }
  if (typeof document?.creationInfo?.created !== "string" || Number.isNaN(Date.parse(document.creationInfo.created))) {
    problems.push("creationInfo.created is not a date");
  }

  const packages = document?.packages;
  if (!Array.isArray(packages) || packages.length === 0) {
    problems.push(
      "packages is empty — an SBOM that inventories nothing satisfies every header check and " +
        "tells a security reviewer nothing about what ships",
    );
    return problems;
  }

  const ids = new Set();
  const counts = { npm: 0, cargo: 0 };
  for (const pkg of packages) {
    if (typeof pkg?.SPDXID !== "string" || !pkg.SPDXID.startsWith("SPDXRef-")) {
      problems.push(`a package has no SPDXRef- id: ${JSON.stringify(pkg?.name ?? pkg)}`);
      continue;
    }
    // Two packages sharing an id makes every relationship in the document ambiguous, and a
    // deduplicating consumer silently drops one of them from the inventory.
    if (ids.has(pkg.SPDXID)) problems.push(`duplicate SPDXID: ${pkg.SPDXID}`);
    ids.add(pkg.SPDXID);
    if (!pkg.name) problems.push(`${pkg.SPDXID} has no name`);
    // A package with no version cannot be matched against an advisory, which is most of what an
    // SBOM is for.
    if (!pkg.versionInfo) problems.push(`${pkg.SPDXID} has no versionInfo`);
    if (!pkg.licenseDeclared) problems.push(`${pkg.SPDXID} has no licenseDeclared`);

    const locator = pkg.externalRefs?.find((ref) => ref.referenceType === "purl")?.referenceLocator;
    if (typeof locator !== "string") {
      problems.push(`${pkg.SPDXID} has no purl external reference`);
    } else if (locator.startsWith("pkg:npm/")) counts.npm += 1;
    else if (locator.startsWith("pkg:cargo/")) counts.cargo += 1;
  }

  // Both trees, not just the one whose enumerator happened to work. The Rust tree was shipping
  // ungated for exactly this reason once already — see check-licenses.mjs's own history.
  for (const [ecosystem, floor] of Object.entries(floors)) {
    if (counts[ecosystem] < floor) {
      problems.push(
        `only ${counts[ecosystem]} ${ecosystem} packages, floor is ${floor} — the enumerator ` +
          "returned nothing or nearly nothing, which is what a missing install or lockfile looks like",
      );
    }
  }
  return problems;
}

// ── Enumerators ──────────────────────────────────────────────────────────────────────────────────

function enumerateNpm() {
  const raw = execFileSync("pnpm", ["licenses", "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const components = [];
  for (const [license, packages] of Object.entries(JSON.parse(raw))) {
    for (const pkg of packages ?? []) {
      for (const version of pkg.versions ?? []) {
        components.push({ ecosystem: "npm", name: pkg.name, version, license });
      }
    }
  }
  return components;
}

/** Third-party crates across all three crates. `source === null` is this project's own code. */
function enumerateCargo() {
  const components = [];
  for (const dir of CRATE_DIRS) {
    const raw = execFileSync("cargo", ["metadata", "--format-version", "1"], {
      cwd: path.join(ROOT, dir),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    for (const pkg of JSON.parse(raw).packages) {
      if (pkg.source === null) continue;
      components.push({
        ecosystem: "cargo",
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? "NOASSERTION",
      });
    }
  }
  return components;
}

export function buildDocument({ candidateSha, created, components }) {
  const packages = toSpdxPackages(components);
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `qrai-${candidateSha}`,
    // Must be unique per document. The candidate SHA makes it unique AND makes an SBOM from a
    // different commit visibly a different document rather than a plausible substitute.
    documentNamespace: `https://qrai.invalid/sbom/${candidateSha}`,
    creationInfo: { created, creators: ["Tool: qrai-generate-sbom"] },
    packages,
    relationships: packages.map((pkg) => ({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: pkg.SPDXID,
    })),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

function main() {
  if (process.argv.includes("--check")) {
    // Validate an existing document without regenerating — what CI runs against the artifact it is
    // about to upload, and what a reviewer can run against a bundle they were handed.
    const target = argValue("--check");
    const document = JSON.parse(readFileSync(target, "utf8"));
    const problems = documentProblems(document);
    if (problems.length) {
      console.error(`✗ ${target} is not a usable SBOM:`);
      for (const problem of problems) console.error(`    - ${problem}`);
      process.exit(1);
    }
    console.log(`✓ ${target} — ${document.packages.length} packages, both ecosystems above floor`);
    return;
  }

  const candidateSha =
    argValue("--candidate-sha") ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const output = argValue("--out", path.join(ROOT, "sbom.spdx.json"));

  const components = [...enumerateNpm(), ...enumerateCargo()];
  const document = buildDocument({
    candidateSha,
    created: new Date().toISOString(),
    components,
  });

  const problems = documentProblems(document);
  if (problems.length) {
    // Refuse to write. A file on disk named `sbom.spdx.json` is taken as an SBOM by everything
    // downstream, and a bad one is worse than an absent one because the absence is noticed.
    console.error("✗ refusing to write an SBOM that does not inventory this project:");
    for (const problem of problems) console.error(`    - ${problem}`);
    process.exit(1);
  }

  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
  const npm = document.packages.filter((p) =>
    p.externalRefs.some((r) => r.referenceLocator.startsWith("pkg:npm/")),
  ).length;
  console.log(
    `✓ ${path.relative(ROOT, output)} — ${document.packages.length} packages ` +
      `(${npm} npm, ${document.packages.length - npm} cargo) for ${candidateSha}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
