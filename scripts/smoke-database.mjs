import { existsSync } from "node:fs";

export function databaseConnectionArgs(databaseUrl) {
  if (databaseUrl === undefined) {
    return ["-U", "hawzhin", "-d", "quran_ai"];
  }
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL must not be empty when supplied.");
  }
  return ["--dbname", databaseUrl];
}

/**
 * Database reset/seed and RLS proof require an administrative role, while the
 * platform service must retain its restricted application role. Keep that
 * separation explicit instead of broadening the application role's grants.
 */
export function smokeAdminDatabaseUrl(environment = process.env) {
  return environment.SMOKE_DATABASE_ADMIN_URL ?? environment.DATABASE_URL;
}

/**
 * Resolve the PostgreSQL client once for the aggregate smoke runner. Local
 * Homebrew installations are common on developer workstations but their
 * versioned bin directories are not always inherited by package scripts.
 */
export function resolvePsqlCommand(environment = process.env, fileExists = existsSync) {
  if (environment.PSQL) {
    const executable = environment.PSQL.split(" ")[0];
    if (!executable.includes("/") || fileExists(executable)) {
      return environment.PSQL;
    }
  }

  const candidates = [
    "/opt/homebrew/opt/postgresql@16/bin/psql",
    "/opt/homebrew/bin/psql",
    "/usr/local/bin/psql",
    "psql",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (fileExists(candidate)) return candidate;
      continue;
    }
    return candidate;
  }

  return "psql";
}
