import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// The bundle to scan. Defaults to the real production output; an explicit path exists so the guard
// itself can be tested. Until now nothing tested it: it ran in `verify.sh` on every gate, always
// passed, and no case anywhere demonstrated that it can detect anything. The directory could not be
// faked either, because AGENTS.md forbids writing under any `dist/` path — so a fixture bundle was
// impossible to build and the guard was, in practice, unfalsifiable.
const distDir = process.argv[2] ? resolve(process.argv[2]) : join(process.cwd(), "apps", "web", "dist");
const forbidden = [
  { label: "dev auto-login password", pattern: /dev-bypass-[A-Za-z0-9_-]+/i },
  { label: "dev auto-login email/domain", pattern: /bypass\.local/i },
  { label: "default JWT secret", pattern: /quran-ai-dev-secret/i },
  { label: "default realtime ticket secret", pattern: /smoke-secret/i },
];

const files = await walk(distDir);
const findings = [];

for (const file of files) {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) continue;
  for (const item of forbidden) {
    if (item.pattern.test(text)) {
      findings.push({ file, label: item.label });
    }
  }
}

// A scan that examined nothing is not a clean bill of health.
//
// `walk` only collects .css/.html/.js/.json/.map/.svg/.txt, so a dist directory that exists but is
// empty — a cleaned tree, or a build that failed after creating the folder — yielded zero files and
// printed "web bundle secret scan passed (0 files)" with exit 0. The gate then reported a secret
// scan it never performed. A missing directory already fails loudly (readdir rejects); an empty one
// must too.
if (files.length === 0) {
  console.error(`web bundle secret scan found no scannable files in ${distDir}`);
  console.error("  build the web bundle first — a scan of nothing is not a pass");
  process.exit(1);
}

if (findings.length > 0) {
  console.error("web bundle secret scan failed:");
  for (const finding of findings) {
    console.error(`  ${finding.label}: ${finding.file}`);
  }
  process.exit(1);
}

console.log(`web bundle secret scan passed (${files.length} files)`);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walk(fullPath));
    } else if (/\.(css|html|js|json|map|svg|txt)$/i.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}
