import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const distDir = join(process.cwd(), "apps", "web", "dist");
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
