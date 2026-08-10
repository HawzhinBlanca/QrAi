import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { composeImageEnvironment, assertReleaseDeploymentSelection } from "./release-deployment.mjs";

const DAY_MS = 24 * 60 * 60 * 1_000;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const containerIdPattern = /^[a-f0-9]{12,64}$/;
const projectNamePattern = /^[a-z0-9][a-z0-9_-]*$/;
const failureCodes = new Set([
  "cleanup-failed",
  "command-failed",
  "dependency-unavailable",
  "threshold-failed",
  "timeout",
]);

export const REQUIRED_REALTIME_IMAGE_STAGES = Object.freeze([
  "candidate-running-images",
  "protocol-parity",
  "hostile-capacity",
  "retention",
  "fault-recovery",
  "classroom-burst",
  "soak",
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const REALTIME_IMAGE_THRESHOLDS = deepFreeze({
  capacity: {
    sessions: 100,
    refusedSession: 101,
    ackP95MsExclusive: 250,
  },
  classroom: {
    sessions: 25,
    durationSeconds: 300,
    frameIntervalMs: 480,
    accountedFrames: 15_625,
    ackP95MsExclusive: 250,
  },
  burst: {
    sessions: 100,
    framesPerSession: 50,
    accountedFrames: 5_000,
    backpressureRequired: true,
  },
  soak: {
    sessions: 10,
    durationSeconds: 1_800,
    frameIntervalMs: 480,
    accountedFrames: 37_500,
    ackP95MsExclusive: 250,
    ackP99MsExclusive: 500,
    peakRssBytesExclusive: 512 * 1024 * 1024,
    rssGrowthBytesMax: 96 * 1024 * 1024,
    rssSlopeBytesPerMinuteMax: 1024 * 1024,
  },
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

function parseIso(value, label) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be normalized ISO-8601`);
  }
  return Date.parse(value);
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
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

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stageCommand(stageName) {
  return ["node", "scripts/realtime-image-proof.mjs", "probe", "--stage", stageName];
}

function assertStageCommand(command, commandSha256, stageName) {
  if (!Array.isArray(command) || !isDeepStrictEqual(command, stageCommand(stageName))) {
    throw new TypeError(`${stageName} must record its exact safe proof command`);
  }
  assertDigest(commandSha256, `${stageName}.commandSha256`);
  if (commandSha256 !== sha256(canonicalJson(command))) {
    throw new TypeError(`${stageName}.commandSha256 must equal the exact recorded command sha256`);
  }
  return [...command];
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertNonnegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
}

function assertClosedAccounting(measurements, sentKey, label) {
  for (const key of [sentKey, "accepted", "rejected", "lost", "uncertain"]) {
    assertNonnegativeInteger(measurements[key], `${label}.${key}`);
  }
  if (
    measurements[sentKey] !==
    measurements.accepted + measurements.rejected + measurements.lost + measurements.uncertain
  ) {
    throw new TypeError(`${label} frame accounting must close exactly`);
  }
}

function assertFinalGauges(measurements, label) {
  for (const key of ["activeSessionsFinal", "retainedChunksFinal", "retainedBytesFinal"]) {
    assertNonnegativeInteger(measurements[key], `${label}.${key}`);
    if (measurements[key] !== 0) throw new TypeError(`${label} final gauges must all return to zero`);
  }
}

function assertCandidateMeasurements(value) {
  assertObject(value, "candidate-running-images measurements");
  assertExactKeys(
    value,
    [
      "cleanSource",
      "selectionMatched",
      "runningImagesMatched",
      "nonRootContainers",
      "sharedNodeImage",
      "topologyMatched",
      "productionStorageReady",
    ],
    "candidate-running-images measurements",
  );
  for (const key of [
    "cleanSource",
    "selectionMatched",
    "sharedNodeImage",
    "topologyMatched",
    "productionStorageReady",
  ]) {
    if (value[key] !== true) throw new TypeError(`candidate-running-images ${key} must be true`);
  }
  if (value.runningImagesMatched !== 4 || value.nonRootContainers !== 4) {
    throw new TypeError("candidate-running-images must match all four non-root containers");
  }
}

function assertProtocolMeasurements(value) {
  assertObject(value, "protocol-parity measurements");
  assertExactKeys(
    value,
    [
      "validCases",
      "matchedCases",
      "unexpectedDivergences",
      "nodeInvalidFrameDivergences",
      "ackFieldCount",
      "originRefusals",
      "replayRefusals",
      "crossInstanceReplayRefusals",
    ],
    "protocol-parity measurements",
  );
  for (const key of Object.keys(value)) assertNonnegativeInteger(value[key], `protocol-parity.${key}`);
  if (value.validCases !== 12 || value.matchedCases !== value.validCases) {
    throw new TypeError("protocol-parity matched cases must equal all 12 valid cases");
  }
  if (value.unexpectedDivergences !== 0 || value.nodeInvalidFrameDivergences !== 4) {
    throw new TypeError("protocol-parity must record exactly four deliberate Node invalid-frame divergences");
  }
  if (value.ackFieldCount !== 7) {
    throw new TypeError("protocol-parity must prove the exact seven-field acknowledgement");
  }
  if (value.originRefusals !== 2 || value.replayRefusals !== 2) {
    throw new TypeError("protocol-parity must prove both Origin and replay refusals");
  }
  if (value.crossInstanceReplayRefusals !== 1) {
    throw new TypeError("protocol-parity must prove one cross-instance replay refusal");
  }
}

function assertHostileMeasurements(value) {
  assertObject(value, "hostile-capacity measurements");
  assertExactKeys(
    value,
    [
      "binaryFramesSent",
      "accepted",
      "rejected",
      "lost",
      "uncertain",
      "sessionsAccepted",
      "sessionsRefused",
      "session101Refused",
      "ackP95Ms",
      "processAlive",
      "activeSessionsFinal",
      "retainedChunksFinal",
      "retainedBytesFinal",
    ],
    "hostile-capacity measurements",
  );
  assertClosedAccounting(value, "binaryFramesSent", "hostile-capacity");
  if (value.lost !== 0 || value.uncertain !== 0) {
    throw new TypeError("hostile-capacity permits no silent loss or uncertain frame accounting");
  }
  if (value.sessionsAccepted !== REALTIME_IMAGE_THRESHOLDS.capacity.sessions) {
    throw new TypeError("hostile-capacity must serve exactly 100 sessions");
  }
  if (value.sessionsRefused !== 1 || value.session101Refused !== true) {
    throw new TypeError("hostile-capacity must refuse session 101 exactly once");
  }
  assertNonnegativeNumber(value.ackP95Ms, "hostile-capacity.ackP95Ms");
  if (value.ackP95Ms >= REALTIME_IMAGE_THRESHOLDS.capacity.ackP95MsExclusive) {
    throw new TypeError("hostile-capacity acknowledgement p95 must be below 250 ms");
  }
  if (value.processAlive !== true) throw new TypeError("hostile-capacity process must remain alive");
  assertFinalGauges(value, "hostile-capacity");
}

function assertRetentionMeasurements(value) {
  assertObject(value, "retention measurements");
  assertExactKeys(
    value,
    [
      "retentionModesTested",
      "discardObjectsAfterCleanup",
      "teacherReviewPlayable",
      "trainingOptInRetained",
      "metadataMismatches",
      "indexMismatches",
      "privacyLeaks",
    ],
    "retention measurements",
  );
  for (const key of Object.keys(value)) assertNonnegativeInteger(value[key], `retention.${key}`);
  if (
    value.retentionModesTested !== 3 ||
    value.discardObjectsAfterCleanup !== 0 ||
    value.teacherReviewPlayable < 1 ||
    value.trainingOptInRetained < 1
  ) {
    throw new TypeError("retention proof must close all three retention modes");
  }
  if (value.metadataMismatches !== 0 || value.indexMismatches !== 0) {
    throw new TypeError("retention proof permits no metadata or index mismatch");
  }
  if (value.privacyLeaks !== 0) throw new TypeError("retention proof permits no privacy leak");
}

function assertFaultMeasurements(value) {
  assertObject(value, "fault-recovery measurements");
  assertExactKeys(
    value,
    [
      "faultsTested",
      "framesSent",
      "accepted",
      "rejected",
      "lost",
      "uncertain",
      "durableLost",
      "durableOrphan",
      "repaired",
      "outstandingActionable",
      "incompleteReportedComplete",
      "readinessFailedClosed",
      "repairIdempotent",
    ],
    "fault-recovery measurements",
  );
  if (
    !Array.isArray(value.faultsTested) ||
    JSON.stringify(value.faultsTested) !== JSON.stringify(["node-process", "postgres", "s3"])
  ) {
    throw new TypeError("fault-recovery must test Node process, Postgres, and S3 in order");
  }
  assertClosedAccounting(value, "framesSent", "fault-recovery");
  for (const key of [
    "durableLost",
    "durableOrphan",
    "repaired",
    "outstandingActionable",
    "incompleteReportedComplete",
  ]) {
    assertNonnegativeInteger(value[key], `fault-recovery.${key}`);
  }
  if (value.durableLost !== value.lost || value.durableOrphan !== value.uncertain) {
    throw new TypeError("fault-recovery durable loss/orphan outcomes must match loss accounting");
  }
  if (value.repaired !== value.durableLost + value.durableOrphan) {
    throw new TypeError("fault-recovery must repair every durable lost or orphan outcome");
  }
  if (value.outstandingActionable !== 0) {
    throw new TypeError("fault-recovery must leave no outstanding actionable outcome");
  }
  if (value.incompleteReportedComplete !== 0) {
    throw new TypeError("fault-recovery must never report an incomplete recording complete");
  }
  if (value.readinessFailedClosed !== true || value.repairIdempotent !== true) {
    throw new TypeError("fault-recovery must prove fail-closed readiness and idempotent repair");
  }
}

function assertClassroom(value) {
  assertObject(value, "classroom measurements");
  assertExactKeys(
    value,
    [
      "sessions",
      "durationSeconds",
      "frameIntervalMs",
      "framesSent",
      "accepted",
      "rejected",
      "lost",
      "uncertain",
      "ackP95Ms",
      "activeSessionsFinal",
      "retainedChunksFinal",
      "retainedBytesFinal",
    ],
    "classroom measurements",
  );
  assertClosedAccounting(value, "framesSent", "classroom");
  const threshold = REALTIME_IMAGE_THRESHOLDS.classroom;
  if (
    value.sessions !== threshold.sessions ||
    value.durationSeconds !== threshold.durationSeconds ||
    value.frameIntervalMs !== threshold.frameIntervalMs ||
    value.framesSent !== threshold.accountedFrames
  ) {
    throw new TypeError("classroom must account for exactly 15,625 frames over 25 sessions and 5 minutes");
  }
  if (value.rejected !== 0 || value.lost !== 0 || value.uncertain !== 0) {
    throw new TypeError("classroom permits no unexpected rejection, loss, or uncertainty");
  }
  assertNonnegativeNumber(value.ackP95Ms, "classroom.ackP95Ms");
  if (value.ackP95Ms >= threshold.ackP95MsExclusive) {
    throw new TypeError("classroom acknowledgement p95 must be below 250 ms");
  }
  assertFinalGauges(value, "classroom");
}

function assertBurst(value) {
  assertObject(value, "burst measurements");
  assertExactKeys(
    value,
    [
      "sessions",
      "framesPerSession",
      "framesSent",
      "accepted",
      "rejected",
      "lost",
      "uncertain",
      "backpressureRejections",
      "unexpectedRejections",
      "activeSessionsFinal",
      "retainedChunksFinal",
      "retainedBytesFinal",
    ],
    "burst measurements",
  );
  assertClosedAccounting(value, "framesSent", "burst");
  const threshold = REALTIME_IMAGE_THRESHOLDS.burst;
  if (
    value.sessions !== threshold.sessions ||
    value.framesPerSession !== threshold.framesPerSession ||
    value.framesSent !== threshold.accountedFrames
  ) {
    throw new TypeError("burst must account for exactly 5,000 frames across 100 sessions");
  }
  for (const key of ["backpressureRejections", "unexpectedRejections"]) {
    assertNonnegativeInteger(value[key], `burst.${key}`);
  }
  if (
    value.backpressureRejections < 1 ||
    value.backpressureRejections !== value.rejected ||
    value.unexpectedRejections !== 0
  ) {
    throw new TypeError("burst must exhibit bounded explicit backpressure with no unexpected rejection");
  }
  if (value.lost !== 0 || value.uncertain !== 0) {
    throw new TypeError("burst permits no loss or uncertain accounting");
  }
  assertFinalGauges(value, "burst");
}

function assertClassroomBurstMeasurements(value) {
  assertObject(value, "classroom-burst measurements");
  assertExactKeys(value, ["classroom", "burst"], "classroom-burst measurements");
  assertClassroom(value.classroom);
  assertBurst(value.burst);
}

function assertSoakMeasurements(value) {
  assertObject(value, "soak measurements");
  assertExactKeys(
    value,
    [
      "sessions",
      "durationSeconds",
      "frameIntervalMs",
      "framesSent",
      "accepted",
      "rejected",
      "lost",
      "uncertain",
      "restarts",
      "oomKills",
      "ackP95Ms",
      "ackP99Ms",
      "baselineRssBytes",
      "endRssBytes",
      "peakRssBytes",
      "rssGrowthBytes",
      "rssSlopeBytesPerMinute",
      "activeSessionsFinal",
      "retainedChunksFinal",
      "retainedBytesFinal",
    ],
    "soak measurements",
  );
  assertClosedAccounting(value, "framesSent", "soak");
  const threshold = REALTIME_IMAGE_THRESHOLDS.soak;
  if (
    value.sessions !== threshold.sessions ||
    value.durationSeconds !== threshold.durationSeconds ||
    value.frameIntervalMs !== threshold.frameIntervalMs ||
    value.framesSent !== threshold.accountedFrames
  ) {
    throw new TypeError("soak must account for exactly 37,500 frames over 10 sessions and 30 minutes");
  }
  if (value.rejected !== 0 || value.lost !== 0 || value.uncertain !== 0) {
    throw new TypeError("soak permits no rejection, loss, or uncertainty");
  }
  for (const key of ["restarts", "oomKills"]) assertNonnegativeInteger(value[key], `soak.${key}`);
  if (value.restarts !== 0) throw new TypeError("soak permits no process restart");
  if (value.oomKills !== 0) throw new TypeError("soak permits no OOM kill");
  for (const key of ["ackP95Ms", "ackP99Ms", "rssSlopeBytesPerMinute"]) {
    assertNonnegativeNumber(value[key], `soak.${key}`);
  }
  if (value.ackP95Ms >= threshold.ackP95MsExclusive) {
    throw new TypeError("soak acknowledgement p95 must be below 250 ms");
  }
  if (value.ackP99Ms >= threshold.ackP99MsExclusive) {
    throw new TypeError("soak acknowledgement p99 must be below 500 ms");
  }
  for (const key of ["baselineRssBytes", "endRssBytes", "peakRssBytes", "rssGrowthBytes"]) {
    assertNonnegativeInteger(value[key], `soak.${key}`);
  }
  if (value.rssGrowthBytes !== value.endRssBytes - value.baselineRssBytes) {
    throw new TypeError("soak RSS growth must equal end RSS minus baseline RSS");
  }
  if (value.peakRssBytes < Math.max(value.baselineRssBytes, value.endRssBytes)) {
    throw new TypeError("soak peak RSS cannot be lower than baseline or end RSS");
  }
  if (value.peakRssBytes >= threshold.peakRssBytesExclusive) {
    throw new TypeError("soak peak RSS must stay below 512 MiB");
  }
  if (value.rssGrowthBytes > threshold.rssGrowthBytesMax) {
    throw new TypeError("soak RSS growth must stay at or below 96 MiB");
  }
  if (value.rssSlopeBytesPerMinute > threshold.rssSlopeBytesPerMinuteMax) {
    throw new TypeError("soak RSS slope must stay at or below 1 MiB/min");
  }
  assertFinalGauges(value, "soak");
}

const measurementAssertions = new Map([
  ["candidate-running-images", assertCandidateMeasurements],
  ["protocol-parity", assertProtocolMeasurements],
  ["hostile-capacity", assertHostileMeasurements],
  ["retention", assertRetentionMeasurements],
  ["fault-recovery", assertFaultMeasurements],
  ["classroom-burst", assertClassroomBurstMeasurements],
  ["soak", assertSoakMeasurements],
]);

function assertStages(stages, proofStartedAt, proofCompletedAt) {
  if (
    !Array.isArray(stages) ||
    JSON.stringify(stages.map((stage) => stage?.name)) !==
      JSON.stringify(REQUIRED_REALTIME_IMAGE_STAGES)
  ) {
    throw new TypeError("realtime image evidence must contain exactly the seven required ordered stages");
  }

  let priorEnd = proofStartedAt;
  let failed = false;
  let lastExecutedEnd = null;
  const result = [];
  for (const [index, stage] of stages.entries()) {
    assertObject(stage, `realtime image stage ${index + 1}`);
    assertExactKeys(
      stage,
      [
        "name",
        "status",
        "startedAt",
        "completedAt",
        "command",
        "commandSha256",
        "outputSha256",
        "failureCode",
        "measurements",
      ],
      `realtime image stage ${stage.name}`,
    );

    if (stage.status === "not-run") {
      if (!failed) throw new TypeError("a realtime image stage may be not-run only after a failure");
      for (const key of [
        "startedAt",
        "completedAt",
        "command",
        "commandSha256",
        "outputSha256",
        "failureCode",
        "measurements",
      ]) {
        if (stage[key] !== null) throw new TypeError(`not-run stage ${stage.name} ${key} must be null`);
      }
      result.push({ ...stage });
      continue;
    }

    if (failed) throw new TypeError("no realtime image stage may execute after a failed stage");
    if (stage.status !== "passed" && stage.status !== "failed") {
      throw new TypeError(`realtime image stage ${stage.name} has unsupported status`);
    }
    const stageStartedAt = parseIso(stage.startedAt, `${stage.name}.startedAt`);
    const stageCompletedAt = parseIso(stage.completedAt, `${stage.name}.completedAt`);
    if (index === 0 && stageStartedAt !== proofStartedAt) {
      throw new TypeError("the first realtime image stage must start with the proof window");
    }
    if (
      stageStartedAt < priorEnd ||
      stageCompletedAt < stageStartedAt ||
      stageCompletedAt > proofCompletedAt
    ) {
      throw new TypeError("realtime image stage timestamps must be monotonic and non-overlapping");
    }
    priorEnd = stageCompletedAt;
    lastExecutedEnd = stageCompletedAt;
    const command = assertStageCommand(stage.command, stage.commandSha256, stage.name);
    assertDigest(stage.outputSha256, `${stage.name}.outputSha256`);

    if (stage.status === "failed") {
      if (!failureCodes.has(stage.failureCode)) {
        throw new TypeError(`failed stage ${stage.name} must carry a fixed failureCode`);
      }
      if (stage.measurements !== null) {
        throw new TypeError(`failed stage ${stage.name} measurements must be null, never caller-claimed`);
      }
      failed = true;
    } else {
      if (stage.failureCode !== null) {
        throw new TypeError(`passed stage ${stage.name} cannot carry a failureCode`);
      }
      measurementAssertions.get(stage.name)(stage.measurements);
      if (stage.name === "classroom-burst" && stageCompletedAt - stageStartedAt < 5 * 60 * 1_000) {
        throw new TypeError("classroom-burst must earn at least 5 minutes of classroom execution");
      }
      if (stage.name === "soak" && stageCompletedAt - stageStartedAt < 30 * 60 * 1_000) {
        throw new TypeError("soak must earn the full 30 minutes");
      }
    }
    result.push({
      ...stage,
      command,
      measurements: structuredClone(stage.measurements),
    });
  }
  if (lastExecutedEnd !== proofCompletedAt) {
    throw new TypeError("proof completedAt must equal the last executed stage completion");
  }
  return { stages: result, status: failed ? "failed" : "passed" };
}

function assertTopology(value) {
  assertObject(value, "realtime proof topology");
  assertExactKeys(
    value,
    [
      "renderedSha256",
      "nodeRealtimeLoopback",
      "rustPublicPort",
      "publicRealtimeOwner",
      "nodeTrafficSharePercent",
    ],
    "realtime proof topology",
  );
  assertDigest(value.renderedSha256, "topology.renderedSha256");
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(value.nodeRealtimeLoopback);
  const port = match ? Number(match[1]) : 0;
  if (!match || !Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new TypeError("Node realtime proof endpoint must bind a valid 127.0.0.1 loopback port");
  }
  if (port === 8081) throw new TypeError("Node proof loopback must not replace Rust port 8081");
  if (value.rustPublicPort !== 8081 || value.publicRealtimeOwner !== "rust") {
    throw new TypeError("Rust must remain the public realtime owner on port 8081");
  }
  if (value.nodeTrafficSharePercent !== 0) {
    throw new TypeError("W3.8 Node realtime traffic share must remain zero");
  }
  return { ...value };
}

function assertStorage(value) {
  assertObject(value, "realtime proof storage");
  assertExactKeys(
    value,
    ["driver", "bucketClass", "encryption", "expectedOwnerVerified", "filesystemFallback"],
    "realtime proof storage",
  );
  if (value.driver !== "s3" || value.bucketClass !== "production-private") {
    throw new TypeError("realtime release evidence requires production S3 storage");
  }
  if (value.encryption !== "AES256" && value.encryption !== "aws:kms") {
    throw new TypeError("realtime proof storage encryption must be AES256 or aws:kms");
  }
  if (value.expectedOwnerVerified !== true) {
    throw new TypeError("realtime proof storage must verify the expected bucket owner");
  }
  if (value.filesystemFallback !== false) {
    throw new TypeError("realtime proof storage must disable filesystem fallback");
  }
  return { ...value };
}

function expectedImageReferences(selection) {
  const environment = composeImageEnvironment(selection, "candidate");
  return {
    "node-api": environment.NODE_BACKEND_IMAGE,
    "job-worker": environment.NODE_BACKEND_IMAGE,
    "node-realtime": environment.NODE_BACKEND_IMAGE,
    "realtime-gateway": environment.REALTIME_GATEWAY_IMAGE,
  };
}

function assertImages(images, selection) {
  const expected = expectedImageReferences(selection);
  const services = Object.keys(expected);
  if (
    !Array.isArray(images) ||
    JSON.stringify(images.map((image) => image?.service)) !== JSON.stringify(services)
  ) {
    throw new TypeError("realtime proof must contain exactly four ordered Node/Rust images");
  }
  const result = images.map((image) => {
    assertObject(image, "realtime running image");
    assertExactKeys(
      image,
      ["service", "containerId", "reference", "imageId", "user"],
      `realtime running image ${image.service}`,
    );
    if (image.reference !== expected[image.service]) {
      throw new TypeError(`${image.service} reference does not match the selected candidate`);
    }
    if (typeof image.imageId !== "string" || !digestPattern.test(image.imageId)) {
      throw new TypeError(`${image.service} imageId must identify immutable image content`);
    }
    if (typeof image.containerId !== "string" || !containerIdPattern.test(image.containerId)) {
      throw new TypeError(`${image.service} containerId must be a concrete Docker container ID`);
    }
    if (
      typeof image.user !== "string" ||
      image.user.length === 0 ||
      image.user === "root" ||
      /^0(?::0)?$/.test(image.user)
    ) {
      throw new TypeError(`${image.service} must run as a non-root image user`);
    }
    return { ...image };
  });
  const nodeIds = result.slice(0, 3).map(({ imageId }) => imageId);
  if (new Set(nodeIds).size !== 1) {
    throw new TypeError("API, worker, and realtime must share one shared Node image ID");
  }
  return result;
}

function assertThresholds(value) {
  if (!isDeepStrictEqual(value, REALTIME_IMAGE_THRESHOLDS)) {
    throw new TypeError("realtime image thresholds must exactly match the approved fixed bars");
  }
  return structuredClone(value);
}

export function createRealtimeImageEvidence(input) {
  assertObject(input, "realtime image evidence input");
  assertExactKeys(
    input,
    [
      "sourceState",
      "selection",
      "environment",
      "actorClass",
      "evidenceClass",
      "executionMode",
      "startedAt",
      "completedAt",
      "expiresAt",
      "topology",
      "storage",
      "images",
      "thresholds",
      "stages",
      "validatedAt",
    ],
    "realtime image evidence input",
  );

  const selection = assertReleaseDeploymentSelection(input.selection);
  assertObject(input.sourceState, "sourceState");
  assertExactKeys(input.sourceState, ["headSha", "clean"], "sourceState");
  if (input.sourceState.clean !== true) throw new TypeError("source checkout must be clean");
  if (input.sourceState.headSha !== selection.candidate.sourceSha) {
    throw new TypeError("source SHA must match the selected candidate SHA");
  }

  assertObject(input.environment, "environment");
  assertExactKeys(input.environment, ["class", "provider"], "environment");
  if (input.environment.class !== "staging-isolated") {
    throw new TypeError("full realtime image evidence requires staging-isolated execution");
  }
  if (
    typeof input.environment.provider !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(input.environment.provider)
  ) {
    throw new TypeError("environment.provider must be a stable non-secret identifier");
  }
  if (input.actorClass !== "release-automation" && input.actorClass !== "release-operator") {
    throw new TypeError("actorClass must be release-automation or release-operator");
  }
  if (input.evidenceClass !== "live-release-candidate") {
    throw new TypeError("evidenceClass must identify a live release candidate, never a fixture");
  }
  if (input.executionMode !== "immutable-compose-images") {
    throw new TypeError("executionMode must use immutable Compose images");
  }

  const proofStartedAt = parseIso(input.startedAt, "startedAt");
  const proofCompletedAt = parseIso(input.completedAt, "completedAt");
  const proofExpiresAt = parseIso(input.expiresAt, "expiresAt");
  const validatedAt = parseIso(input.validatedAt, "validatedAt");
  if (proofCompletedAt < proofStartedAt) {
    throw new TypeError("completedAt must not precede startedAt");
  }
  if (Date.parse(selection.createdAt) > proofStartedAt) {
    throw new TypeError("release selection must exist before the realtime proof starts");
  }
  if (proofExpiresAt <= proofCompletedAt || proofExpiresAt - proofCompletedAt > DAY_MS) {
    throw new TypeError("expiresAt must be after completion and no more than 24 hours later");
  }
  if (validatedAt < proofCompletedAt) throw new TypeError("realtime evidence completion is in the future");
  if (validatedAt > proofExpiresAt) throw new TypeError("realtime image evidence is expired");

  const topology = assertTopology(input.topology);
  const storage = assertStorage(input.storage);
  const images = assertImages(input.images, selection);
  const thresholds = assertThresholds(input.thresholds);
  const stageResult = assertStages(input.stages, proofStartedAt, proofCompletedAt);

  return {
    schemaVersion: "qrai-realtime-image-evidence/v1",
    status: stageResult.status,
    sourceSha: selection.candidate.sourceSha,
    sourceState: { ...input.sourceState },
    selection,
    environment: { ...input.environment },
    actorClass: input.actorClass,
    evidenceClass: input.evidenceClass,
    executionMode: input.executionMode,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    expiresAt: input.expiresAt,
    topology,
    storage,
    images,
    thresholds,
    stages: stageResult.stages,
  };
}

export function assertRealtimeImageEvidence(value, { validatedAt }) {
  assertObject(value, "realtime image evidence");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "status",
      "sourceSha",
      "sourceState",
      "selection",
      "environment",
      "actorClass",
      "evidenceClass",
      "executionMode",
      "startedAt",
      "completedAt",
      "expiresAt",
      "topology",
      "storage",
      "images",
      "thresholds",
      "stages",
    ],
    "realtime image evidence",
  );
  if (value.schemaVersion !== "qrai-realtime-image-evidence/v1") {
    throw new TypeError("realtime image evidence schemaVersion is unsupported");
  }
  if (value.status !== "passed" && value.status !== "failed") {
    throw new TypeError("realtime image evidence status must be passed or failed");
  }
  const reconstructed = createRealtimeImageEvidence({
    sourceState: value.sourceState,
    selection: value.selection,
    environment: value.environment,
    actorClass: value.actorClass,
    evidenceClass: value.evidenceClass,
    executionMode: value.executionMode,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    expiresAt: value.expiresAt,
    topology: value.topology,
    storage: value.storage,
    images: value.images,
    thresholds: value.thresholds,
    stages: value.stages,
    validatedAt,
  });
  if (!isDeepStrictEqual(reconstructed, value)) {
    throw new TypeError("realtime image evidence identity, status, or policy was altered");
  }
  return reconstructed;
}

export function assertRealtimeImageEvidenceForPromotion(value, { validatedAt }) {
  const evidence = assertRealtimeImageEvidence(value, { validatedAt });
  if (evidence.status !== "passed") {
    throw new TypeError("only passed realtime image evidence is eligible for promotion");
  }
  return evidence;
}

export function realtimeImageCommandPlan({ projectName }) {
  if (typeof projectName !== "string" || !projectNamePattern.test(projectName)) {
    throw new TypeError("projectName must be a lower-case Compose project name");
  }
  const compose = [
    "docker",
    "compose",
    "--project-name",
    projectName,
    "--file",
    "docker-compose.yml",
    "--file",
    "docker-compose.release.yml",
    "--file",
    "docker-compose.native.yml",
    "--file",
    "docker-compose.realtime-proof.yml",
  ];
  const commands = [
    [...compose, "config", "--format", "json"],
    ["node", "scripts/release-deployment.mjs", "verify", "--slot", "candidate"],
    [...compose, "up", "-d", "--no-build", "--wait"],
    ...REQUIRED_REALTIME_IMAGE_STAGES.map(stageCommand),
    [...compose, "down", "--remove-orphans"],
  ];
  return Object.freeze(commands.map((command) => Object.freeze(command)));
}

function pathIsInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function writeRealtimeImageEvidenceOnce({
  outputPath,
  evidence,
  repositoryRoot,
  validatedAt,
}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("outputPath is required");
  }
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new TypeError("repositoryRoot is required");
  }
  const validated = assertRealtimeImageEvidence(evidence, { validatedAt });
  const checkout = realpathSync(resolve(repositoryRoot));
  const requested = resolve(outputPath);
  const parent = realpathSync(dirname(requested));
  if (pathIsInside(checkout, parent)) {
    throw new TypeError("realtime evidence output must stay outside the candidate checkout");
  }

  const target = join(parent, basename(requested));
  const temporary = join(parent, `.${basename(requested)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        throw new TypeError("realtime evidence output is write-once and already exists");
      }
      throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  return target;
}
