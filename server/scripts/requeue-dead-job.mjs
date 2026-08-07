import { fileURLToPath } from "node:url";

import { createJobStore } from "../src/jobs/store.mjs";
import { createDb } from "../src/lib/db.mjs";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--tenant-id", "--job-id", "--operator-id"].includes(flag) || !value) {
      throw new TypeError(
        "usage: requeue-dead-job --tenant-id <id> --job-id <id> --operator-id <admin-or-ops-id>",
      );
    }
    if (values.has(flag)) throw new TypeError(`duplicate argument ${flag}`);
    values.set(flag, value);
  }
  for (const flag of ["--tenant-id", "--job-id", "--operator-id"]) {
    if (!values.has(flag)) throw new TypeError(`missing required argument ${flag}`);
  }
  return Object.freeze({
    tenantId: values.get("--tenant-id"),
    jobId: values.get("--job-id"),
    operatorId: values.get("--operator-id"),
  });
}

export async function requeueDeadJob({ databaseUrl, tenantId, jobId, operatorId }) {
  const db = createDb(databaseUrl, { max: 2 });
  try {
    await db.assertRestrictedRole();
    return await createJobStore({ db }).requeueDead({ tenantId, jobId, operatorId });
  } finally {
    await db.end();
  }
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const replay = await requeueDeadJob({ databaseUrl: process.env.DATABASE_URL, ...input });
  process.stdout.write(`${JSON.stringify({
    jobId: replay.id,
    sourceJobId: input.jobId,
    status: replay.status,
  })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("dead-job replay failed\n");
    process.exitCode = 1;
  });
}
