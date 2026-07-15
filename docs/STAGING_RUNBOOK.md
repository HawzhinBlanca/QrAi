# Runbook: Staging Environment Management

This document describes how to deploy, manage, and recreate the staging environment for the **Quran Recitation Intelligence OS** (`quran-ai-platform`).

## Objectives
* Prove production-like environment readiness (e.g. running non-root, enforcing TLS/HSTS, using restricted database role).
* Ensure environment disposability (destroy/recreate from zero succeeds).
* Restrict security boundaries (zero default/committed credentials, no `ALLOW_INSECURE_DEFAULTS` enabled).

---

## 1. Automated Lifecycle Management

The script [recreate-staging.sh](file:///Users/hawzhin/QrAi/scripts/recreate-staging.sh) implements the complete staging lifecycle:
1. Shuts down and purges any existing staging container stack and named volumes.
2. Removes old env settings.
3. Invokes the secure key generator to write new random secrets to a gitignored `.env.staging` file.
4. Builds/pulls container images.
5. Starts the isolated `quran-ai-staging` Compose stack.
6. Polls health checkpoints for the Platform API, Realtime Gateway, and Web Server.

### Execution
Run the lifecycle manager from the repository root:
```bash
bash scripts/recreate-staging.sh
```

---

## 2. Manual Commands Reference

### Destroying Staging
To cleanly dismantle the staging environment and discard all temporary volumes (like DB state and user recordings):
```bash
docker compose -p quran-ai-staging --env-file .env.staging down -v --remove-orphans
```

### Checking Status & Logs
```bash
# List containers and health status
docker compose -p quran-ai-staging --env-file .env.staging ps

# Follow logs from platform api
docker compose -p quran-ai-staging --env-file .env.staging logs -f platform-api
```

### Rotating Secrets
Secrets must never be reused across stages or deployments. To rotate all staging keys:
1. Shut down the current deployment:
   ```bash
   docker compose -p quran-ai-staging --env-file .env.staging down
   ```
2. Remove the old environment file:
   ```bash
   rm -f .env.staging
   ```
3. Run the recreation script again to generate new secure keys and restart the containers:
   ```bash
   bash scripts/recreate-staging.sh
   ```
