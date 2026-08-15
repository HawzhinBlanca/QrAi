const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export const CANARY_LOAD_PROFILES = Object.freeze({
  classroom: Object.freeze({
    executor: "constant-arrival-rate",
    rate: 10,
    timeUnit: "1s",
    duration: "5m",
    preAllocatedVUs: 10,
    maxVUs: 30,
  }),
  burst: Object.freeze({
    executor: "ramping-arrival-rate",
    startRate: 5,
    timeUnit: "1s",
    preAllocatedVUs: 20,
    maxVUs: 80,
    stages: Object.freeze([
      Object.freeze({ target: 50, duration: "30s" }),
      Object.freeze({ target: 50, duration: "60s" }),
      Object.freeze({ target: 0, duration: "30s" }),
    ]),
  }),
  soak: Object.freeze({
    executor: "constant-arrival-rate",
    rate: 5,
    timeUnit: "1s",
    duration: "30m",
    preAllocatedVUs: 10,
    maxVUs: 30,
  }),
});

export const CANARY_LOAD_THRESHOLDS = Object.freeze({
  http_req_duration: "p(95)<1000",
  errors: "rate<0.01",
  checks: "rate>0.99",
  dropped_iterations: "count==0",
});

const profileMinimums = Object.freeze({
  classroom: Object.freeze({ milliseconds: 5 * 60 * 1_000, label: "5m", requests: 3000 }),
  burst: Object.freeze({ milliseconds: 2 * 60 * 1_000, label: "2m", requests: 4500 }),
  soak: Object.freeze({ milliseconds: 30 * 60 * 1_000, label: "30m", requests: 9000 }),
});

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new TypeError(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function iso(value, label) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be normalized ISO-8601`);
  }
  return Date.parse(value);
}

function digest(value, label) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new TypeError(`${label} must be an immutable sha256 identity`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createCanaryLoadEvidence(value) {
  assertObject(value, "canary load evidence input");
  assertExactKeys(
    value,
    [
      "sourceSha",
      "nodeImageId",
      "topologySha256",
      "profile",
      "startedAt",
      "completedAt",
      "metrics",
      "thresholds",
    ],
    "canary load evidence input",
  );
  if (typeof value.sourceSha !== "string" || !shaPattern.test(value.sourceSha)) {
    throw new TypeError("sourceSha must be a full lower-case git SHA");
  }
  digest(value.nodeImageId, "nodeImageId");
  digest(value.topologySha256, "topologySha256");
  if (!(value.profile in CANARY_LOAD_PROFILES)) throw new TypeError("profile is unsupported");
  const startedAt = iso(value.startedAt, "startedAt");
  const completedAt = iso(value.completedAt, "completedAt");
  if (completedAt <= startedAt) throw new TypeError("load evidence must have positive duration");
  const minimum = profileMinimums[value.profile];
  if (completedAt - startedAt < minimum.milliseconds) {
    throw new TypeError(
      `${value.profile} load evidence must span at least its ${minimum.label} policy duration`,
    );
  }

  assertObject(value.metrics, "load metrics");
  assertExactKeys(
    value.metrics,
    ["httpP95Ms", "errorRate", "checksRate", "totalRequests", "droppedIterations"],
    "load metrics",
  );
  for (const key of [
    "httpP95Ms",
    "errorRate",
    "checksRate",
    "totalRequests",
    "droppedIterations",
  ]) {
    if (
      typeof value.metrics[key] !== "number" ||
      !Number.isFinite(value.metrics[key]) ||
      value.metrics[key] < 0
    ) {
      throw new TypeError(`metrics.${key} must be a finite non-negative number`);
    }
  }
  if (value.metrics.errorRate > 1 || value.metrics.checksRate > 1) {
    throw new TypeError("load metric rates must not exceed 1");
  }
  if (!Number.isSafeInteger(value.metrics.totalRequests) || value.metrics.totalRequests < 1) {
    throw new TypeError("metrics.totalRequests must be a positive whole number");
  }
  if (!Number.isSafeInteger(value.metrics.droppedIterations)) {
    throw new TypeError("metrics.droppedIterations must be a whole number");
  }
  if (value.metrics.totalRequests < minimum.requests) {
    throw new TypeError(
      `${value.profile} load evidence must contain at least ${minimum.requests} requests`,
    );
  }

  assertObject(value.thresholds, "load thresholds");
  assertExactKeys(value.thresholds, Object.keys(CANARY_LOAD_THRESHOLDS), "load thresholds");
  for (const [key, passed] of Object.entries(value.thresholds)) {
    if (typeof passed !== "boolean") throw new TypeError(`thresholds.${key} must be boolean`);
  }
  const measuredThresholds = {
    http_req_duration: value.metrics.httpP95Ms < 1000,
    errors: value.metrics.errorRate < 0.01,
    checks: value.metrics.checksRate > 0.99,
    dropped_iterations: value.metrics.droppedIterations === 0,
  };
  if (canonicalJson(value.thresholds) !== canonicalJson(measuredThresholds)) {
    throw new TypeError("thresholds must exactly match the measured metrics");
  }
  const status = Object.values(measuredThresholds).every(Boolean) ? "passed" : "failed";
  return {
    schemaVersion: "qrai-canary-load-evidence/v1",
    status,
    sourceSha: value.sourceSha,
    nodeImageId: value.nodeImageId,
    topologySha256: value.topologySha256,
    profile: value.profile,
    policy: {
      scenario: CANARY_LOAD_PROFILES[value.profile],
      thresholds: CANARY_LOAD_THRESHOLDS,
    },
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    metrics: { ...value.metrics },
    thresholds: { ...value.thresholds },
  };
}

export function assertCanaryLoadEvidenceForPromotion(value) {
  assertObject(value, "canary load evidence");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "status",
      "sourceSha",
      "nodeImageId",
      "topologySha256",
      "profile",
      "policy",
      "startedAt",
      "completedAt",
      "metrics",
      "thresholds",
    ],
    "canary load evidence",
  );
  if (value.schemaVersion !== "qrai-canary-load-evidence/v1") {
    throw new TypeError("canary load evidence schemaVersion is unsupported");
  }
  const reconstructed = createCanaryLoadEvidence({
    sourceSha: value.sourceSha,
    nodeImageId: value.nodeImageId,
    topologySha256: value.topologySha256,
    profile: value.profile,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    metrics: value.metrics,
    thresholds: value.thresholds,
  });
  if (reconstructed.status !== value.status) {
    throw new TypeError("canary load evidence status does not match its thresholds");
  }
  if (canonicalJson(reconstructed) !== canonicalJson(value)) {
    throw new TypeError("canary load evidence policy or identity was altered");
  }
  if (value.status !== "passed") throw new TypeError("failed load evidence cannot authorize promotion");
  return reconstructed;
}

export function assertCanaryLoadEvidenceSetForPromotion(
  value,
  expectedIdentity,
  { validatedAt },
) {
  assertObject(value, "canary load evidence set");
  const profiles = Object.keys(CANARY_LOAD_PROFILES);
  assertExactKeys(value, profiles, "canary load evidence set");
  assertObject(expectedIdentity, "expected candidate load identity");
  assertExactKeys(
    expectedIdentity,
    ["sourceSha", "nodeImageId", "topologySha256"],
    "expected candidate load identity",
  );
  const validationTime = iso(validatedAt, "load evidence validatedAt");
  const accepted = {};
  for (const profile of profiles) {
    const evidence = assertCanaryLoadEvidenceForPromotion(value[profile]);
    if (evidence.profile !== profile) {
      throw new TypeError(`load evidence key ${profile} must contain the ${profile} profile`);
    }
    const completionTime = Date.parse(evidence.completedAt);
    if (
      completionTime > validationTime ||
      validationTime - completionTime > 24 * 60 * 60 * 1_000
    ) {
      throw new TypeError(`load evidence ${profile} is expired or from the future`);
    }
    for (const key of ["sourceSha", "nodeImageId", "topologySha256"]) {
      if (evidence[key] !== expectedIdentity[key]) {
        throw new TypeError(`load evidence ${profile}.${key} must match the candidate identity`);
      }
    }
    accepted[profile] = evidence;
  }
  return accepted;
}
