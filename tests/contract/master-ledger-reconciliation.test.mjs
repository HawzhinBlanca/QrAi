import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MASTER_TASKS = join(root, "specs/number-one-kurdish-quran-ai/tasks.md");
const RECONCILIATION_DOC = join(
  root,
  "specs/number-one-kurdish-quran-ai/ledger-reconciliation.md",
);

/** Extract task definitions from tasks.md */
export function extractMasterTasks(source) {
  const tasks = new Map();
  for (const line of source.split("\n")) {
    const m = line.match(/^-\s*\[([ xX])\]\s*\*\*([A-Za-z0-9_.-]+)\*\*\s*(.*)$/);
    if (m) {
      tasks.set(m[2], {
        id: m[2],
        done: m[1].toLowerCase() === "x",
        description: m[3],
      });
    }
  }
  return tasks;
}

/** Parse markdown tables from ledger-reconciliation.md */
export function parseReconciliationTables(source) {
  const rows = [];
  const lines = source.split("\n");
  let inTable = false;
  let currentSection = "";

  for (const line of lines) {
    if (line.startsWith("## ")) {
      currentSection = line.replace("## ", "").trim();
      inTable = false;
      continue;
    }
    if (line.startsWith("| Source row | Master closure |")) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (!line.startsWith("|")) {
        inTable = false;
        continue;
      }
      if (line.includes("|---|")) continue;
      const parts = line
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length >= 3) {
        rows.push({
          sourceRow: parts[0],
          masterClosure: parts[1],
          disposition: parts[2],
          section: currentSection,
        });
      }
    }
  }
  return rows;
}

/** The 76 exact active source IDs */
export const CONSOLIDATION_SOURCE_IDS = [
  "W1.5",
  "W1.11",
  "W2.18",
  "W3.8",
  "W3.9",
  "W4.1",
  "W4.2",
  "W4.3",
  "W4.4",
  "W4.5",
  "W4.6",
  "W4.7",
  "W4.8",
  "W4.9",
  "W4.10",
  "W4.11",
  "W4.12",
  "W4.13",
  "W4.14",
  "W4.15",
  "W5.1",
  "W5.2",
  "W5.3",
  "W5.4",
  "W6.1",
  "W6.2",
  "W6.3",
  "W6.4",
  "W6.5",
  "W6.6",
  "W6.7",
  "W7.1",
  "W7.2",
  "W7.3",
  "W7.4",
  "W7.5",
  "W7.6",
  "W7.7",
  "W7.8",
  "W7.9",
];

export const READINESS_SOURCE_IDS = [
  "P0.1",
  "P0.2",
  "P0.4",
  "P0.7",
  "P1.7",
  "P2.2",
  "P2.3",
  "P2.4",
  "P3.2",
  "P3.4",
  "P3.5",
  "P3.6",
  "P4.1",
  "P4.4",
  "P4.5",
  "P4.6",
  "P5.1",
  "P5.4",
  "P5.5",
  "P5.6",
  "P5.7",
  "P6.2",
  "P6.3",
  "P6.4",
  "P6.5",
  "P7.1",
  "P7.2",
  "P7.3",
  "P7.4",
  "P7.5",
  "P7.6",
];

export const DR_SOURCE_IDS = ["DR T2", "DR T4", "DR T5"];

export const MIGRATION_SOURCE_IDS = ["migration N12b", "migration FL9"];

export const ALL_76_SOURCE_IDS = [
  ...CONSOLIDATION_SOURCE_IDS,
  ...READINESS_SOURCE_IDS,
  ...DR_SOURCE_IDS,
  ...MIGRATION_SOURCE_IDS,
];

export function validateReconciliation(reconciliationSrc, masterTasksSrc) {
  const masterTasks = extractMasterTasks(masterTasksSrc);
  const rows = parseReconciliationTables(reconciliationSrc);

  const mappedSourceIds = rows.map((r) => r.sourceRow);
  const seen = new Set();
  const duplicates = [];
  for (const id of mappedSourceIds) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }

  const missing = ALL_76_SOURCE_IDS.filter((id) => !seen.has(id));
  const unknown = mappedSourceIds.filter(
    (id) => !ALL_76_SOURCE_IDS.includes(id),
  );
  const invalidMasterRefs = rows
    .filter((r) => !masterTasks.has(r.masterClosure))
    .map((r) => `${r.sourceRow} -> ${r.masterClosure}`);

  return {
    totalMapped: rows.length,
    missing,
    duplicates,
    unknown,
    invalidMasterRefs,
    isValid:
      rows.length === 76 &&
      missing.length === 0 &&
      duplicates.length === 0 &&
      unknown.length === 0 &&
      invalidMasterRefs.length === 0,
  };
}

test("master ledger reconciliation maps exactly all 76 active source IDs", () => {
  const recSrc = readFileSync(RECONCILIATION_DOC, "utf8");
  const taskSrc = readFileSync(MASTER_TASKS, "utf8");

  const result = validateReconciliation(recSrc, taskSrc);
  assert.equal(result.totalMapped, 76, `Expected 76 source rows, got ${result.totalMapped}`);
  assert.deepEqual(result.missing, [], `Missing active source IDs: ${result.missing.join(", ")}`);
  assert.deepEqual(result.duplicates, [], `Duplicate source mappings: ${result.duplicates.join(", ")}`);
  assert.deepEqual(result.unknown, [], `Unknown source IDs: ${result.unknown.join(", ")}`);
  assert.deepEqual(result.invalidMasterRefs, [], `Invalid master task references: ${result.invalidMasterRefs.join(", ")}`);
  assert.ok(result.isValid, "Reconciliation validation must pass");
});

test("consolidation section contains exactly 40 active source IDs", () => {
  const recSrc = readFileSync(RECONCILIATION_DOC, "utf8");
  const rows = parseReconciliationTables(recSrc).filter((r) =>
    r.section.toLowerCase().includes("consolidation"),
  );
  assert.equal(rows.length, 40, `Expected 40 consolidation rows, got ${rows.length}`);
  for (const expected of CONSOLIDATION_SOURCE_IDS) {
    assert.ok(
      rows.some((r) => r.sourceRow === expected),
      `Consolidation section missing ${expected}`,
    );
  }
});

test("readiness section contains exactly 31 active source IDs", () => {
  const recSrc = readFileSync(RECONCILIATION_DOC, "utf8");
  const rows = parseReconciliationTables(recSrc).filter((r) =>
    r.section.toLowerCase().includes("readiness"),
  );
  assert.equal(rows.length, 31, `Expected 31 readiness rows, got ${rows.length}`);
  for (const expected of READINESS_SOURCE_IDS) {
    assert.ok(
      rows.some((r) => r.sourceRow === expected),
      `Readiness section missing ${expected}`,
    );
  }
});

test("DR and migration sections contain exactly 5 active source IDs", () => {
  const recSrc = readFileSync(RECONCILIATION_DOC, "utf8");
  const rows = parseReconciliationTables(recSrc).filter(
    (r) =>
      r.section.toLowerCase().includes("dr") ||
      r.section.toLowerCase().includes("migration"),
  );
  assert.equal(rows.length, 5, `Expected 5 DR/migration rows, got ${rows.length}`);
  for (const expected of [...DR_SOURCE_IDS, ...MIGRATION_SOURCE_IDS]) {
    assert.ok(
      rows.some((r) => r.sourceRow === expected),
      `DR/migration section missing ${expected}`,
    );
  }
});

test("closed-on-live-main rows are documented as regression obligations", () => {
  const recSrc = readFileSync(RECONCILIATION_DOC, "utf8");
  assert.match(recSrc, /P2\.6 actionable degraded states/);
  assert.match(recSrc, /P5\.3 deterministic faults\/observability/);
  assert.match(recSrc, /P6\.1 critical-journey E2E definition/);
  assert.match(recSrc, /Q10-048 regression suite/);
  assert.match(recSrc, /Q10-060\/Q10-061 regression suites/);
  assert.match(recSrc, /Q10-041\/Q10-046\/Q10-047\/Q10-048 journeys/);
});

test("historical and superseded checklists are excluded from completion authority", () => {
  const recSrc = readFileSync(RECONCILIATION_DOC, "utf8");
  assert.match(
    recSrc,
    /docs\/superpowers\/plans\/2026-06-25-full-platform-ship-ready\.md/,
  );
  assert.match(recSrc, /docs\/10-10-true-implementation-plan\.md/);
  assert.match(recSrc, /docs\/proof\/10-10-proof-checklist\.md/);
  assert.match(recSrc, /specs\/cutover\/research\.md/);
  assert.match(recSrc, /specs\/number-one-release\/tasks\.md/);
});

test("adversarial fixture: missing source ID fails validation", () => {
  const taskSrc = readFileSync(MASTER_TASKS, "utf8");
  const brokenRec = readFileSync(RECONCILIATION_DOC, "utf8").replace(
    "| W1.5 | Q10-024 |",
    "| W1.5-OMITTED | Q10-024 |",
  );
  const result = validateReconciliation(brokenRec, taskSrc);
  assert.equal(result.isValid, false);
  assert.ok(result.missing.includes("W1.5"));
});

test("adversarial fixture: duplicate source ID mapping fails validation", () => {
  const taskSrc = readFileSync(MASTER_TASKS, "utf8");
  const brokenRec = readFileSync(RECONCILIATION_DOC, "utf8").replace(
    "| W1.11 | Q10-025 |",
    "| W1.5 | Q10-025 |",
  );
  const result = validateReconciliation(brokenRec, taskSrc);
  assert.equal(result.isValid, false);
  assert.ok(result.duplicates.includes("W1.5"));
});

test("adversarial fixture: stale/non-existent master task fails validation", () => {
  const taskSrc = readFileSync(MASTER_TASKS, "utf8");
  const brokenRec = readFileSync(RECONCILIATION_DOC, "utf8").replace(
    "| W1.5 | Q10-024 |",
    "| W1.5 | Q10-NONEXISTENT |",
  );
  const result = validateReconciliation(brokenRec, taskSrc);
  assert.equal(result.isValid, false);
  assert.ok(
    result.invalidMasterRefs.some((ref) => ref.includes("Q10-NONEXISTENT")),
  );
});
