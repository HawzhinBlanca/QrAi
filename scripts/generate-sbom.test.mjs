import assert from "node:assert/strict";
import test from "node:test";

import { FLOORS, buildDocument, documentProblems, purl, spdxId, toSpdxPackages } from "./generate-sbom.mjs";

/**
 * P4.4 — the SBOM validator, exercised on documents that are WRONG.
 *
 * `documentProblems` is applied to the real tree by `--check`, where it will pass, which proves
 * nothing about whether it can fail. Everything below is synthetic for that reason: it is the same
 * discipline as `check-licenses.mjs --self-test` and `check-security-headers.mjs --self-test`.
 *
 * Hermetic: no child processes, no dependency tree, no network.
 */

/** A document that satisfies every rule, so each case below can break exactly one thing. */
function goodDocument(overrides = {}) {
  const components = [
    ...Array.from({ length: FLOORS.npm }, (_, i) => ({
      ecosystem: "npm",
      name: `pkg-${i}`,
      version: "1.0.0",
      license: "MIT",
    })),
    ...Array.from({ length: FLOORS.cargo }, (_, i) => ({
      ecosystem: "cargo",
      name: `crate-${i}`,
      version: "0.1.0",
      license: "Apache-2.0",
    })),
  ];
  return {
    ...buildDocument({ candidateSha: "0".repeat(40), created: "2026-08-15T00:00:00.000Z", components }),
    ...overrides,
  };
}

test("the reference document passes", () => {
  // Without this, every rejection below could be produced by a validator that rejects everything.
  assert.deepEqual(documentProblems(goodDocument()), []);
});

test("REJECTS an SBOM with no packages", () => {
  // THE case. `release-manifest.mjs` checks the SPDX header and never looks inside, and
  // `release-manifest.test.mjs` builds its fixture with `packages: []` — so the suite that proves
  // the evidence chain works has only ever been shown an SBOM that inventories nothing.
  const problems = documentProblems(goodDocument({ packages: [] }));
  assert.match(problems.join(), /packages is empty/);
});

test("REJECTS an SBOM that inventories only one ecosystem", () => {
  // The Rust tree shipped ungated past the licence gate for exactly this reason once already: a JS
  // enumerator that works makes the output look healthy while the other tree is absent entirely.
  const jsOnly = buildDocument({
    candidateSha: "0".repeat(40),
    created: "2026-08-15T00:00:00.000Z",
    components: Array.from({ length: FLOORS.npm }, (_, i) => ({
      ecosystem: "npm",
      name: `pkg-${i}`,
      version: "1.0.0",
      license: "MIT",
    })),
  });
  assert.match(documentProblems(jsOnly).join(), /0 cargo packages, floor is/);
});

test("REJECTS a nearly-empty inventory, not merely an empty one", () => {
  // `pnpm licenses` run before `pnpm install` returns a handful of packages rather than none, so a
  // non-empty check alone would call that a success.
  const thin = buildDocument({
    candidateSha: "0".repeat(40),
    created: "2026-08-15T00:00:00.000Z",
    components: [
      { ecosystem: "npm", name: "only-one", version: "1.0.0", license: "MIT" },
      { ecosystem: "cargo", name: "only-crate", version: "0.1.0", license: "MIT" },
    ],
  });
  const problems = documentProblems(thin).join();
  assert.match(problems, /1 npm packages, floor is 50/);
  assert.match(problems, /1 cargo packages, floor is 100/);
});

test("REJECTS a package with no version", () => {
  const document = goodDocument();
  delete document.packages[0].versionInfo;
  // A component that cannot be matched against an advisory is most of an SBOM's purpose gone.
  assert.match(documentProblems(document).join(), /has no versionInfo/);
});

test("REJECTS duplicate SPDXIDs", () => {
  const document = goodDocument();
  document.packages[1].SPDXID = document.packages[0].SPDXID;
  // Every relationship in the document becomes ambiguous, and a deduplicating consumer drops one
  // of the two from the inventory without saying so.
  assert.match(documentProblems(document).join(), /duplicate SPDXID/);
});

test("REJECTS a package with no purl", () => {
  const document = goodDocument();
  // By SPDXID, so this picks an npm package rather than whichever entry sorting put first.
  const npmPackage = document.packages.find((pkg) => pkg.SPDXID.startsWith("SPDXRef-npm-"));
  npmPackage.externalRefs = [];
  const problems = documentProblems(document).join();
  assert.match(problems, /has no purl external reference/);
  // And it stops counting toward its ecosystem's floor, rather than being counted as present.
  assert.match(problems, /49 npm packages/);
});

test("REJECTS a header that is missing a required field", () => {
  for (const field of ["SPDXID", "name", "documentNamespace", "dataLicense"]) {
    const document = goodDocument();
    delete document[field];
    assert.match(documentProblems(document).join(), new RegExp(`${field} is missing`));
  }
});

test("REJECTS a creation date that is not a date", () => {
  const document = goodDocument();
  document.creationInfo.created = "release day";
  assert.match(documentProblems(document).join(), /creationInfo.created is not a date/);
});

test("REFUSES to build a document from a component with no version", () => {
  // Caught at construction rather than validation: the generator must not be able to emit a
  // degraded document that the validator then has to notice.
  assert.throws(
    () => toSpdxPackages([{ ecosystem: "npm", name: "nameless", version: "", license: "MIT" }]),
    /no name or version/,
  );
});

test("a scoped npm name survives into the purl", () => {
  // `@scope/pkg` carries structural `@` and `/`. Naively encoding the whole name produces
  // `pkg:npm/%40scope%2Fpkg`, which no advisory database resolves.
  assert.equal(purl("npm", "@asamuzakjp/css-color", "5.1.11"), "pkg:npm/%40asamuzakjp/css-color@5.1.11");
  assert.equal(purl("npm", "vitest", "4.1.10"), "pkg:npm/vitest@4.1.10");
  assert.equal(purl("cargo", "icu_locale_core", "2.0.0"), "pkg:cargo/icu_locale_core@2.0.0");
});

test("an SPDXID contains only characters SPDX permits", () => {
  // A scoped name would otherwise put `@` and `/` into an element id, which SPDX forbids and which
  // makes the document unparseable by conforming tools rather than merely ugly.
  const id = spdxId("npm", "@scope/pkg", "1.0.0");
  assert.match(id, /^SPDXRef-[A-Za-z0-9.-]+$/);
});

test("the document names the candidate it describes", () => {
  // An SBOM from another commit is otherwise a plausible substitute for this one. The namespace is
  // what makes the swap visible to a challenger holding the manifest.
  const document = goodDocument();
  assert.match(document.documentNamespace, /0{40}$/);
  assert.equal(document.name, `qrai-${"0".repeat(40)}`);
});

test("the same tree produces the same packages twice", () => {
  // Sorted output, so the only difference between two runs is the timestamp. A reviewer diffing
  // two bundles should see dependency changes, not ordering noise.
  const components = [
    { ecosystem: "cargo", name: "b", version: "1.0.0", license: "MIT" },
    { ecosystem: "npm", name: "a", version: "1.0.0", license: "MIT" },
  ];
  assert.deepEqual(toSpdxPackages(components), toSpdxPackages([...components].reverse()));
});
