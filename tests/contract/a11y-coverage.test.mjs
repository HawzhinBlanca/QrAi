import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every web component must have an accessibility audit, and the pairing is by IMPORT, not filename.
 *
 * P6.2 asks for accessibility automation. `axe-core` has been a devDependency of apps/web since the
 * P2.5 work, and two `.a11y.test.tsx` files exist — so the row looked partly served. Measured:
 * **23 components, 3 audited** (LearnerHome, ConsentPanel, PrivacySettings). Twenty had never been
 * scanned by anything.
 *
 * Why nothing caught it: there was no second list. Each a11y test was written for the component
 * someone happened to be touching, and no gate compared the audited set against the shipped set.
 *
 * The filename trap this guard exists to avoid: `PrivacyConsent.a11y.test.tsx` audits two components
 * and **there is no `PrivacyConsent.tsx`**. A guard that paired audits to components by filename
 * would have called that file's coverage "PrivacyConsent" — a component that does not exist — while
 * reporting ConsentPanel and PrivacySettings as unaudited, and would have missed nothing about the
 * real gap only by luck. Pair by what the audit actually imports.
 *
 * This runs in Node, not vitest, deliberately: it is a static scan, so it costs nothing and runs on
 * every gate rather than only where the web toolchain is installed.
 *
 * Hermetic: reads source files, starts nothing.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const componentsDir = join(root, "apps/web/src/components");

/** Component modules that ship — every `*.tsx` in components/ that is not itself a test. */
function shippedComponents() {
  return readdirSync(componentsDir)
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
    .map((f) => f.replace(/\.tsx$/, ""))
    .sort();
}

/** Accessibility audit files. */
function auditFiles() {
  return readdirSync(componentsDir).filter((f) => f.endsWith(".a11y.test.tsx"));
}

/**
 * The component modules an audit file imports from its own directory.
 * `import { ConsentPanel } from "./ConsentPanel";` -> "ConsentPanel".
 */
function auditedBy(file) {
  const src = readFileSync(join(componentsDir, file), "utf8");
  const modules = new Set();
  for (const m of src.matchAll(/^\s*import\s+[^;]*?from\s+"\.\/([A-Za-z0-9_]+)"/gm)) {
    modules.add(m[1]);
  }
  return modules;
}

/** Component -> the audit files that render it. */
function coverage() {
  const covered = new Map();
  for (const file of auditFiles()) {
    for (const component of auditedBy(file)) {
      if (!covered.has(component)) covered.set(component, []);
      covered.get(component).push(file);
    }
  }
  return covered;
}

test("this guard is measuring a real component tree", () => {
  // Without this, a moved directory or a changed extension would make every assertion below pass
  // over an empty set and report perfect accessibility coverage of nothing.
  const components = shippedComponents();
  assert.ok(
    components.length >= 20,
    `only ${components.length} components found in apps/web/src/components — did the tree move?`,
  );
  assert.ok(auditFiles().length > 0, "no *.a11y.test.tsx files at all — has the audit convention changed?");
});

test("every audit file imports a component that exists", () => {
  // The PrivacyConsent trap in reverse: an audit naming a component that has been deleted or renamed
  // is dead weight that still counts as coverage.
  const shipped = new Set(shippedComponents());
  const dangling = [];
  for (const file of auditFiles()) {
    const imported = [...auditedBy(file)].filter((c) => shipped.has(c));
    if (imported.length === 0) {
      dangling.push(`${file} — imports no component from ./ that still exists`);
    }
  }
  assert.deepEqual(dangling, [], `accessibility audits that audit nothing:\n  ${dangling.join("\n  ")}`);
});

test("every shipped component has an accessibility audit", () => {
  const covered = coverage();
  const unaudited = shippedComponents().filter((c) => !covered.has(c));
  assert.deepEqual(
    unaudited,
    [],
    `these components ship to learners and teachers with no axe audit:\n  ` +
      `${unaudited.join("\n  ")}\n` +
      `Add <Component>.a11y.test.tsx next to it, or extend an existing audit to render it. ` +
      `An audit counts only if it imports the component from "./<Component>".`,
  );
});
