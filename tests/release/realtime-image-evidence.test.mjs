import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { DEPLOYABLE_IMAGE_KEYS } from "../../scripts/lib/deployable-images.mjs";
import {
  REQUIRED_REALTIME_IMAGE_STAGES,
  REALTIME_IMAGE_THRESHOLDS,
  assertRealtimeImageEvidence,
  assertRealtimeImageEvidenceForPromotion,
  createRealtimeImageEvidence,
  realtimeImageCommandPlan,
  writeRealtimeImageEvidenceOnce,
} from "../../scripts/lib/realtime-image-evidence.mjs";
import {
  composeImageEnvironment,
  createReleaseDeploymentSelection,
} from "../../scripts/lib/release-deployment.mjs";
import {
  createRealtimeFaultRepairProbe,
  createRealtimeProofPreflight,
  probeRealtimeCandidateRunningImages,
  createRealtimeRetentionProofAdapters,
  parseRealtimeProofPort,
  probeRealtimeAudioFrame,
  probeRealtimeCapacityCohort,
  probeRealtimeHostileSweep,
  probeRealtimeMetricsSnapshot,
  probeRealtimeProcessReadiness,
  probeRealtimeReadiness,
  probeRealtimeUpgradeRefusal,
  runRealtimeHostileCapacityStage,
  runRealtimeFaultRecoveryStage,
  runRealtimeNodeProcessFaultProbe,
  runRealtimePostgresFaultProbe,
  runRealtimeProtocolParityStage,
  runRealtimeRetentionStage,
  summarizeRealtimeAudioFrameProbes,
  validateRealtimeProofRenderedTopology,
} from "../../scripts/lib/realtime-image-probe.mjs";
import {
  collectRealtimeCandidateRunningImagesRuntime,
  createRealtimeNodeProcessFaultLifecycleRuntime,
  createRealtimePostgresFaultLifecycleRuntime,
  parseRealtimeImageProofArguments,
  probeRealtimeS3FaultProcessRuntime,
  runRealtimeImageProofStage,
} from "../../scripts/realtime-image-proof.mjs";
import { issueRealtimeTicket } from "../../server/src/lib/ticket.mjs";
import { createRealtimeApplication } from "../../server/src/realtime/main.mjs";

const MiB = 1024 * 1024;
const candidateSha = "0123456789abcdef0123456789abcdef01234567";
const previousSha = "89abcdef0123456789abcdef0123456789abcdef";
const selectionCreatedAt = "2026-08-08T07:59:00.000Z";
const startedAt = "2026-08-08T08:00:00.000Z";
const completedAt = "2026-08-08T08:51:00.000Z";
const expiresAt = "2026-08-09T08:51:00.000Z";
const probeOrigin = "https://proof.quran.example.org";
const probeSecret = "w3.8-image-proof-ticket-secret-over-32-bytes";
const probeTenant = "tenant-w3-8-proof";
const probeSession = "session-w3-8-proof";
const probeLearner = "learner-w3-8-proof";
const probeNowSeconds = 2_100_000_000;

function digests(offset) {
  const digits = "123456789abcdef";
  return Object.fromEntries(
    DEPLOYABLE_IMAGE_KEYS.map((key, index) => [
      key,
      `sha256:${digits[offset + index].repeat(64)}`,
    ]),
  );
}

function selection() {
  return createReleaseDeploymentSelection({
    candidateSha,
    candidateImageDigests: digests(0),
    previousSha,
    previousImageDigests: digests(5),
    namespace: "ExampleOwner",
    createdAt: selectionCreatedAt,
  });
}

function runningImages(value = selection()) {
  const environment = composeImageEnvironment(value, "candidate");
  const nodeImageId = `sha256:${"1".repeat(64)}`;
  return [
    ["node-api", environment.NODE_BACKEND_IMAGE, nodeImageId, "node"],
    ["job-worker", environment.NODE_BACKEND_IMAGE, nodeImageId, "node"],
    ["node-realtime", environment.NODE_BACKEND_IMAGE, nodeImageId, "node"],
    ["realtime-gateway", environment.REALTIME_GATEWAY_IMAGE, `sha256:${"2".repeat(64)}`, "appuser"],
  ].map(([service, reference, imageId, user], index) => ({
    service,
    containerId: `${String(index + 1).repeat(12)}`,
    reference,
    imageId,
    user,
  }));
}

function candidateRunningObservations(value = selection()) {
  const environment = composeImageEnvironment(value, "candidate");
  const nodeImageId = `sha256:${"1".repeat(64)}`;
  return Object.fromEntries([
    ["node-api", environment.NODE_BACKEND_IMAGE, nodeImageId, "node", 1000],
    ["job-worker", environment.NODE_BACKEND_IMAGE, nodeImageId, "node", 1000],
    ["node-realtime", environment.NODE_BACKEND_IMAGE, nodeImageId, "node", 1000],
    [
      "realtime-gateway",
      environment.REALTIME_GATEWAY_IMAGE,
      `sha256:${"2".repeat(64)}`,
      "appuser",
      10_001,
    ],
  ].map(([service, configuredImage, imageId, configuredUser, effectiveUid], index) => [
    service,
    {
      containerId: `${String(index + 1).repeat(12)}`,
      configuredImage,
      imageId,
      localImageId: imageId,
      repoDigests: [configuredImage],
      running: true,
      health: "healthy",
      configuredUser,
      effectiveUid,
    },
  ]));
}

function stageMeasurements(name) {
  switch (name) {
    case "candidate-running-images":
      return {
        cleanSource: true,
        selectionMatched: true,
        runningImagesMatched: 4,
        nonRootContainers: 4,
        sharedNodeImage: true,
        topologyMatched: true,
        productionStorageReady: true,
      };
    case "protocol-parity":
      return {
        validCases: 12,
        matchedCases: 12,
        unexpectedDivergences: 0,
        nodeInvalidFrameDivergences: 4,
        ackFieldCount: 7,
        originRefusals: 2,
        replayRefusals: 2,
        crossInstanceReplayRefusals: 1,
      };
    case "hostile-capacity":
      return {
        binaryFramesSent: 107,
        accepted: 100,
        rejected: 7,
        lost: 0,
        uncertain: 0,
        sessionsAccepted: 100,
        sessionsRefused: 1,
        session101Refused: true,
        ackP95Ms: 120,
        processAlive: true,
        activeSessionsFinal: 0,
        retainedChunksFinal: 0,
        retainedBytesFinal: 0,
      };
    case "retention":
      return {
        retentionModesTested: 3,
        discardObjectsAfterCleanup: 0,
        teacherReviewPlayable: 1,
        trainingOptInRetained: 1,
        metadataMismatches: 0,
        indexMismatches: 0,
        privacyLeaks: 0,
      };
    case "fault-recovery":
      return {
        faultsTested: ["node-process", "postgres", "s3"],
        framesCaptured: 12,
        framesTransmitted: 11,
        accepted: 7,
        rejected: 2,
        lost: 2,
        uncertain: 1,
        durableLost: 1,
        durableOrphan: 0,
        unresolvedUncertain: 1,
        repaired: 0,
        outstandingActionable: 2,
        incompleteReportedComplete: 0,
        readinessFailedClosed: true,
        repairIdempotent: true,
      };
    case "classroom-burst":
      return {
        classroom: {
          sessions: 25,
          durationSeconds: 300,
          frameIntervalMs: 480,
          framesSent: 15_625,
          accepted: 15_625,
          rejected: 0,
          lost: 0,
          uncertain: 0,
          ackP95Ms: 140,
          activeSessionsFinal: 0,
          retainedChunksFinal: 0,
          retainedBytesFinal: 0,
        },
        burst: {
          sessions: 100,
          framesPerSession: 50,
          framesSent: 5_000,
          accepted: 4_500,
          rejected: 500,
          lost: 0,
          uncertain: 0,
          backpressureRejections: 500,
          unexpectedRejections: 0,
          activeSessionsFinal: 0,
          retainedChunksFinal: 0,
          retainedBytesFinal: 0,
        },
      };
    case "soak":
      return {
        sessions: 10,
        durationSeconds: 1_800,
        frameIntervalMs: 480,
        framesSent: 37_500,
        accepted: 37_500,
        rejected: 0,
        lost: 0,
        uncertain: 0,
        restarts: 0,
        oomKills: 0,
        ackP95Ms: 150,
        ackP99Ms: 300,
        baselineRssBytes: 100 * MiB,
        endRssBytes: 120 * MiB,
        peakRssBytes: 200 * MiB,
        rssGrowthBytes: 20 * MiB,
        rssSlopeBytesPerMinute: 700_000,
        activeSessionsFinal: 0,
        retainedChunksFinal: 0,
        retainedBytesFinal: 0,
      };
    default:
      throw new Error(`unknown stage ${name}`);
  }
}

const stageWindows = [
  ["08:00:00", "08:01:00"],
  ["08:01:00", "08:03:00"],
  ["08:03:00", "08:05:00"],
  ["08:05:00", "08:10:00"],
  ["08:10:00", "08:15:00"],
  ["08:15:00", "08:21:00"],
  ["08:21:00", "08:51:00"],
];

function stages() {
  return REQUIRED_REALTIME_IMAGE_STAGES.map((name, index) => {
    const command = ["node", "scripts/realtime-image-proof.mjs", "probe", "--stage", name];
    return {
      name,
      status: "passed",
      startedAt: `2026-08-08T${stageWindows[index][0]}.000Z`,
      completedAt: `2026-08-08T${stageWindows[index][1]}.000Z`,
      command,
      commandSha256: `sha256:${createHash("sha256").update(JSON.stringify(command)).digest("hex")}`,
      outputSha256: `sha256:${String(index + 2).repeat(64)}`,
      failureCode: null,
      measurements: stageMeasurements(name),
    };
  });
}

function validInput() {
  return {
    sourceState: { headSha: candidateSha, clean: true },
    selection: selection(),
    environment: { class: "staging-isolated", provider: "release-staging" },
    actorClass: "release-automation",
    evidenceClass: "live-release-candidate",
    executionMode: "immutable-compose-images",
    startedAt,
    completedAt,
    expiresAt,
    topology: {
      renderedSha256: `sha256:${"a".repeat(64)}`,
      nodeRealtimeLoopback: "127.0.0.1:18081",
      rustPublicPort: 8081,
      publicRealtimeOwner: "rust",
      nodeTrafficSharePercent: 0,
    },
    storage: {
      driver: "s3",
      bucketClass: "production-private",
      encryption: "AES256",
      expectedOwnerVerified: true,
      filesystemFallback: false,
    },
    images: runningImages(),
    thresholds: structuredClone(REALTIME_IMAGE_THRESHOLDS),
    stages: stages(),
    validatedAt: completedAt,
  };
}

function renderedProofTopology(
  value = selection(),
  nodePort = 18_081,
  secondaryNodePort = 18_082,
  faultNodePort = 18_083,
) {
  const environment = composeImageEnvironment(value, "candidate");
  const storage = {
    AUDIO_STORAGE_DRIVER: "s3",
    AUDIO_STORAGE_FILESYSTEM_ACKNOWLEDGED_DEV_ONLY: "0",
    AUDIO_STORAGE_S3_BUCKET: "qrai-production-private-audio",
    AUDIO_STORAGE_S3_REGION: "eu-central-1",
    AUDIO_STORAGE_S3_EXPECTED_OWNER: "123456789012",
    AUDIO_STORAGE_S3_ENCRYPTION: "AES256",
  };
  const realtimeAuthority = {
    DATABASE_URL: "postgresql://quran_ai_app:fixture@postgres:5432/quran_ai",
    REALTIME_GATEWAY_TICKET_SECRET: "fixture-proof-ticket-secret",
    GATEWAY_TENANT_ID: "hikmah-pilot-erbil",
  };
  return {
    services: {
      "node-api": {
        image: environment.NODE_BACKEND_IMAGE,
        environment: { ...storage },
      },
      "job-worker": {
        image: environment.NODE_BACKEND_IMAGE,
        environment: { ...storage },
      },
      "node-realtime": {
        image: environment.NODE_BACKEND_IMAGE,
        environment: { ...storage, ...realtimeAuthority },
        ports: [{
          mode: "ingress",
          target: 8081,
          published: String(nodePort),
          protocol: "tcp",
          host_ip: "127.0.0.1",
        }],
      },
      "node-realtime-proof-peer": {
        image: environment.NODE_BACKEND_IMAGE,
        environment: { ...storage, ...realtimeAuthority },
        ports: [{
          mode: "ingress",
          target: 8081,
          published: String(secondaryNodePort),
          protocol: "tcp",
          host_ip: "127.0.0.1",
        }],
      },
      "node-realtime-proof-s3-fault": {
        image: environment.NODE_BACKEND_IMAGE,
        command: ["node", "server/src/realtime/main.mjs"],
        profiles: ["realtime-proof-fault"],
        restart: "no",
        environment: {
          ...storage,
          ...realtimeAuthority,
          AUDIO_STORAGE_S3_ENDPOINT: "http://127.0.0.1:9",
          AUDIO_STORAGE_S3_FORCE_PATH_STYLE: "1",
        },
        ports: [{
          mode: "ingress",
          target: 8081,
          published: String(faultNodePort),
          protocol: "tcp",
          host_ip: "127.0.0.1",
        }],
      },
      "realtime-gateway": {
        image: environment.REALTIME_GATEWAY_IMAGE,
        ports: [{
          mode: "ingress",
          target: 8081,
          published: "8081",
          protocol: "tcp",
        }],
      },
      web: {
        depends_on: {
          "realtime-gateway": { condition: "service_healthy" },
        },
      },
    },
  };
}

function realtimeProbeTicket(nonce = "nonce-w3-8-proof", sessionId = probeSession) {
  return issueRealtimeTicket({
    sessionId,
    tenantId: probeTenant,
    learnerId: probeLearner,
    externalAsrProcessing: false,
    audioRetention: "discard",
    expiresAtUnixSeconds: probeNowSeconds + 300,
    nonce,
  }, probeSecret);
}

function realtimeHostilePeers(prefix = "private-hostile") {
  const peer = (suffix, sessionId = `${prefix}-session-${suffix}`) => ({
    sessionId,
    ticket: realtimeProbeTicket(`${prefix}-nonce-${suffix}`, sessionId),
  });
  const duplicateSessionId = `${prefix}-session-duplicate`;
  return {
    ticket: peer("ticket"),
    frames: Array.from({ length: 7 }, (_, index) => peer(`frame-${index}`)),
    transport: peer("transport"),
    text: peer("text"),
    duplicate: [
      peer("duplicate-primary", duplicateSessionId),
      peer("duplicate-secondary", duplicateSessionId),
    ],
  };
}

function realtimeMetricsSnapshot(overrides = {}) {
  return {
    activeSessions: 0,
    retainedChunks: 0,
    retainedBytes: 0,
    ingressEnqueued: 10,
    storeStored: 10,
    storeFailed: 2,
    storeAborted: 1,
    deliveryDiscarded: 8,
    deliveryRejected: 4,
    deliveryAcceptedLost: 3,
    deliveryAcceptedLostUnrecorded: 2,
    ...overrides,
  };
}

function realtimeMetricsText(snapshot) {
  return [
    `realtime_audio_active_sessions ${snapshot.activeSessions}`,
    `realtime_audio_retained_chunks ${snapshot.retainedChunks}`,
    `realtime_audio_retained_bytes ${snapshot.retainedBytes}`,
    `realtime_audio_ingress_total{outcome="enqueued"} ${snapshot.ingressEnqueued}`,
    `realtime_audio_store_total{outcome="stored"} ${snapshot.storeStored}`,
    `realtime_audio_store_total{outcome="failed"} ${snapshot.storeFailed}`,
    `realtime_audio_store_total{outcome="aborted"} ${snapshot.storeAborted}`,
    `realtime_audio_delivery_total{outcome="discarded"} ${snapshot.deliveryDiscarded}`,
    `realtime_audio_delivery_total{outcome="rejected"} ${snapshot.deliveryRejected}`,
    `realtime_audio_delivery_total{outcome="accepted_lost"} ${snapshot.deliveryAcceptedLost}`,
    `realtime_audio_delivery_total{outcome="accepted_lost_unrecorded"} ${snapshot.deliveryAcceptedLostUnrecorded}`,
    "",
  ].join("\n");
}

function realtimeProbeAppOptions(handleAdmittedSocket, overrides = {}) {
  return {
    db: { assertRestrictedRole: async () => {}, end: async () => {} },
    audioObjectStore: {
      assertReady: async () => {},
      close: async () => {},
      put: async () => ({ created: true }),
    },
    workerReadyUrl: "http://worker:8098/ready",
    asrReadyUrl: "http://asr:8091/ready",
    readinessTimeoutMs: 100,
    shutdownGraceMs: 1_000,
    metricsToken: null,
    metricsDevOpen: true,
    fetchImpl: async () => ({ status: 200, body: { cancel: async () => {} } }),
    ticketSecret: probeSecret,
    tenantId: probeTenant,
    allowedOrigins: [probeOrigin],
    allowMissingOrigin: false,
    rateLimitEnabled: true,
    trustedProxyHops: 0,
    replayAuthority: {
      claim: async () => "fresh",
      renderMetrics: () => "",
      start: () => {},
      stop: async () => {},
    },
    audioOutcomeAuthority: {
      stored: async () => "discarded",
      lost: async () => "accepted_lost",
      lostMany: async () => "accepted_lost",
    },
    admissionNowUnixSeconds: () => probeNowSeconds,
    handleAdmittedSocket,
    logger: false,
    ...overrides,
  };
}

async function withRealtimeProbeApp(handleAdmittedSocket, body, overrides = {}) {
  const app = createRealtimeApplication(realtimeProbeAppOptions(handleAdmittedSocket, overrides));
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    return await body(app.server.address().port, app);
  } finally {
    await app.close();
  }
}

test("passed evidence binds the candidate, immutable non-root images, topology, storage, stages, and bars", () => {
  const evidence = createRealtimeImageEvidence(validInput());
  assert.equal(evidence.schemaVersion, "qrai-realtime-image-evidence/v1");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.sourceSha, candidateSha);
  assert.equal(evidence.images.length, 4);
  assert.equal(evidence.stages.length, 7);
  assert.deepEqual(evidence.thresholds, REALTIME_IMAGE_THRESHOLDS);
  assert.deepEqual(
    assertRealtimeImageEvidenceForPromotion(evidence, { validatedAt: completedAt }),
    evidence,
  );
});

test("identity, provenance, expiry, topology, storage, and exact-shape mutations fail closed", () => {
  const cases = [
    [(copy) => { copy.sourceState.clean = false; }, /clean/i],
    [(copy) => { copy.sourceState.headSha = previousSha; }, /source SHA.*candidate/i],
    [(copy) => { copy.selection.createdAt = "2026-08-08T08:00:00.001Z"; }, /selection.*before/i],
    [(copy) => { copy.environment.class = "ci"; }, /staging-isolated/i],
    [(copy) => { copy.actorClass = "developer"; }, /actorClass/i],
    [(copy) => { copy.evidenceClass = "fixture"; }, /live release candidate/i],
    [(copy) => { copy.executionMode = "source-processes"; }, /immutable Compose images/i],
    [(copy) => { copy.validatedAt = "2026-08-09T08:51:00.001Z"; }, /expired/i],
    [(copy) => { copy.expiresAt = "2026-08-09T08:51:00.001Z"; }, /24 hours/i],
    [(copy) => { copy.topology.nodeRealtimeLoopback = "0.0.0.0:18081"; }, /loopback/i],
    [(copy) => { copy.topology.nodeRealtimeLoopback = "127.0.0.1:8081"; }, /8081|Rust/i],
    [(copy) => { copy.topology.nodeTrafficSharePercent = 1; }, /traffic share/i],
    [(copy) => { copy.topology.publicRealtimeOwner = "node"; }, /Rust/i],
    [(copy) => { copy.storage.driver = "filesystem"; }, /production S3/i],
    [(copy) => { copy.storage.expectedOwnerVerified = false; }, /owner/i],
    [(copy) => { copy.images.pop(); }, /exactly.*images/i],
    [(copy) => { copy.images[0].user = "root"; }, /non-root/i],
    [(copy) => { copy.images[1].imageId = `sha256:${"f".repeat(64)}`; }, /shared Node image/i],
    [(copy) => { copy.thresholds.soak.ackP99MsExclusive = 501; }, /thresholds.*exact/i],
    [(copy) => { copy.callerSaysPassed = true; }, /exactly/i],
    [(copy) => { copy.stages[0].rawTicket = "secret"; }, /exactly/i],
  ];

  for (const [mutate, pattern] of cases) {
    const copy = structuredClone(validInput());
    mutate(copy);
    assert.throws(() => createRealtimeImageEvidence(copy), pattern);
  }
});

test("every measured profile is closed-accounting and cannot lower or merely claim its bar", () => {
  const cases = [
    [(copy) => { copy.stages[1].measurements.matchedCases = 11; }, /matched cases/i],
    [(copy) => {
      copy.stages[1].measurements.validCases = 13;
      copy.stages[1].measurements.matchedCases = 13;
    }, /12 valid cases/i],
    [(copy) => { copy.stages[1].measurements.nodeInvalidFrameDivergences = 5; }, /four deliberate/i],
    [(copy) => { copy.stages[1].measurements.originRefusals = 1; }, /both Origin/i],
    [(copy) => { copy.stages[1].measurements.replayRefusals = 1; }, /both Origin/i],
    [(copy) => { copy.stages[1].measurements.crossInstanceReplayRefusals = 0; }, /cross-instance/i],
    [(copy) => { copy.stages[1].measurements.ackFieldCount = 8; }, /seven-field/i],
    [(copy) => { copy.stages[2].measurements.lost = 1; }, /accounting|loss/i],
    [(copy) => { copy.stages[2].measurements.ackP95Ms = 250; }, /p95/i],
    [(copy) => { copy.stages[2].measurements.sessionsAccepted = 99; }, /100 sessions/i],
    [(copy) => { copy.stages[3].measurements.retentionModesTested = 2; }, /retention/i],
    [(copy) => { copy.stages[3].measurements.privacyLeaks = 1; }, /privacy/i],
    [(copy) => { copy.stages[4].measurements.framesTransmitted = 12; }, /transmission/i],
    [(copy) => {
      copy.stages[4].measurements.durableLost = 3;
      copy.stages[4].measurements.framesTransmitted = 13;
    }, /durable loss/i],
    [(copy) => { copy.stages[4].measurements.unresolvedUncertain = 2; }, /uncertainty/i],
    [(copy) => { copy.stages[4].measurements.unresolvedUncertain = 0; }, /uncertainty/i],
    [(copy) => { copy.stages[4].measurements.outstandingActionable = 1; }, /actionable/i],
    [(copy) => { copy.stages[4].measurements.incompleteReportedComplete = 1; }, /incomplete/i],
    [(copy) => { copy.stages[5].measurements.classroom.framesSent -= 1; }, /15,625|classroom/i],
    [(copy) => { copy.stages[5].measurements.classroom.ackP95Ms = 250; }, /classroom.*p95/i],
    [(copy) => { copy.stages[5].measurements.burst.backpressureRejections = 0; }, /backpressure/i],
    [(copy) => { copy.stages[6].measurements.framesSent -= 1; }, /37,500|soak/i],
    [(copy) => { copy.stages[6].measurements.ackP99Ms = 500; }, /p99/i],
    [(copy) => { copy.stages[6].measurements.peakRssBytes = 512 * MiB; }, /peak RSS/i],
    [(copy) => { copy.stages[6].measurements.rssGrowthBytes = 96 * MiB + 1; }, /RSS growth/i],
    [(copy) => { copy.stages[6].measurements.rssSlopeBytesPerMinute = MiB + 1; }, /RSS slope/i],
    [(copy) => { copy.stages[6].measurements.restarts = 1; }, /restart/i],
    [(copy) => { copy.stages[6].measurements.activeSessionsFinal = 1; }, /final gauges/i],
  ];

  for (const [mutate, pattern] of cases) {
    const copy = structuredClone(validInput());
    mutate(copy);
    assert.throws(() => createRealtimeImageEvidence(copy), pattern);
  }
});

test("stage order is exact and the classroom and soak durations are earned", () => {
  const cases = [
    [(copy) => { copy.stages.reverse(); }, /ordered stages/i],
    [(copy) => { copy.stages[2].startedAt = copy.stages[1].startedAt; }, /non-overlapping/i],
    [(copy) => { copy.stages[5].completedAt = "2026-08-08T08:19:59.999Z"; }, /classroom.*5 minutes/i],
    [(copy) => {
      copy.stages[6].completedAt = "2026-08-08T08:50:59.999Z";
      copy.completedAt = copy.stages[6].completedAt;
      copy.expiresAt = "2026-08-09T08:50:59.999Z";
    }, /soak.*30 minutes/i],
    [(copy) => { copy.stages[0].commandSha256 = "mutable-command"; }, /sha256/i],
    [(copy) => { copy.stages.pop(); }, /ordered stages/i],
  ];
  for (const [mutate, pattern] of cases) {
    const copy = structuredClone(validInput());
    mutate(copy);
    assert.throws(() => createRealtimeImageEvidence(copy), pattern);
  }
});

test("failed execution is preserved, later stages stay not-run, and promotion remains impossible", () => {
  const input = validInput();
  const failed = input.stages[4];
  failed.status = "failed";
  failed.failureCode = "dependency-unavailable";
  failed.measurements = null;
  for (const stage of input.stages.slice(5)) {
    stage.status = "not-run";
    stage.startedAt = null;
    stage.completedAt = null;
    stage.command = null;
    stage.commandSha256 = null;
    stage.outputSha256 = null;
    stage.failureCode = null;
    stage.measurements = null;
  }
  input.completedAt = failed.completedAt;
  input.expiresAt = "2026-08-09T08:15:00.000Z";
  input.validatedAt = input.completedAt;

  const evidence = createRealtimeImageEvidence(input);
  assert.equal(evidence.status, "failed");
  assert.deepEqual(assertRealtimeImageEvidence(evidence, { validatedAt: input.completedAt }), evidence);
  assert.throws(
    () => assertRealtimeImageEvidenceForPromotion(evidence, { validatedAt: input.completedAt }),
    /passed.*promotion/i,
  );

  const forged = structuredClone(evidence);
  forged.status = "passed";
  assert.throws(
    () => assertRealtimeImageEvidenceForPromotion(forged, { validatedAt: input.completedAt }),
    /failed|altered|passed/i,
  );
});

test("the command plan uses immutable release images, loopback proof topology, all stages, and cleanup", () => {
  const plan = realtimeImageCommandPlan({ projectName: "qrai-realtime-proof" });
  const rendered = JSON.stringify(plan);
  assert.match(rendered, /docker-compose\.release\.yml/);
  assert.match(rendered, /docker-compose\.native\.yml/);
  assert.match(rendered, /docker-compose\.realtime-proof\.yml/);
  assert.match(rendered, /release-deployment\.mjs/);
  assert.deepEqual(
    plan[0].slice(-5),
    ["--profile", "realtime-proof-fault", "config", "--format", "json"],
  );
  assert.equal(plan[2].includes("realtime-proof-fault"), false);
  for (const stage of REQUIRED_REALTIME_IMAGE_STAGES) assert.match(rendered, new RegExp(stage));
  assert.match(rendered, /down.*--remove-orphans/);
  assert.doesNotMatch(rendered, /cargo run|pnpm.*dev|server\/src\/realtime\/main\.mjs|--build|docker build/);
  assert.throws(() => realtimeImageCommandPlan({ projectName: "../../unsafe" }), /projectName/);
});

test("the proof overlay exposes healthy peers plus one opt-in same-image S3 fault on distinct loopbacks", () => {
  const overlay = parseYaml(readFileSync("docker-compose.realtime-proof.yml", "utf8"));
  assert.deepEqual(
    overlay.services?.["node-realtime"]?.ports,
    ["127.0.0.1:${REALTIME_PROOF_NODE_PORT:-18081}:8081"],
  );
  assert.deepEqual(
    overlay.services?.["node-realtime-proof-peer"]?.ports,
    ["127.0.0.1:${REALTIME_PROOF_SECONDARY_NODE_PORT:-18082}:8081"],
  );
  assert.deepEqual(
    overlay.services?.["node-realtime-proof-s3-fault"]?.ports,
    ["127.0.0.1:${REALTIME_PROOF_FAULT_NODE_PORT:-18083}:8081"],
  );
  assert.equal(
    overlay.services?.["node-realtime-proof-peer"]?.image,
    "${NODE_BACKEND_IMAGE:?Set NODE_BACKEND_IMAGE to an immutable repository@sha256 digest}",
  );
  assert.deepEqual(
    overlay.services?.["node-realtime-proof-peer"]?.command,
    ["node", "server/src/realtime/main.mjs"],
  );
  const fault = overlay.services?.["node-realtime-proof-s3-fault"];
  assert.equal(
    fault?.image,
    "${NODE_BACKEND_IMAGE:?Set NODE_BACKEND_IMAGE to an immutable repository@sha256 digest}",
  );
  assert.deepEqual(fault?.command, ["node", "server/src/realtime/main.mjs"]);
  assert.deepEqual(fault?.profiles, ["realtime-proof-fault"]);
  assert.equal(fault?.restart, "no");
  assert.equal(fault?.environment?.AUDIO_STORAGE_S3_ENDPOINT, "http://127.0.0.1:9");
  assert.equal(fault?.environment?.AUDIO_STORAGE_S3_FORCE_PATH_STYLE, "1");
  assert.equal(overlay.services?.["realtime-gateway"], undefined);

  for (const service of [
    "node-api",
    "job-worker",
    "node-realtime",
    "node-realtime-proof-peer",
    "node-realtime-proof-s3-fault",
  ]) {
    const config = overlay.services?.[service];
    assert.equal(config?.build, undefined);
    if (!service.startsWith("node-realtime-proof-")) assert.equal(config?.image, undefined);
    assert.equal(config?.environment?.AUDIO_STORAGE_DRIVER, "s3");
    assert.equal(config?.environment?.AUDIO_STORAGE_FILESYSTEM_ACKNOWLEDGED_DEV_ONLY, "0");
    assert.equal(
      config?.environment?.AUDIO_STORAGE_S3_BUCKET,
      "${AUDIO_STORAGE_S3_BUCKET:?AUDIO_STORAGE_S3_BUCKET is required for realtime release proof}",
    );
    assert.equal(
      config?.environment?.AUDIO_STORAGE_S3_EXPECTED_OWNER,
      "${AUDIO_STORAGE_S3_EXPECTED_OWNER:?AUDIO_STORAGE_S3_EXPECTED_OWNER is required for realtime release proof}",
    );
  }
});

test("rendered proof preflight binds exact images, topology, storage, and clean candidate source", () => {
  const value = selection();
  const rendered = renderedProofTopology(value);
  const validated = validateRealtimeProofRenderedTopology({
    rendered,
    selection: value,
    nodePort: 18_081,
    secondaryNodePort: 18_082,
    faultNodePort: 18_083,
  });
  assert.deepEqual(validated.topology, {
    nodeRealtimeLoopback: "127.0.0.1:18081",
    rustPublicPort: 8081,
    publicRealtimeOwner: "rust",
    nodeTrafficSharePercent: 0,
  });
  assert.deepEqual(validated.storageConfiguration, {
    driver: "s3",
    requiredBucketClass: "production-private",
    encryption: "AES256",
    expectedOwnerConfigured: true,
    filesystemFallback: false,
  });

  const preflight = createRealtimeProofPreflight({
    sourceState: { headSha: candidateSha, clean: true },
    selection: value,
    rendered,
    nodePort: 18_081,
    secondaryNodePort: 18_082,
    faultNodePort: 18_083,
  });
  assert.equal(preflight.sourceState.headSha, candidateSha);
  assert.deepEqual(preflight.topology, validated.topology);

  const cases = [
    [(copy) => { copy.services["node-realtime"].ports[0].host_ip = "0.0.0.0"; }, /loopback/i],
    [(copy) => { copy.services["node-realtime"].ports[0].published = "8081"; }, /Node.*port|8081/i],
    [(copy) => { copy.services["node-realtime-proof-peer"].ports[0].host_ip = "0.0.0.0"; }, /loopback/i],
    [(copy) => { copy.services["node-realtime-proof-peer"].ports[0].published = "18081"; }, /distinct|port/i],
    [(copy) => { copy.services["node-realtime-proof-s3-fault"].ports[0].host_ip = "0.0.0.0"; }, /loopback/i],
    [(copy) => { copy.services["node-realtime-proof-s3-fault"].ports[0].published = "18082"; }, /distinct|port/i],
    [(copy) => { copy.services["realtime-gateway"].ports[0].published = "18081"; }, /Rust.*8081/i],
    [(copy) => { copy.services["node-realtime"].image = "qrai/node-backend:mutable"; }, /selected.*image/i],
    [(copy) => { copy.services["node-realtime-proof-peer"].image = "qrai/node-backend:mutable"; }, /selected.*image/i],
    [(copy) => { copy.services["node-realtime-proof-s3-fault"].image = "qrai/node-backend:mutable"; }, /selected.*image/i],
    [(copy) => { copy.services["node-api"].build = { context: "." }; }, /source build/i],
    [(copy) => { copy.services["job-worker"].environment.AUDIO_STORAGE_DRIVER = "filesystem"; }, /production S3/i],
    [(copy) => { copy.services["node-realtime"].environment.AUDIO_STORAGE_S3_EXPECTED_OWNER = ""; }, /expected owner|production S3 identity/i],
    [(copy) => { copy.services["node-api"].environment.AUDIO_STORAGE_S3_BUCKET = "another-bucket"; }, /same production S3/i],
    [(copy) => { copy.services["node-realtime-proof-peer"].environment.DATABASE_URL = "postgresql://other"; }, /database authority/i],
    [(copy) => { copy.services["node-realtime-proof-peer"].environment.REALTIME_GATEWAY_TICKET_SECRET = "other"; }, /ticket authority/i],
    [(copy) => { copy.services["node-realtime-proof-peer"].environment.GATEWAY_TENANT_ID = "other"; }, /tenant authority/i],
    [(copy) => { copy.services["node-realtime-proof-s3-fault"].environment.DATABASE_URL = "postgresql://other"; }, /database authority/i],
    [(copy) => { copy.services["node-realtime-proof-s3-fault"].environment.AUDIO_STORAGE_S3_ENDPOINT = "https://s3.example.com"; }, /unreachable S3/i],
    [(copy) => { copy.services["node-realtime-proof-s3-fault"].profiles = []; }, /fault profile/i],
    [(copy) => { copy.services["node-realtime"].ports.push(copy.services["node-realtime"].ports[0]); }, /exactly one/i],
  ];
  for (const [mutate, pattern] of cases) {
    const copy = structuredClone(rendered);
    mutate(copy);
    assert.throws(
      () => validateRealtimeProofRenderedTopology({
        rendered: copy,
        selection: value,
        nodePort: 18_081,
        secondaryNodePort: 18_082,
        faultNodePort: 18_083,
      }),
      pattern,
    );
  }
  assert.throws(
    () => createRealtimeProofPreflight({
      sourceState: { headSha: candidateSha, clean: false },
      selection: value,
      rendered,
      nodePort: 18_081,
      secondaryNodePort: 18_082,
      faultNodePort: 18_083,
    }),
    /clean/i,
  );
  assert.throws(
    () => createRealtimeProofPreflight({
      sourceState: { headSha: previousSha, clean: true },
      selection: value,
      rendered,
      nodePort: 18_081,
      secondaryNodePort: 18_082,
      faultNodePort: 18_083,
    }),
    /candidate SHA/i,
  );
});

test("candidate runtime inspection proves the exact healthy non-root selected image processes", () => {
  const value = selection();
  const input = {
    sourceState: { headSha: candidateSha, clean: true },
    selection: value,
    rendered: renderedProofTopology(value),
    nodePort: 18_081,
    secondaryNodePort: 18_082,
    faultNodePort: 18_083,
    observations: candidateRunningObservations(value),
  };
  const result = probeRealtimeCandidateRunningImages(input);
  assert.deepEqual(result, {
    images: runningImages(value),
    measurements: stageMeasurements("candidate-running-images"),
  });
  assert.equal(JSON.stringify(result).includes("fixture-proof-ticket-secret"), false);
  assert.equal(JSON.stringify(result).includes("postgresql://"), false);

  const cases = [
    [(copy) => { delete copy.observations["job-worker"]; }, /exactly four|job-worker/i],
    [(copy) => { copy.observations["node-api"].running = false; }, /running/i],
    [(copy) => { copy.observations["node-api"].health = "starting"; }, /healthy/i],
    [(copy) => { copy.observations["node-api"].configuredUser = "root"; }, /non-root/i],
    [(copy) => { copy.observations["node-api"].effectiveUid = 0; }, /non-root/i],
    [(copy) => { copy.observations["node-api"].containerId = "node-api"; }, /container/i],
    [(copy) => { copy.observations["node-api"].configuredImage = copy.observations["realtime-gateway"].configuredImage; }, /selected/i],
    [(copy) => { copy.observations["node-api"].localImageId = `sha256:${"9".repeat(64)}`; }, /image content/i],
    [(copy) => { copy.observations["node-api"].repoDigests = []; }, /repository digest/i],
    [(copy) => { copy.observations["job-worker"].imageId = `sha256:${"9".repeat(64)}`; copy.observations["job-worker"].localImageId = copy.observations["job-worker"].imageId; copy.observations["job-worker"].repoDigests = [copy.observations["job-worker"].configuredImage]; }, /shared Node image/i],
    [(copy) => { copy.sourceState.clean = false; }, /clean/i],
  ];
  for (const [mutate, pattern] of cases) {
    const copy = structuredClone(input);
    mutate(copy);
    assert.throws(() => probeRealtimeCandidateRunningImages(copy), pattern);
  }
});

test("rendered topology hashing excludes credential values but still binds executable topology", () => {
  const value = selection();
  const rendered = renderedProofTopology(value);
  const baseline = validateRealtimeProofRenderedTopology({
    rendered,
    selection: value,
    nodePort: 18_081,
    secondaryNodePort: 18_082,
    faultNodePort: 18_083,
  });

  const rotatedCredentials = structuredClone(rendered);
  for (const service of [
    "node-realtime",
    "node-realtime-proof-peer",
    "node-realtime-proof-s3-fault",
  ]) {
    rotatedCredentials.services[service].environment.DATABASE_URL =
      "postgresql://quran_ai_app:rotated@postgres:5432/quran_ai";
    rotatedCredentials.services[service].environment.REALTIME_GATEWAY_TICKET_SECRET =
      "rotated-proof-ticket-secret";
  }
  assert.equal(
    validateRealtimeProofRenderedTopology({
      rendered: rotatedCredentials,
      selection: value,
      nodePort: 18_081,
      secondaryNodePort: 18_082,
      faultNodePort: 18_083,
    }).renderedSha256,
    baseline.renderedSha256,
    "credential rotation must not alter or leak into the topology digest",
  );

  const executableChange = structuredClone(rendered);
  executableChange.services["node-api"].command = ["node", "server/src/other.mjs"];
  assert.notEqual(
    validateRealtimeProofRenderedTopology({
      rendered: executableChange,
      selection: value,
      nodePort: 18_081,
      secondaryNodePort: 18_082,
      faultNodePort: 18_083,
    }).renderedSha256,
    baseline.renderedSha256,
    "an executable topology change must alter the topology digest",
  );
});

test("the actual-image transport probe returns only strict aggregate acknowledgement facts", async () => {
  const credential = realtimeProbeTicket("nonce-safe-result");
  const traceId = "trace-w3-8-proof";
  const diagnostic = `accepted-without-exposing-${credential}`;
  let receivedFrame = null;
  let receivedAsBinary = null;

  await withRealtimeProbeApp((socket) => {
    socket.once("message", (payload, isBinary) => {
      receivedFrame = Buffer.from(payload);
      receivedAsBinary = isBinary;
      socket.send(JSON.stringify({
        kind: "audio.ack",
        session_id: probeSession,
        chunk_id: "private-chunk-w3-8",
        sequence: 0,
        accepted: true,
        trace_id: traceId,
        message: diagnostic,
      }));
    });
  }, async (port) => {
    const frame = Buffer.alloc(15_360, 0x2a);
    const pending = probeRealtimeAudioFrame({
      port,
      sessionId: probeSession,
      ticket: credential,
      origin: probeOrigin,
      traceId,
      frame,
      expectedSequence: 0,
      timeoutMs: 2_000,
    });
    frame.fill(0x00);
    const result = await pending;
    assert.deepEqual(Object.keys(result).sort(), ["accepted", "ackLatencyMs", "sequence"]);
    assert.equal(result.accepted, true);
    assert.equal(result.sequence, 0);
    assert.ok(Number.isFinite(result.ackLatencyMs) && result.ackLatencyMs >= 0);
    const serialized = JSON.stringify(result);
    for (const privateValue of [credential, probeSession, probeLearner, traceId, diagnostic, "private-chunk-w3-8"]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  });

  assert.equal(receivedAsBinary, true);
  assert.deepEqual(receivedFrame, Buffer.alloc(15_360, 0x2a));
});

test("the actual-image transport probe fails closed without reflecting credentials or peer data", async () => {
  const credential = realtimeProbeTicket("nonce-safe-errors");
  const privateDiagnostic = `peer-said-${credential}-${probeLearner}`;
  const invalidPeers = [
    ["invalid acknowledgement", (socket) => socket.once("message", () => socket.send(JSON.stringify({
      kind: "audio.ack",
      session_id: probeSession,
      chunk_id: "private-chunk-invalid",
      sequence: 0,
      accepted: true,
      trace_id: null,
      message: privateDiagnostic,
      extra: true,
    })))],
    ["did not match", (socket) => socket.once("message", () => socket.send(JSON.stringify({
      kind: "audio.ack",
      session_id: "another-private-session",
      chunk_id: "private-chunk-mismatch",
      sequence: 7,
      accepted: false,
      trace_id: "another-private-trace",
      message: privateDiagnostic,
    })))],
    ["multiple acknowledgements", (socket) => socket.once("message", () => {
      const ack = JSON.stringify({
        kind: "audio.ack",
        session_id: probeSession,
        chunk_id: "private-chunk-duplicate",
        sequence: 0,
        accepted: true,
        trace_id: null,
        message: privateDiagnostic,
      });
      socket.send(ack);
      socket.send(ack);
    })],
  ];

  for (const [pattern, handler] of invalidPeers) {
    await withRealtimeProbeApp(handler, async (port) => {
      const error = await probeRealtimeAudioFrame({
        port,
        sessionId: probeSession,
        ticket: credential,
        origin: probeOrigin,
        traceId: null,
        frame: Buffer.alloc(15_360),
        expectedSequence: 0,
        timeoutMs: 2_000,
      }).then(() => null, (reason) => reason);
      assert.match(error?.message ?? "", new RegExp(pattern, "i"));
      const serialized = String(error?.stack ?? error);
      for (const privateValue of [credential, probeSession, probeLearner, privateDiagnostic, "private-chunk"]) {
        assert.equal(serialized.includes(privateValue), false, `${pattern} reflected private peer data`);
      }
    });
  }

  await withRealtimeProbeApp(() => {}, async (port) => {
    const error = await probeRealtimeAudioFrame({
      port,
      sessionId: probeSession,
      ticket: credential,
      origin: probeOrigin,
      traceId: null,
      frame: Buffer.alloc(15_360),
      expectedSequence: 0,
      timeoutMs: 50,
    }).then(() => null, (reason) => reason);
    assert.match(error?.message ?? "", /timed out/i);
    assert.equal(String(error?.stack ?? error).includes(credential), false);
  });
});

test("the transport probe target, payload, expectation, and aggregate accounting are bounded", async () => {
  const base = {
    port: 18_081,
    sessionId: probeSession,
    ticket: realtimeProbeTicket("nonce-input-bounds"),
    origin: probeOrigin,
    traceId: null,
    frame: Buffer.alloc(15_360),
    expectedSequence: 0,
    timeoutMs: 2_000,
  };
  for (const [change, pattern] of [
    [{ port: 80 }, /port/i],
    [{ sessionId: "" }, /session/i],
    [{ sessionId: ` ${probeSession}` }, /session/i],
    [{ sessionId: "s".repeat(257) }, /session/i],
    [{ ticket: "" }, /ticket/i],
    [{ ticket: "t".repeat(16 * 1024 + 1) }, /ticket/i],
    [{ origin: "http://proof.quran.example.org" }, /origin/i],
    [{ origin: "https://user:secret@proof.quran.example.org" }, /origin/i],
    [{ origin: `${probeOrigin}/path` }, /origin/i],
    [{ traceId: " " }, /trace/i],
    [{ traceId: "t".repeat(257) }, /trace/i],
    [{ frame: "not-binary" }, /binary/i],
    [{ frame: Buffer.alloc(2 * 1024 * 1024 + 64 * 1024 + 1) }, /transport/i],
    [{ expectedSequence: -1 }, /sequence/i],
    [{ timeoutMs: 49 }, /timeout/i],
  ]) {
    await assert.rejects(() => probeRealtimeAudioFrame({ ...base, ...change }), pattern);
  }

  const probes = Array.from({ length: 20 }, (_value, index) => ({
    accepted: index % 4 !== 0,
    sequence: index,
    ackLatencyMs: index + 1,
  }));
  assert.deepEqual(summarizeRealtimeAudioFrameProbes(probes), {
    framesSent: 20,
    accepted: 15,
    rejected: 5,
    lost: 0,
    uncertain: 0,
    ackP95Ms: 19,
    ackP99Ms: 20,
  });
  assert.throws(
    () => summarizeRealtimeAudioFrameProbes([{ ...probes[0], ticket: base.ticket }]),
    /exact|probe result/i,
  );
  assert.throws(
    () => summarizeRealtimeAudioFrameProbes([{ ...probes[0], ackLatencyMs: -1 }]),
    /latency/i,
  );
});

test("the upgrade refusal probe proves bodyless origin and replay refusals without consuming origin-refused tickets", async () => {
  const consumedNonces = new Set();
  const replayAuthority = {
    async claim(claims) {
      if (consumedNonces.has(claims.nonce)) return "replay";
      consumedNonces.add(claims.nonce);
      return "fresh";
    },
    renderMetrics: () => "",
    start: () => {},
    stop: async () => {},
  };
  const credential = realtimeProbeTicket("nonce-origin-then-replay");
  const disallowedOrigin = "https://disallowed.quran.example.org";

  await withRealtimeProbeApp((socket) => {
    socket.once("message", () => socket.send(JSON.stringify({
      kind: "audio.ack",
      session_id: probeSession,
      chunk_id: "private-refusal-proof-chunk",
      sequence: 0,
      accepted: true,
      trace_id: null,
      message: "accepted",
    })));
  }, async (port) => {
    const originRefusal = await probeRealtimeUpgradeRefusal({
      port,
      sessionId: probeSession,
      ticket: credential,
      origin: disallowedOrigin,
      expectedStatus: 403,
      timeoutMs: 2_000,
    });
    assert.deepEqual(originRefusal, { refused: true, statusCode: 403 });
    assert.equal(consumedNonces.size, 0, "an origin refusal consumed a single-use ticket");

    const accepted = await probeRealtimeAudioFrame({
      port,
      sessionId: probeSession,
      ticket: credential,
      origin: probeOrigin,
      traceId: null,
      frame: Buffer.alloc(15_360),
      expectedSequence: 0,
      timeoutMs: 2_000,
    });
    assert.equal(accepted.accepted, true);
    assert.equal(consumedNonces.size, 1);

    const replayRefusal = await probeRealtimeUpgradeRefusal({
      port,
      sessionId: probeSession,
      ticket: credential,
      origin: probeOrigin,
      expectedStatus: 401,
      timeoutMs: 2_000,
    });
    assert.deepEqual(replayRefusal, { refused: true, statusCode: 401 });

    for (const result of [originRefusal, replayRefusal]) {
      const serialized = JSON.stringify(result);
      for (const privateValue of [credential, probeSession, probeLearner]) {
        assert.equal(serialized.includes(privateValue), false);
      }
    }
  }, { replayAuthority });
});

test("the protocol parity stage uses server-issued single-use tickets and records only closed aggregate facts", async () => {
  const retentions = ["discard", "teacher-review", "training-opt-in"];
  const sessions = new Map();
  const ticketCalls = [];
  const frameCalls = [];
  const refusalCalls = [];
  const requests = [];
  let ticketNumber = 0;

  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    assert.equal(url.origin, "http://127.0.0.1:8080");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Origin, probeOrigin);
    assert.match(options.headers.authorization, /^Bearer /);
    assert.equal(options.headers["content-type"], "application/json");
    assert.ok(options.signal instanceof AbortSignal);

    if (url.pathname === "/v1/recitation-sessions") {
      assert.equal(Object.hasOwn(body, "modelVersion"), false);
      assert.equal(body.learnerId, probeLearner);
      assert.equal(body.language, "ckb");
      assert.equal(body.consent.recordingConsent, true);
      assert.equal(body.consent.anonymizedLearning, false);
      assert.equal(body.consent.externalAsrProcessing, false);
      assert.equal(body.consent.guardianApproved, false);
      assert.deepEqual(body.quranRef, {
        surahNumber: 1,
        ayahStart: 1,
        ayahEnd: 7,
        display: "Al-Fatihah 1:1-7",
      });
      assert.match(body.sourceChecksum, /^declared:w3\.8-realtime-production-proof:/);
      const sessionId = `private-session-${body.practicePlanId.replaceAll(".", "-")}`;
      sessions.set(sessionId, body.consent.audioRetention);
      return new Response(JSON.stringify({
        id: sessionId,
        tenantId: probeTenant,
        learnerId: probeLearner,
        consent: body.consent,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    assert.equal(url.pathname, "/v1/realtime-session-tickets");
    assert.deepEqual(body.requestedSampleRates, [16_000]);
    assert.ok(sessions.has(body.sessionId));
    ticketNumber += 1;
    const retention = sessions.get(body.sessionId);
    const ticket = [
      "rt_v2",
      body.sessionId,
      probeTenant,
      probeLearner,
      "false",
      retention,
      String(probeNowSeconds + 300),
      `private-nonce-${ticketNumber}`,
      `private-signature-${ticketNumber}`,
    ].join(".");
    ticketCalls.push({ sessionId: body.sessionId, ticket });
    return new Response(JSON.stringify({
      sessionId: body.sessionId,
      tenantId: probeTenant,
      learnerId: probeLearner,
      expiresAt: String(probeNowSeconds + 300),
      allowedSampleRates: [16_000],
      externalAsrProcessing: false,
      token: ticket,
      auditEventId: `private-audit-${ticketNumber}`,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const frameProbe = async (input) => {
    frameCalls.push(input);
    assert.equal(input.expectedSequence, 0);
    assert.equal(input.traceId, null);
    assert.equal(input.origin, probeOrigin);
    const exactProfile = input.frame.byteLength === 15_360;
    return {
      accepted: exactProfile || input.port === 8081,
      ackLatencyMs: 5,
      sequence: 0,
    };
  };
  const refusalProbe = async (input) => {
    refusalCalls.push(input);
    return { refused: true, statusCode: input.expectedStatus };
  };

  const result = await runRealtimeProtocolParityStage({
    nodePort: 18_081,
    secondaryNodePort: 18_082,
    origin: probeOrigin,
    disallowedOrigin: "https://disallowed.quran.example.org",
    jwtSecret: probeSecret,
    tenantId: probeTenant,
    learnerId: probeLearner,
    fetchImpl,
    frameProbe,
    refusalProbe,
    nowUnixSeconds: () => probeNowSeconds,
    timeoutMs: 2_000,
  });

  assert.deepEqual(result, {
    validCases: 12,
    matchedCases: 12,
    unexpectedDivergences: 0,
    nodeInvalidFrameDivergences: 4,
    ackFieldCount: 7,
    originRefusals: 2,
    replayRefusals: 2,
    crossInstanceReplayRefusals: 1,
  });
  assert.equal(sessions.size, 22);
  assert.deepEqual(new Set(sessions.values()), new Set(retentions));
  assert.equal(ticketCalls.length, 38);
  assert.equal(requests.filter(({ url }) => url.pathname === "/v1/recitation-sessions").length, 22);
  assert.equal(frameCalls.length, 38);
  assert.deepEqual(new Set(frameCalls.map(({ port }) => port)), new Set([18_081, 18_082, 8081]));
  const validFrameCalls = frameCalls.filter(({ sessionId }) => sessionId.includes("protocol-valid-"));
  assert.equal(validFrameCalls.length, 24);
  assert.deepEqual(
    [...new Set(validFrameCalls.map(({ frame }) => frame[0]))].sort((left, right) => left - right),
    [0x00, 0x55, 0xaa, 0xff],
  );
  const invalidFrameCalls = frameCalls.filter(({ sessionId }) => sessionId.includes("protocol-invalid-"));
  assert.deepEqual(
    invalidFrameCalls.map(({ frame }) => frame.byteLength),
    [1, 1, 15_359, 15_359, 15_361, 15_361, 2 * MiB, 2 * MiB],
  );
  assert.equal(
    frameCalls.filter(({ port, sessionId }) =>
      port === 18_082 && sessionId.includes("protocol-secondary-control")).length,
    1,
  );
  assert.equal(refusalCalls.length, 5);
  assert.deepEqual(refusalCalls.map(({ expectedStatus }) => expectedStatus), [403, 403, 401, 401, 401]);
  assert.equal(refusalCalls.at(-1).port, 18_082);
  for (const refusal of refusalCalls) {
    if (refusal.expectedStatus === 401) {
      assert.ok(frameCalls.some(({ ticket }) => ticket === refusal.ticket));
    }
  }

  const serialized = JSON.stringify(result);
  for (const privateValue of [
    ...ticketCalls.map(({ ticket }) => ticket),
    ...sessions.keys(),
    probeTenant,
    probeLearner,
    requests[0].options.headers.authorization,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("the parity stage fails closed on malformed issuance or unexpected wire behavior without reflecting private API data", async () => {
  const privateApiValue = "private-api-body-must-not-be-reflected";
  function validFetch({ mutateSession = (value) => value, mutateTicket = (value) => value } = {}) {
    const sessions = new Map();
    let ticketNumber = 0;
    return async (input, options) => {
      const url = new URL(input);
      const requestBody = JSON.parse(options.body);
      if (url.pathname === "/v1/recitation-sessions") {
        const session = mutateSession({
          id: `private-session-${requestBody.practicePlanId.replaceAll(".", "-")}`,
          tenantId: probeTenant,
          learnerId: probeLearner,
          consent: requestBody.consent,
        });
        sessions.set(session.id, requestBody.consent.audioRetention);
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      ticketNumber += 1;
      const retention = sessions.get(requestBody.sessionId);
      return new Response(JSON.stringify(mutateTicket({
        sessionId: requestBody.sessionId,
        tenantId: probeTenant,
        learnerId: probeLearner,
        expiresAt: String(probeNowSeconds + 300),
        allowedSampleRates: [16_000],
        externalAsrProcessing: false,
        token: [
          "rt_v2",
          requestBody.sessionId,
          probeTenant,
          probeLearner,
          "false",
          retention,
          String(probeNowSeconds + 300),
          `private-nonce-${ticketNumber}`,
          `${privateApiValue}-${ticketNumber}`,
        ].join("."),
        auditEventId: `private-audit-${ticketNumber}`,
      })), { status: 200, headers: { "content-type": "application/json" } });
    };
  }
  const base = {
    nodePort: 18_081,
    secondaryNodePort: 18_082,
    origin: probeOrigin,
    disallowedOrigin: "https://disallowed.quran.example.org",
    jwtSecret: probeSecret,
    tenantId: probeTenant,
    learnerId: probeLearner,
    nowUnixSeconds: () => probeNowSeconds,
    timeoutMs: 2_000,
    refusalProbe: async ({ expectedStatus }) => ({ refused: true, statusCode: expectedStatus }),
    frameProbe: async ({ frame, port }) => ({
      accepted: frame.byteLength === 15_360 || port === 8081,
      ackLatencyMs: 1,
      sequence: 0,
    }),
  };

  const invalidResponse = async () => new Response(JSON.stringify({ error: privateApiValue }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
  const apiError = await runRealtimeProtocolParityStage({
    ...base,
    fetchImpl: invalidResponse,
  }).then(() => null, (reason) => reason);
  assert.match(apiError?.message ?? "", /session issuance failed/i);
  assert.equal(String(apiError?.stack ?? apiError).includes(privateApiValue), false);

  for (const body of ["{", JSON.stringify({ privateApiValue: privateApiValue.repeat(4_096) })]) {
    const error = await runRealtimeProtocolParityStage({
      ...base,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }).then(() => null, (reason) => reason);
    assert.match(error?.message ?? "", /session issuance failed/i);
    assert.equal(String(error?.stack ?? error).includes(privateApiValue), false);
  }

  for (const mutateTicket of [
    (value) => ({ ...value, allowedSampleRates: [48_000] }),
    (value) => ({ ...value, expiresAt: String(probeNowSeconds) }),
    (value) => ({ ...value, expiresAt: `0${probeNowSeconds + 300}` }),
    (value) => ({ ...value, tenantId: "private-wrong-tenant" }),
    (value) => ({ ...value, token: "rt_v2.private-incomplete-ticket" }),
    (value) => ({
      ...value,
      token: [
        "rt_v2",
        "private-session",
        probeTenant,
        probeLearner,
        "false",
        "discard",
        String(probeNowSeconds + 300),
        "private-nonce",
        "x".repeat(16 * 1024),
      ].join("."),
    }),
    (value) => ({ ...value, extraPrivateField: privateApiValue }),
  ]) {
    const error = await runRealtimeProtocolParityStage({
      ...base,
      fetchImpl: validFetch({ mutateTicket }),
    }).then(() => null, (reason) => reason);
    assert.match(error?.message ?? "", /ticket issuance failed/i);
    assert.equal(String(error?.stack ?? error).includes(privateApiValue), false);
  }

  await assert.rejects(
    () => runRealtimeProtocolParityStage({
      ...base,
      fetchImpl: invalidResponse,
      nodePort: 8081,
    }),
    /Node.*Rust|port/i,
  );
  await assert.rejects(
    () => runRealtimeProtocolParityStage({
      ...base,
      fetchImpl: invalidResponse,
      secondaryNodePort: 18_081,
    }),
    /secondary.*distinct|port/i,
  );
  await assert.rejects(
    () => runRealtimeProtocolParityStage({
      ...base,
      fetchImpl: invalidResponse,
      disallowedOrigin: probeOrigin,
    }),
    /disallowed.*distinct|origin/i,
  );
  await assert.rejects(
    () => runRealtimeProtocolParityStage({
      ...base,
      fetchImpl: validFetch(),
      frameProbe: async () => ({ accepted: false, ackLatencyMs: 1, sequence: 0 }),
    }),
    /valid wire behavior diverged/i,
  );
  await assert.rejects(
    () => runRealtimeProtocolParityStage({
      ...base,
      fetchImpl: validFetch(),
      frameProbe: async () => ({ accepted: true, ackLatencyMs: 1, sequence: 0 }),
    }),
    /invalid-frame divergence/i,
  );
  await assert.rejects(
    () => runRealtimeProtocolParityStage({
      ...base,
      fetchImpl: validFetch(),
      frameProbe: async ({ frame, port }) => ({
        accepted: port !== 18_082 && (frame.byteLength === 15_360 || port === 8081),
        ackLatencyMs: 1,
        sequence: 0,
      }),
    }),
    /secondary Node control/i,
  );
  await assert.rejects(
    () => runRealtimeProtocolParityStage({
      ...base,
      fetchImpl: validFetch(),
      refusalProbe: async () => ({ refused: true, statusCode: 401 }),
    }),
    /refusal was not proven/i,
  );
});

function nodeProcessFaultHarness({ failAt = null, mutation = {} } = {}) {
  const calls = [];
  const timers = [];
  const boundaries = [];
  const issuedByProof = new Map();
  const reports = [];
  let healthy = true;
  let killCount = 0;
  let readinessCount = 0;
  let startCount = 0;

  const fail = (name) => {
    calls.push(name);
    if (failAt === name) throw new Error(`private-${name}-failure`);
  };
  const sessionFor = (proofId) => proofId.includes("ambiguous")
    ? "private-node-ambiguous-session"
    : "private-node-clean-session";

  const issuer = {
    async issue(proofId) {
      fail(`issue-${proofId}`);
      const count = (issuedByProof.get(proofId) ?? 0) + 1;
      issuedByProof.set(proofId, count);
      return {
        sessionId: sessionFor(proofId),
        ticket: mutation.duplicateCleanTicket && proofId === "node-process-clean"
          ? `private-${proofId}-ticket-1`
          : `private-${proofId}-ticket-${count}`,
      };
    },
    async finalize(sessionId, report) {
      fail(`finalize-${report.state}`);
      reports.push(structuredClone(report));
      const expected = report.state === "complete"
        ? {
            recordingStatus: "complete",
            clientDroppedChunkCount: 0,
            clientUncertainChunkCount: 0,
            serverLostChunkCount: 0,
          }
        : {
            recordingStatus: "incomplete",
            clientDroppedChunkCount: 1,
            clientUncertainChunkCount: 1,
            serverLostChunkCount: 0,
          };
      assert.equal(sessionId, report.state === "complete"
        ? "private-node-clean-session"
        : "private-node-ambiguous-session");
      return { ...expected, ...(mutation.finalization?.[report.state] ?? {}) };
    },
  };

  const createSocketBoundary = ({ origin }) => {
    assert.equal(origin, probeOrigin);
    let suppressed = false;
    let transmitted = 0;
    let acknowledged = 0;
    const peers = new Set();
    const boundary = {
      openSocket(url, handlers) {
        fail("open-socket");
        if (!healthy) throw new Error("private-node-process-unavailable");
        const endpoint = new URL(url);
        const parts = endpoint.pathname.split("/").filter(Boolean);
        const sessionId = decodeURIComponent(parts[2]);
        const peer = {
          closed: false,
          close() {
            if (peer.closed) return;
            peer.closed = true;
            peers.delete(peer);
          },
          send() {
            fail("send-frame");
            transmitted += 1;
            if (suppressed) return;
            const sequence = acknowledged;
            acknowledged += 1;
            handlers.onMessage(JSON.stringify({
              kind: "audio.ack",
              session_id: sessionId,
              chunk_id: `${sessionId}-ws-${String(sequence).padStart(4, "0")}`,
              sequence,
              accepted: true,
              trace_id: null,
              message: "accepted",
            }));
          },
          drop() {
            if (peer.closed) return;
            peer.closed = true;
            peers.delete(peer);
            handlers.onClose();
          },
        };
        peers.add(peer);
        handlers.onOpen();
        return peer;
      },
      suppressAcknowledgements() {
        suppressed = true;
      },
      snapshot() {
        return mutation.socketSnapshot ?? { transmitted };
      },
      closeAll() {
        for (const peer of [...peers]) peer.close();
      },
      dropAll() {
        for (const peer of [...peers]) peer.drop();
      },
    };
    boundaries.push(boundary);
    return boundary;
  };

  const schedule = (fn, delayMs) => {
    const timer = { fn, delayMs, active: true };
    timers.push(timer);
    return timer;
  };
  const cancelSchedule = (timer) => {
    timer.active = false;
  };
  const runScheduled = () => {
    for (const timer of timers.filter((value) => value.active)) {
      timer.active = false;
      timer.fn();
    }
  };

  return {
    boundaries,
    calls,
    issuedByProof,
    reports,
    input: {
      nodePort: 18_081,
      origin: probeOrigin,
      jwtSecret: probeSecret,
      tenantId: probeTenant,
      learnerId: probeLearner,
      timeoutMs: 2_000,
      issuer,
      createSocketBoundary,
      schedule,
      cancelSchedule,
      random: () => 0,
      waitForCondition: async (predicate) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setImmediate(resolve));
        }
        throw new Error("private-node-condition-timeout");
      },
      readinessProbe: async () => {
        fail("readiness");
        const fallback = healthy
          ? { ready: true, reachable: true, statusCode: 200 }
          : { ready: false, reachable: false, statusCode: null };
        const result = mutation.readiness?.[readinessCount] ?? fallback;
        readinessCount += 1;
        return result;
      },
      killNodeProcess: async () => {
        killCount += 1;
        fail(`kill-node-${killCount}`);
        healthy = false;
        for (const boundary of boundaries) boundary.dropAll();
        return mutation.kill ?? { killed: true };
      },
      startNodeProcess: async () => {
        startCount += 1;
        fail(`start-node-${startCount}`);
        healthy = true;
        runScheduled();
        return mutation.start ?? { healthy: true };
      },
    },
  };
}

test("the Node process fault proves clean reconnect and an unreplayed ambiguous tail", async () => {
  const harness = nodeProcessFaultHarness();
  const result = await runRealtimeNodeProcessFaultProbe(harness.input);
  assert.deepEqual(result, faultProbeResults().nodeProcess);
  assert.equal(harness.calls.filter((value) => value.startsWith("kill-node-")).length, 2);
  assert.equal(harness.calls.filter((value) => value.startsWith("start-node-")).length, 2);
  assert.equal(harness.issuedByProof.get("node-process-clean") >= 2, true);
  assert.equal(harness.issuedByProof.get("node-process-ambiguous"), 1);
  assert.deepEqual(harness.reports, [
    {
      version: 1,
      state: "complete",
      capturedChunks: 2,
      acknowledgedChunks: 2,
      droppedChunks: 0,
      uncertainChunks: 0,
      stopReason: "completed",
    },
    {
      version: 1,
      state: "degraded",
      capturedChunks: 2,
      acknowledgedChunks: 0,
      droppedChunks: 1,
      uncertainChunks: 1,
      stopReason: "ack-ambiguous",
    },
  ]);
  assert.deepEqual(harness.boundaries.map((value) => value.snapshot().transmitted), [2, 1]);
  for (const privateValue of [
    "private-node-clean-session",
    "private-node-ambiguous-session",
    "private-node-process-clean-ticket",
    probeTenant,
    probeLearner,
  ]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test("the Node process fault obtains fresh API tickets and submits both exact recovery reports", async () => {
  const harness = nodeProcessFaultHarness();
  const requests = [];
  const sessions = new Map();
  let nextSession = 0;
  let nextTicket = 0;
  delete harness.input.issuer;
  harness.input.nowUnixSeconds = () => probeNowSeconds;
  harness.input.fetchImpl = async (input, options) => {
    const url = new URL(input);
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    if (url.pathname === "/v1/recitation-sessions") {
      const proofId = body.sourceChecksum.split(":").at(-1);
      const sessionId = `private-api-node-session-${++nextSession}`;
      sessions.set(sessionId, proofId);
      return new Response(JSON.stringify({
        id: sessionId,
        tenantId: probeTenant,
        learnerId: probeLearner,
        consent: { audioRetention: "discard" },
      }));
    }
    if (url.pathname === "/v1/realtime-session-tickets") {
      assert.equal(sessions.has(body.sessionId), true);
      nextTicket += 1;
      return new Response(JSON.stringify({
        sessionId: body.sessionId,
        tenantId: probeTenant,
        learnerId: probeLearner,
        expiresAt: String(probeNowSeconds + 300),
        allowedSampleRates: [16_000],
        externalAsrProcessing: false,
        token: `rt_v2.a.b.c.d.e.f.${nextTicket}.h`,
        auditEventId: `private-audit-${nextTicket}`,
      }));
    }
    if (/^\/v1\/recitation-sessions\/[^/]+\/finalize$/.test(url.pathname)) {
      const sessionId = decodeURIComponent(url.pathname.split("/")[3]);
      assert.equal(sessions.has(sessionId), true);
      const report = body.recoveryReport;
      return new Response(JSON.stringify({
        finalized: false,
        recordingStatus: report.state === "complete" ? "complete" : "incomplete",
        clientDroppedChunkCount: report.droppedChunks,
        clientUncertainChunkCount: report.uncertainChunks,
        serverLostChunkCount: 0,
      }));
    }
    assert.fail(`unexpected process-fault API path ${url.pathname}`);
  };

  const result = await runRealtimeNodeProcessFaultProbe(harness.input);
  assert.deepEqual(result, faultProbeResults().nodeProcess);
  assert.equal(requests.filter(({ url }) => url.pathname === "/v1/recitation-sessions").length, 2);
  assert.equal(requests.filter(({ url }) => url.pathname === "/v1/realtime-session-tickets").length >= 3, true);
  const finalizations = requests.filter(({ url }) => url.pathname.endsWith("/finalize"));
  assert.deepEqual(finalizations.map(({ body }) => body.recoveryReport), [
    {
      version: 1,
      state: "complete",
      capturedChunks: 2,
      acknowledgedChunks: 2,
      droppedChunks: 0,
      uncertainChunks: 0,
      stopReason: "completed",
    },
    {
      version: 1,
      state: "degraded",
      capturedChunks: 2,
      acknowledgedChunks: 0,
      droppedChunks: 1,
      uncertainChunks: 1,
      stopReason: "ack-ambiguous",
    },
  ]);
  assert.equal(finalizations.length, 2);
  assert.equal(requests.every(({ options }) => /^Bearer [^.]+\.[^.]+\.[^.]+$/.test(
    options.headers.authorization,
  )), true);
});

test("the Node process fault fails closed on lifecycle, readiness, finalization, and transport lies", async () => {
  const cases = [
    { mutation: { kill: { killed: false } }, restorationExpected: true },
    { mutation: { start: { healthy: false } }, restorationExpected: true },
    {
      mutation: { finalization: { complete: { recordingStatus: "incomplete" } } },
      restorationExpected: true,
    },
    {
      mutation: { finalization: { degraded: { recordingStatus: "complete" } } },
      restorationExpected: true,
    },
    {
      mutation: { finalization: { degraded: { serverLostChunkCount: 1 } } },
      restorationExpected: true,
    },
    {
      mutation: {
        readiness: {
          1: { ready: false, reachable: true, statusCode: 503 },
        },
      },
      restorationExpected: true,
    },
    { mutation: { duplicateCleanTicket: true }, restorationExpected: true },
    { mutation: { socketSnapshot: { transmitted: -1 } }, restorationExpected: true },
    { failAt: "readiness", restorationExpected: false },
    { failAt: "kill-node-1", restorationExpected: true },
    { failAt: "send-frame", restorationExpected: false },
  ];
  for (const values of cases) {
    const harness = nodeProcessFaultHarness(values);
    await assert.rejects(
      () => runRealtimeNodeProcessFaultProbe(harness.input),
      (error) => error.message === "realtime Node process fault probe failed" &&
        !String(error).includes("private-"),
    );
    if (values.restorationExpected) {
      assert.equal(
        harness.calls.some((value) => value.startsWith("start-node-")),
        true,
        "failure path did not attempt Node process restoration",
      );
    }
  }
});

function postgresFaultHarness({ failAt = null, mutation = null } = {}) {
  const calls = [];
  let readinessCall = 0;
  const tickets = [
    { sessionId: "private-postgres-session", ticket: "private-postgres-ticket" },
    { sessionId: "private-postgres-fresh-session", ticket: "private-postgres-fresh-ticket" },
  ];
  const maybeFail = (name) => {
    calls.push(name);
    if (failAt === name) throw new Error(`private-${name}-failure`);
  };
  const input = {
    nodePort: 18_081,
    origin: probeOrigin,
    jwtSecret: probeSecret,
    tenantId: probeTenant,
    learnerId: probeLearner,
    timeoutMs: 2_000,
    issuer: {
      issue: async (proofId) => {
        maybeFail(`issue-${proofId}`);
        return tickets.shift();
      },
    },
    readinessProbe: async ({ port, timeoutMs }) => {
      maybeFail(`readiness-${readinessCall}`);
      assert.equal(port, 18_081);
      assert.equal(timeoutMs, 2_000);
      const values = [
        { ready: true, statusCode: 200 },
        { ready: false, statusCode: 503 },
        { ready: true, statusCode: 200 },
      ];
      return values[readinessCall++];
    },
    stopPostgres: async () => {
      maybeFail("stop-postgres");
      return mutation?.stop ?? { stopped: true };
    },
    startPostgres: async () => {
      maybeFail("start-postgres");
      return mutation?.start ?? { healthy: true };
    },
    refusalProbe: async ({ ticket }) => {
      maybeFail("refusal");
      assert.equal(ticket, "private-postgres-ticket");
      return mutation?.refusal ?? { refused: true, statusCode: 503 };
    },
    frameProbe: async ({ ticket, expectedSequence }) => {
      maybeFail("frame");
      assert.equal(expectedSequence, 0);
      assert.equal(
        new Set(["private-postgres-ticket", "private-postgres-fresh-ticket"]).has(ticket),
        true,
      );
      return mutation?.frame ?? { accepted: true, ackLatencyMs: 3, sequence: 0 };
    },
  };
  return { calls, input };
}

test("the Postgres fault refuses upgrades, preserves the ticket, restores health, and accepts fresh work", async () => {
  const harness = postgresFaultHarness();
  const result = await runRealtimePostgresFaultProbe(harness.input);
  assert.deepEqual(result, faultProbeResults().postgres);
  assert.deepEqual(harness.calls, [
    "readiness-0",
    "issue-postgres-outage-unconsumed",
    "stop-postgres",
    "readiness-1",
    "refusal",
    "refusal",
    "start-postgres",
    "readiness-2",
    "frame",
    "issue-postgres-outage-fresh",
    "frame",
  ]);
  for (const privateValue of [
    "private-postgres-session",
    "private-postgres-ticket",
    probeTenant,
    probeLearner,
  ]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test("the readiness probe is loopback-only, bounded, bodyless, and generic on transport failure", async () => {
  const cancelled = [];
  const requested = [];
  for (const status of [200, 503]) {
    const result = await probeRealtimeReadiness({
      port: 18_081,
      timeoutMs: 2_000,
      fetchImpl: async (url, options) => {
        requested.push([url, options]);
        return {
          status,
          body: { cancel: async () => { cancelled.push(status); } },
        };
      },
    });
    assert.deepEqual(result, { ready: status === 200, statusCode: status });
  }
  assert.deepEqual(cancelled, [200, 503]);
  assert.equal(requested.every(([url]) => url === "http://127.0.0.1:18081/ready"), true);
  assert.equal(requested.every(([, options]) => options.method === "GET"), true);
  await assert.rejects(
    () => probeRealtimeReadiness({
      port: 18_081,
      timeoutMs: 2_000,
      fetchImpl: async () => { throw new Error("private-readiness-body"); },
    }),
    (error) => error.message === "realtime readiness probe failed" &&
      !String(error).includes("private-readiness-body"),
  );
});

test("the process readiness probe distinguishes a reachable refusal from a killed endpoint", async () => {
  assert.deepEqual(
    await probeRealtimeProcessReadiness({
      port: 18_081,
      timeoutMs: 2_000,
      fetchImpl: async () => ({ status: 503, body: { cancel: async () => {} } }),
    }),
    { ready: false, reachable: true, statusCode: 503 },
  );
  assert.deepEqual(
    await probeRealtimeProcessReadiness({
      port: 18_081,
      timeoutMs: 2_000,
      fetchImpl: async () => { throw new Error("private-killed-process"); },
    }),
    { ready: false, reachable: false, statusCode: null },
  );
  await assert.rejects(
    () => probeRealtimeProcessReadiness({
      port: 18_081,
      timeoutMs: 2_000,
      fetchImpl: async () => ({ status: "private-invalid-status" }),
    }),
    (error) => error.message === "realtime process readiness probe failed" &&
      !String(error).includes("private-"),
  );
});

test("the Postgres fault fails closed on lifecycle/probe lies and always attempts restoration", async () => {
  const mutations = [
    { mutation: { stop: { stopped: false } } },
    { mutation: { start: { healthy: false } } },
    { mutation: { refusal: { refused: true, statusCode: 401 } } },
    { mutation: { frame: { accepted: false, ackLatencyMs: 3, sequence: 0 } } },
    { failAt: "refusal" },
  ];
  for (const values of mutations) {
    const harness = postgresFaultHarness(values);
    await assert.rejects(
      () => runRealtimePostgresFaultProbe(harness.input),
      (error) => error.message === "realtime Postgres fault probe failed" &&
        !String(error).includes("private-"),
    );
    assert.equal(
      harness.calls.filter((value) => value === "start-postgres").length >= 1,
      true,
      "failure path did not attempt database restoration",
    );
  }
});

test("the retention stage proves all three claims-derived modes with scoped cleanup and aggregate-only output", async () => {
  const sessions = new Map();
  const requests = [];
  const frameCalls = [];
  const observationCalls = [];
  const cleanupCalls = [];
  async function fetchImpl(input, options) {
    const url = new URL(input);
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.pathname === "/v1/recitation-sessions") {
      const sessionId = `private-retention-${body.consent.audioRetention}`;
      sessions.set(sessionId, body.consent.audioRetention);
      return new Response(JSON.stringify({
        id: sessionId,
        tenantId: probeTenant,
        learnerId: probeLearner,
        consent: body.consent,
      }), { status: 200 });
    }
    if (url.pathname === "/v1/realtime-session-tickets") {
      const retention = sessions.get(body.sessionId);
      const expiresAt = probeNowSeconds + 300;
      return new Response(JSON.stringify({
        sessionId: body.sessionId,
        tenantId: probeTenant,
        learnerId: probeLearner,
        expiresAt: String(expiresAt),
        allowedSampleRates: [16_000],
        externalAsrProcessing: false,
        token: issueRealtimeTicket({
          sessionId: body.sessionId,
          tenantId: probeTenant,
          learnerId: probeLearner,
          externalAsrProcessing: false,
          audioRetention: retention,
          expiresAtUnixSeconds: BigInt(expiresAt),
          nonce: `nonce-${retention}`,
        }, probeSecret),
        auditEventId: `private-audit-${retention}`,
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }

  const result = await runRealtimeRetentionStage({
    nodePort: 18_081,
    origin: probeOrigin,
    jwtSecret: probeSecret,
    tenantId: probeTenant,
    learnerId: probeLearner,
    fetchImpl,
    frameProbe: async (input) => {
      frameCalls.push(input);
      return { accepted: true, ackLatencyMs: 1, sequence: 0 };
    },
    observationProbe: async (input) => {
      observationCalls.push(input);
      const retained = input.audioRetention !== "discard";
      return {
        objectCount: 1,
        indexCount: retained ? 1 : 0,
        metadataMatches: true,
        audioMatches: true,
        playable: retained,
      };
    },
    cleanupProbe: async (input) => {
      cleanupCalls.push(input);
      return {
        discardObjects: 0,
        teacherReviewObjects: 1,
        trainingOptInObjects: 1,
      };
    },
    nowUnixSeconds: () => probeNowSeconds,
    timeoutMs: 100,
  });

  assert.deepEqual(result, {
    retentionModesTested: 3,
    discardObjectsAfterCleanup: 0,
    teacherReviewPlayable: 1,
    trainingOptInRetained: 1,
    metadataMismatches: 0,
    indexMismatches: 0,
    privacyLeaks: 0,
  });
  assert.equal(sessions.size, 3);
  assert.equal(requests.filter(({ url }) => url.pathname === "/v1/recitation-sessions").length, 3);
  assert.equal(requests.filter(({ url }) => url.pathname === "/v1/realtime-session-tickets").length, 3);
  assert.equal(frameCalls.length, 3);
  assert.ok(frameCalls.every(({ port, frame }) => port === 18_081 && frame.byteLength === 15_360));
  assert.deepEqual(
    observationCalls.map(({ audioRetention }) => audioRetention),
    ["discard", "teacher-review", "training-opt-in"],
  );
  assert.ok(observationCalls.every(({ chunkId, expectedAudioSha256 }) =>
    chunkId.endsWith("-ws-0000") && /^[a-f0-9]{64}$/.test(expectedAudioSha256)));
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].objects.length, 3);
  assert.equal(JSON.stringify(result).includes("private-"), false);
});

test("the retention stage fails closed on rejected audio, false observations, cleanup lies, and private adapter errors", async () => {
  const sessions = new Map();
  let ticketIndex = 0;
  async function fetchImpl(input, options) {
    const url = new URL(input);
    const body = JSON.parse(options.body);
    if (url.pathname === "/v1/recitation-sessions") {
      const sessionId = `private-retention-${body.practicePlanId}`;
      sessions.set(sessionId, body.consent.audioRetention);
      return new Response(JSON.stringify({
        id: sessionId,
        tenantId: probeTenant,
        learnerId: probeLearner,
        consent: body.consent,
      }), { status: 200 });
    }
    const retention = sessions.get(body.sessionId);
    const expiresAt = probeNowSeconds + 300;
    const nonce = `nonce-retention-failure-${ticketIndex++}`;
    return new Response(JSON.stringify({
      sessionId: body.sessionId,
      tenantId: probeTenant,
      learnerId: probeLearner,
      expiresAt: String(expiresAt),
      allowedSampleRates: [16_000],
      externalAsrProcessing: false,
      token: issueRealtimeTicket({
        sessionId: body.sessionId,
        tenantId: probeTenant,
        learnerId: probeLearner,
        externalAsrProcessing: false,
        audioRetention: retention,
        expiresAtUnixSeconds: BigInt(expiresAt),
        nonce,
      }, probeSecret),
      auditEventId: `private-audit-${nonce}`,
    }), { status: 200 });
  }
  const goodObservation = async ({ audioRetention }) => ({
    objectCount: 1,
    indexCount: audioRetention === "discard" ? 0 : 1,
    metadataMatches: true,
    audioMatches: true,
    playable: audioRetention !== "discard",
  });
  const goodCleanup = async () => ({
    discardObjects: 0,
    teacherReviewObjects: 1,
    trainingOptInObjects: 1,
  });
  const base = {
    nodePort: 18_081,
    origin: probeOrigin,
    jwtSecret: probeSecret,
    tenantId: probeTenant,
    learnerId: probeLearner,
    fetchImpl,
    frameProbe: async () => ({ accepted: true, ackLatencyMs: 1, sequence: 0 }),
    observationProbe: goodObservation,
    cleanupProbe: goodCleanup,
    nowUnixSeconds: () => probeNowSeconds,
    timeoutMs: 100,
  };
  const privateValue = `private-${probeLearner}-${realtimeProbeTicket("retention-error")}`;
  const cases = [
    { frameProbe: async () => ({ accepted: false, ackLatencyMs: 1, sequence: 0 }) },
    { observationProbe: async () => ({ ...(await goodObservation({ audioRetention: "discard" })), objectCount: 2 }) },
    { observationProbe: async () => ({ ...(await goodObservation({ audioRetention: "teacher-review" })), metadataMatches: false }) },
    { cleanupProbe: async () => ({ ...(await goodCleanup()), discardObjects: 1 }) },
    { observationProbe: async () => { throw new Error(privateValue); } },
  ];
  for (const overrides of cases) {
    await assert.rejects(
      () => runRealtimeRetentionStage({ ...base, ...overrides }),
      (error) => {
        assert.match(String(error), /realtime retention stage/i);
        assert.equal(String(error?.stack ?? error).includes(privateValue), false);
        return true;
      },
    );
  }
});

test("retention proof adapters inspect exact S3 bytes and RLS index truth, then scope cleanup to discard", async () => {
  const records = new Map();
  const deleted = [];
  const closed = [];
  const modes = ["discard", "teacher-review", "training-opt-in"];
  for (const audioRetention of modes) {
    const sessionId = `private-adapter-${audioRetention}`;
    const chunkId = `${sessionId}-ws-0000`;
    const audioBytes = Buffer.alloc(15_360);
    records.set(chunkId, {
      tenantId: probeTenant,
      learnerId: probeLearner,
      sessionId,
      chunkId,
      startMs: 0,
      endMs: 480,
      sampleRate: 16_000,
      audioRetention,
      audioSize: audioBytes.length,
      audioSha256: createHash("sha256").update(audioBytes).digest("hex"),
      objectKey: `audio/v1/${probeTenant}/${probeLearner}/${sessionId}/${chunkId}.pcm`,
      storedAt: "2026-08-10T00:00:00.000Z",
      audioBytes,
    });
  }
  const store = {
    async listSession({ sessionId }) {
      return [...records.values()]
        .filter((record) => record.sessionId === sessionId)
        .map(({ tenantId, learnerId, sessionId: id, chunkId, objectKey }) => ({
          tenantId,
          learnerId,
          sessionId: id,
          chunkId,
          objectKey,
        }));
    },
    async get({ chunkId }) {
      const value = records.get(chunkId);
      if (!value) throw new Error("private missing object");
      return value;
    },
    async deleteObject({ chunkId }) {
      deleted.push(chunkId);
      records.delete(chunkId);
    },
    async close() { closed.push("store"); },
  };
  const db = {
    withTenant() {},
    async end() { closed.push("db"); },
  };
  const inspected = [];
  const adapters = createRealtimeRetentionProofAdapters({
    store,
    db,
    inspectIndex: async ({ db: selectedDb, input }) => {
      assert.equal(selectedDb, db);
      inspected.push(input);
      return { status: input.audioRetention === "discard" ? "missing" : "already-indexed" };
    },
    sweep: async ({ store: scopedStore }) => {
      const candidates = await scopedStore.listAll();
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].audioRetention, "discard");
      await scopedStore.deleteObject(candidates[0]);
      return { scannedCount: 1, deletedCount: 1, unreadableCount: 0 };
    },
  });
  const descriptors = [];
  for (const audioRetention of modes) {
    const sessionId = `private-adapter-${audioRetention}`;
    const input = {
      tenantId: probeTenant,
      learnerId: probeLearner,
      sessionId,
      chunkId: `${sessionId}-ws-0000`,
      audioRetention,
      expectedAudioBytes: 15_360,
      expectedAudioSha256: createHash("sha256").update(Buffer.alloc(15_360)).digest("hex"),
      expectedSampleRate: 16_000,
      expectedStartMs: 0,
      expectedEndMs: 480,
      timeoutMs: 100,
    };
    descriptors.push(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "timeoutMs")));
    assert.deepEqual(await adapters.observationProbe(input), {
      objectCount: 1,
      indexCount: audioRetention === "discard" ? 0 : 1,
      metadataMatches: true,
      audioMatches: true,
      playable: audioRetention !== "discard",
    });
  }
  assert.equal(inspected.length, 3);
  assert.deepEqual(await adapters.cleanupProbe({ objects: descriptors, timeoutMs: 100 }), {
    discardObjects: 0,
    teacherReviewObjects: 1,
    trainingOptInObjects: 1,
  });
  assert.deepEqual(deleted, ["private-adapter-discard-ws-0000"]);
  await adapters.close();
  await adapters.close();
  assert.deepEqual(closed.sort(), ["db", "store"]);
});

test("retention proof adapters fail their measurements on extra objects, metadata drift, index drift, or cleanup lies", async () => {
  const record = {
    tenantId: probeTenant,
    learnerId: probeLearner,
    sessionId: "private-adapter-failure",
    chunkId: "private-adapter-failure-ws-0000",
    startMs: 0,
    endMs: 480,
    sampleRate: 16_000,
    audioRetention: "teacher-review",
    audioSize: 15_360,
    audioSha256: createHash("sha256").update(Buffer.alloc(15_360)).digest("hex"),
    objectKey: `audio/v1/${probeTenant}/${probeLearner}/private-adapter-failure/private-adapter-failure-ws-0000.pcm`,
    storedAt: "2026-08-10T00:00:00.000Z",
    audioBytes: Buffer.alloc(15_360),
  };
  const input = {
    tenantId: probeTenant,
    learnerId: probeLearner,
    sessionId: record.sessionId,
    chunkId: record.chunkId,
    audioRetention: record.audioRetention,
    expectedAudioBytes: 15_360,
    expectedAudioSha256: record.audioSha256,
    expectedSampleRate: 16_000,
    expectedStartMs: 0,
    expectedEndMs: 480,
    timeoutMs: 100,
  };
  const db = { withTenant() {}, async end() {} };
  function adapters(overrides = {}) {
    return createRealtimeRetentionProofAdapters({
      store: {
        listSession: async () => [record],
        get: async () => record,
        deleteObject: async () => {},
        close: async () => {},
        ...overrides.store,
      },
      db,
      inspectIndex: overrides.inspectIndex ?? (async () => ({ status: "already-indexed" })),
      sweep: overrides.sweep ?? (async () => ({ scannedCount: 1, deletedCount: 1, unreadableCount: 0 })),
    });
  }
  assert.equal((await adapters({
    store: { listSession: async () => [record, { ...record, chunkId: "extra" }] },
  }).observationProbe(input)).objectCount, 2);
  assert.equal((await adapters({
    store: { get: async () => ({ ...record, sampleRate: 24_000 }) },
  }).observationProbe(input)).metadataMatches, false);
  assert.equal((await adapters({
    store: { get: async () => ({ ...record, audioBytes: Buffer.alloc(15_360, 1) }) },
  }).observationProbe(input)).audioMatches, false);
  await assert.rejects(
    () => adapters({ inspectIndex: async () => ({ status: "invented" }) }).observationProbe(input),
    /index/i,
  );
  await assert.rejects(
    () => adapters({ sweep: async () => ({ scannedCount: 1, deletedCount: 0, unreadableCount: 0 }) })
      .cleanupProbe({
        objects: ["discard", "teacher-review", "training-opt-in"].map((audioRetention) => ({
          ...input,
          sessionId: `${record.sessionId}-${audioRetention}`,
          chunkId: `${record.chunkId}-${audioRetention}`,
          audioRetention,
        })),
        timeoutMs: 100,
      }),
    /cleanup/i,
  );
});

test("the capacity cohort holds 100 exact-profile sessions, refuses 101, and closes every peer", async () => {
  const sessions = Array.from({ length: 100 }, (_, index) => {
    const sessionId = `private-capacity-session-${index}`;
    return {
      sessionId,
      ticket: realtimeProbeTicket(`private-capacity-nonce-${index}`, sessionId),
    };
  });
  const refusedSessionId = "private-capacity-session-101";
  const refused = {
    sessionId: refusedSessionId,
    ticket: realtimeProbeTicket("private-capacity-nonce-101", refusedSessionId),
  };
  let stored = 0;

  await withRealtimeProbeApp(null, async (port, app) => {
    const result = await probeRealtimeCapacityCohort({
      port,
      sessions,
      refusedSession: refused,
      origin: probeOrigin,
      traceId: "private-capacity-trace",
      frame: Buffer.alloc(15_360, 41),
      timeoutMs: 10_000,
    });
    assert.equal(result.sessionsAccepted, 100);
    assert.equal(result.sessionsRefused, 1);
    assert.equal(result.session101Refused, true);
    assert.ok(result.ackP95Ms >= 0 && result.ackP95Ms < 250);
    assert.deepEqual(Object.keys(result).sort(), [
      "ackP95Ms",
      "session101Refused",
      "sessionsAccepted",
      "sessionsRefused",
    ]);
    assert.equal(stored, 100);

    let metrics;
    const drainDeadline = performance.now() + 2_000;
    do {
      metrics = await app.inject({ method: "GET", url: "/metrics" });
      if (/realtime_audio_active_sessions 0(?:\n|$)/.test(metrics.body)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    } while (performance.now() < drainDeadline);
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.body, /realtime_audio_active_sessions 0(?:\n|$)/);
    assert.match(metrics.body, /realtime_audio_retained_chunks 0(?:\n|$)/);
    assert.match(metrics.body, /realtime_audio_retained_bytes 0(?:\n|$)/);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      probeTenant,
      probeLearner,
      "private-capacity-trace",
      ...sessions.flatMap(({ sessionId, ticket }) => [sessionId, ticket]),
      refused.sessionId,
      refused.ticket,
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  }, {
    audioObjectStore: {
      assertReady: async () => {},
      close: async () => {},
      put: async () => {
        stored += 1;
        return { created: true };
      },
    },
  });
});

test("the capacity cohort rejects unsafe inputs and never reflects credential-bearing peer data", async () => {
  const sessions = Array.from({ length: 100 }, (_, index) => {
    const sessionId = `private-mutation-session-${index}`;
    return {
      sessionId,
      ticket: realtimeProbeTicket(`private-mutation-nonce-${index}`, sessionId),
    };
  });
  const refusedSessionId = "private-mutation-session-101";
  const base = {
    port: 65_534,
    sessions,
    refusedSession: {
      sessionId: refusedSessionId,
      ticket: realtimeProbeTicket("private-mutation-nonce-101", refusedSessionId),
    },
    origin: probeOrigin,
    traceId: null,
    frame: Buffer.alloc(15_360),
    timeoutMs: 100,
  };

  const cases = [
    [{ ...base, sessions: sessions.slice(1) }, /exactly 100/i],
    [{ ...base, sessions: [...sessions.slice(0, 99), sessions[0]] }, /unique/i],
    [{ ...base, refusedSession: sessions[0] }, /distinct/i],
    [{ ...base, frame: Buffer.alloc(15_359) }, /15360|exact/i],
    [{ ...base, timeoutMs: 49 }, /timeout/i],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(() => probeRealtimeCapacityCohort(input), pattern);
  }

  let error;
  try {
    await probeRealtimeCapacityCohort(base);
  } catch (value) {
    error = value;
  }
  assert.ok(error instanceof Error);
  for (const privateValue of [
    probeTenant,
    probeLearner,
    sessions[0].sessionId,
    sessions[0].ticket,
    base.refusedSession.sessionId,
    base.refusedSession.ticket,
  ]) {
    assert.equal(error.message.includes(privateValue), false);
  }
});

test("the hostile sweep refuses every frozen boundary, ignores text, rejects duplicates, and stays alive", async () => {
  const peers = realtimeHostilePeers();
  await withRealtimeProbeApp(null, async (port, app) => {
    const result = await probeRealtimeHostileSweep({
      port,
      peers,
      origin: probeOrigin,
      traceId: "private-hostile-trace",
      timeoutMs: 10_000,
    });
    assert.deepEqual(result, {
      binaryFramesSent: 8,
      accepted: 0,
      rejected: 8,
      hostileTicketRefusals: 7,
      textFramesIgnored: 1,
      duplicateSessionsRefused: 1,
      processAlive: true,
    });

    let metrics;
    const drainDeadline = performance.now() + 2_000;
    do {
      metrics = await app.inject({ method: "GET", url: "/metrics" });
      if (/realtime_audio_active_sessions 0(?:\n|$)/.test(metrics.body)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    } while (performance.now() < drainDeadline);
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.body, /realtime_audio_active_sessions 0(?:\n|$)/);
    assert.match(metrics.body, /realtime_audio_retained_chunks 0(?:\n|$)/);
    assert.match(metrics.body, /realtime_audio_retained_bytes 0(?:\n|$)/);
    assert.match(metrics.body, /realtime_audio_ingress_total\{outcome="empty"\} 1(?:\n|$)/);
    assert.match(metrics.body, /realtime_audio_ingress_total\{outcome="invalid_format"\} 4(?:\n|$)/);
    assert.match(metrics.body, /realtime_audio_ingress_total\{outcome="oversized"\} 2(?:\n|$)/);
    assert.match(metrics.body, /realtime_audio_sessions_total\{outcome="duplicate"\} 1(?:\n|$)/);
    assert.match(metrics.body, /realtime_audio_store_total\{outcome="stored"\} 0(?:\n|$)/);

    const serialized = JSON.stringify(result);
    for (const privateValue of [
      probeTenant,
      probeLearner,
      "private-hostile-trace",
      peers.ticket.sessionId,
      peers.ticket.ticket,
      ...peers.frames.flatMap(({ sessionId, ticket }) => [sessionId, ticket]),
      peers.transport.ticket,
      peers.text.ticket,
      ...peers.duplicate.flatMap(({ sessionId, ticket }) => [sessionId, ticket]),
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  });
});

test("the hostile sweep uses the exact closed case matrix and fails closed on adapter lies", async () => {
  const peers = realtimeHostilePeers("private-hostile-adapter");
  const frameCalls = [];
  const ticketCalls = [];
  const transportCalls = [];
  const textCalls = [];
  const duplicateCalls = [];
  const healthCalls = [];
  const base = {
    port: 18_081,
    peers,
    origin: probeOrigin,
    traceId: null,
    timeoutMs: 2_000,
    frameProbe: async (input) => {
      frameCalls.push(input);
      return { accepted: false, ackLatencyMs: 1, sequence: 0 };
    },
    ticketProbe: async (input) => {
      ticketCalls.push(input);
      return { refused: 7 };
    },
    transportProbe: async (input) => {
      transportCalls.push(input);
      return { rejected: true, closeCode: 1009 };
    },
    textProbe: async (input) => {
      textCalls.push(input);
      return { ignored: true };
    },
    duplicateProbe: async (input) => {
      duplicateCalls.push(input);
      return { refused: true };
    },
    healthProbe: async (input) => {
      healthCalls.push(input);
      return { alive: true };
    },
  };

  assert.deepEqual(await probeRealtimeHostileSweep(base), {
    binaryFramesSent: 8,
    accepted: 0,
    rejected: 8,
    hostileTicketRefusals: 7,
    textFramesIgnored: 1,
    duplicateSessionsRefused: 1,
    processAlive: true,
  });
  assert.deepEqual(frameCalls.map(({ frame }) => frame.byteLength), [
    0,
    1,
    15_359,
    15_361,
    2 * MiB,
    2 * MiB + 1,
    2 * MiB + 64 * 1024,
  ]);
  assert.equal(ticketCalls.length, 1);
  assert.equal(transportCalls.length, 1);
  assert.equal(transportCalls[0].frame.byteLength, 2 * MiB + 64 * 1024 + 1);
  assert.equal(textCalls.length, 1);
  assert.equal(duplicateCalls.length, 1);
  assert.equal(healthCalls.length, 1);
  assert.ok(frameCalls.every(({ expectedSequence }) => expectedSequence === 0));

  const adapterLies = [
    { frameProbe: async () => ({ accepted: true, ackLatencyMs: 1, sequence: 0 }) },
    { ticketProbe: async () => ({ refused: 6 }) },
    { transportProbe: async () => ({ rejected: false, closeCode: 1009 }) },
    { textProbe: async () => ({ ignored: false }) },
    { duplicateProbe: async () => ({ refused: false }) },
    { healthProbe: async () => ({ alive: false }) },
  ];
  for (const overrides of adapterLies) {
    await assert.rejects(() => probeRealtimeHostileSweep({ ...base, ...overrides }), /hostile/i);
  }
});

test("the hostile sweep rejects peer-shape mutations before transport and keeps failures private", async () => {
  const peers = realtimeHostilePeers("private-hostile-mutation");
  const base = {
    port: 65_534,
    peers,
    origin: probeOrigin,
    traceId: null,
    timeoutMs: 100,
  };
  const cases = [
    [{ ...base, peers: { ...peers, frames: peers.frames.slice(1) } }, /seven|7/i],
    [{ ...base, peers: { ...peers, duplicate: [peers.duplicate[0], peers.duplicate[0]] } }, /ticket|distinct|unique/i],
    [{ ...base, peers: { ...peers, extra: "forbidden" } }, /exact/i],
    [{ ...base, timeoutMs: 49 }, /timeout/i],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(() => probeRealtimeHostileSweep(input), pattern);
  }

  let error;
  try {
    await probeRealtimeHostileSweep(base);
  } catch (value) {
    error = value;
  }
  assert.ok(error instanceof Error);
  for (const privateValue of [
    probeTenant,
    probeLearner,
    peers.ticket.sessionId,
    peers.ticket.ticket,
    peers.frames[0].sessionId,
    peers.frames[0].ticket,
  ]) {
    assert.equal(error.message.includes(privateValue), false);
  }
});

test("the metrics snapshot uses the private loopback endpoint and returns only fixed numeric series", async () => {
  const expected = realtimeMetricsSnapshot();
  const requests = [];
  const result = await probeRealtimeMetricsSnapshot({
    port: 18_081,
    metricsToken: "private-metrics-token",
    timeoutMs: 2_000,
    fetchImpl: async (input, options) => {
      requests.push({ input, options });
      return new Response(realtimeMetricsText(expected), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
  });
  assert.deepEqual(result, expected);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, "http://127.0.0.1:18081/metrics");
  assert.deepEqual(requests[0].options.headers, { "x-metrics-token": "private-metrics-token" });
  assert.equal(requests[0].options.redirect, "manual");
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(result).includes("private-metrics-token"), false);
});

test("the metrics snapshot rejects missing, duplicate, oversized, negative, and private error bodies", async () => {
  const valid = realtimeMetricsText(realtimeMetricsSnapshot());
  const privateBody = "private-metrics-body-must-not-escape";
  const cases = [
    [valid.replace(/^realtime_audio_active_sessions.*\n/m, ""), /metrics/i],
    [`${valid}realtime_audio_active_sessions 0\n`, /metrics/i],
    [valid.replace("realtime_audio_retained_bytes 0", "realtime_audio_retained_bytes -1"), /metrics/i],
    ["x".repeat(128 * 1024 + 1), /metrics/i],
    [privateBody, /metrics/i],
  ];
  for (const [body, pattern] of cases) {
    let error;
    try {
      await probeRealtimeMetricsSnapshot({
        port: 18_081,
        metricsToken: "private-metrics-token",
        timeoutMs: 2_000,
        fetchImpl: async () => new Response(body, { status: 200 }),
      });
    } catch (value) {
      error = value;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.equal(error.message.includes(privateBody), false);
  }
});

test("the hostile-capacity stage issues every peer through the API and emits exact closed evidence", async () => {
  const sessions = new Map();
  const requests = [];
  let ticketNumber = 0;
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    assert.equal(url.origin, "http://127.0.0.1:8080");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Origin, probeOrigin);
    assert.match(options.headers.authorization, /^Bearer /);
    assert.equal(options.headers["content-type"], "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    if (url.pathname === "/v1/recitation-sessions") {
      assert.equal(Object.hasOwn(body, "modelVersion"), false);
      assert.equal(body.consent.audioRetention, "discard");
      assert.match(body.practicePlanId, /^w3\.8-hostile-capacity-/);
      assert.match(body.sourceChecksum, /^declared:w3\.8-realtime-production-proof:/);
      const id = `private-stage-session-${sessions.size}`;
      sessions.set(id, body.practicePlanId);
      return new Response(JSON.stringify({
        id,
        tenantId: probeTenant,
        learnerId: probeLearner,
        consent: body.consent,
      }), { status: 200 });
    }
    assert.equal(url.pathname, "/v1/realtime-session-tickets");
    assert.ok(sessions.has(body.sessionId));
    assert.deepEqual(body.requestedSampleRates, [16_000]);
    ticketNumber += 1;
    const token = [
      "rt_v2",
      body.sessionId,
      probeTenant,
      probeLearner,
      "false",
      "discard",
      String(probeNowSeconds + 300),
      `private-stage-nonce-${ticketNumber}`,
      `private-stage-signature-${ticketNumber}`,
    ].join(".");
    return new Response(JSON.stringify({
      sessionId: body.sessionId,
      tenantId: probeTenant,
      learnerId: probeLearner,
      expiresAt: String(probeNowSeconds + 300),
      allowedSampleRates: [16_000],
      externalAsrProcessing: false,
      token,
      auditEventId: `private-stage-audit-${ticketNumber}`,
    }), { status: 200 });
  };
  const hostileCalls = [];
  const capacityCalls = [];
  const metricsCalls = [];
  const baseline = realtimeMetricsSnapshot();
  const final = realtimeMetricsSnapshot({
    ingressEnqueued: baseline.ingressEnqueued + 100,
    storeStored: baseline.storeStored + 100,
    deliveryDiscarded: baseline.deliveryDiscarded + 100,
    deliveryRejected: baseline.deliveryRejected + 7,
  });

  const result = await runRealtimeHostileCapacityStage({
    nodePort: 18_081,
    origin: probeOrigin,
    jwtSecret: probeSecret,
    metricsToken: "private-metrics-token",
    tenantId: probeTenant,
    learnerId: probeLearner,
    fetchImpl,
    hostileProbe: async (input) => {
      hostileCalls.push(input);
      return {
        binaryFramesSent: 8,
        accepted: 0,
        rejected: 8,
        hostileTicketRefusals: 7,
        textFramesIgnored: 1,
        duplicateSessionsRefused: 1,
        processAlive: true,
      };
    },
    capacityProbe: async (input) => {
      capacityCalls.push(input);
      return {
        sessionsAccepted: 100,
        sessionsRefused: 1,
        session101Refused: true,
        ackP95Ms: 120,
      };
    },
    metricsProbe: async (input) => {
      metricsCalls.push(input);
      return metricsCalls.length === 1 ? baseline : final;
    },
    nowUnixSeconds: () => probeNowSeconds,
    timeoutMs: 10_000,
  });

  assert.deepEqual(result, {
    binaryFramesSent: 108,
    accepted: 100,
    rejected: 8,
    lost: 0,
    uncertain: 0,
    sessionsAccepted: 100,
    sessionsRefused: 1,
    session101Refused: true,
    ackP95Ms: 120,
    processAlive: true,
    activeSessionsFinal: 0,
    retainedChunksFinal: 0,
    retainedBytesFinal: 0,
  });
  assert.equal(sessions.size, 112);
  assert.equal(ticketNumber, 113);
  assert.equal(requests.filter(({ url }) => url.pathname === "/v1/recitation-sessions").length, 112);
  assert.equal(requests.filter(({ url }) => url.pathname === "/v1/realtime-session-tickets").length, 113);
  assert.equal(hostileCalls.length, 1);
  assert.equal(hostileCalls[0].peers.frames.length, 7);
  assert.equal(hostileCalls[0].peers.duplicate[0].sessionId, hostileCalls[0].peers.duplicate[1].sessionId);
  assert.notEqual(hostileCalls[0].peers.duplicate[0].ticket, hostileCalls[0].peers.duplicate[1].ticket);
  assert.equal(capacityCalls.length, 1);
  assert.equal(capacityCalls[0].sessions.length, 100);
  assert.equal(metricsCalls.length, 2);
  assert.ok(metricsCalls.every(({ metricsToken }) => metricsToken === "private-metrics-token"));

  const serialized = JSON.stringify(result);
  for (const privateValue of [
    probeTenant,
    probeLearner,
    "private-metrics-token",
    ...[...sessions.keys()],
    ...hostileCalls[0].peers.frames.map(({ ticket }) => ticket),
    ...capacityCalls[0].sessions.map(({ ticket }) => ticket),
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("the hostile-capacity stage refuses false measurements, loss, dirty gauges, and lowered bars", async () => {
  const safePeers = realtimeHostilePeers("private-stage-mutation");
  const base = {
    nodePort: 18_081,
    origin: probeOrigin,
    jwtSecret: probeSecret,
    metricsToken: "private-metrics-token",
    tenantId: probeTenant,
    learnerId: probeLearner,
    fetchImpl: async () => new Response("{}", { status: 500 }),
    hostileProbe: async () => ({
      binaryFramesSent: 8,
      accepted: 0,
      rejected: 8,
      hostileTicketRefusals: 7,
      textFramesIgnored: 1,
      duplicateSessionsRefused: 1,
      processAlive: true,
    }),
    capacityProbe: async () => ({
      sessionsAccepted: 100,
      sessionsRefused: 1,
      session101Refused: true,
      ackP95Ms: 120,
    }),
    metricsProbe: async () => realtimeMetricsSnapshot(),
    peerIssuer: async () => safePeers,
    capacityIssuer: async () => ({
      sessions: Array.from({ length: 100 }, (_, index) => ({
        sessionId: `private-capacity-${index}`,
        ticket: `private-capacity-ticket-${index}`,
      })),
      refusedSession: { sessionId: "private-capacity-101", ticket: "private-capacity-ticket-101" },
    }),
    nowUnixSeconds: () => probeNowSeconds,
    timeoutMs: 100,
  };
  const baseline = realtimeMetricsSnapshot();
  const goodFinal = realtimeMetricsSnapshot({
    ingressEnqueued: baseline.ingressEnqueued + 100,
    storeStored: baseline.storeStored + 100,
    deliveryDiscarded: baseline.deliveryDiscarded + 100,
    deliveryRejected: baseline.deliveryRejected + 7,
  });
  const metricsPair = (final) => {
    let call = 0;
    return async () => (call++ === 0 ? baseline : final);
  };
  const cases = [
    { hostileProbe: async () => ({ binaryFramesSent: 7 }) },
    { capacityProbe: async () => ({ sessionsAccepted: 99 }) },
    { capacityProbe: async () => ({ sessionsAccepted: 100, sessionsRefused: 1, session101Refused: true, ackP95Ms: 250 }) },
    { metricsProbe: metricsPair({ ...goodFinal, activeSessions: 1 }) },
    { metricsProbe: metricsPair({ ...goodFinal, deliveryAcceptedLost: baseline.deliveryAcceptedLost + 1 }) },
    { metricsProbe: metricsPair({ ...goodFinal, storeStored: baseline.storeStored + 99 }) },
    { metricsProbe: metricsPair({ ...goodFinal, deliveryRejected: baseline.deliveryRejected + 6 }) },
  ];
  for (const overrides of cases) {
    await assert.rejects(
      () => runRealtimeHostileCapacityStage({
        ...base,
        metricsProbe: metricsPair(goodFinal),
        ...overrides,
      }),
      /hostile-capacity/i,
    );
  }
});

function faultProbeResults() {
  return {
    nodeProcess: {
      fault: "node-process",
      framesCaptured: 4,
      framesTransmitted: 3,
      accepted: 2,
      rejected: 0,
      lost: 1,
      uncertain: 1,
      durableLost: 0,
      durableOrphan: 0,
      unresolvedUncertain: 1,
      recovered: true,
      readinessFailedClosed: true,
      incompleteReportedComplete: 0,
      proofs: {
        cleanInterruptionRecovered: true,
        ambiguousFrameNotReplayed: true,
        freshTicketIssued: true,
      },
    },
    postgres: {
      fault: "postgres",
      framesCaptured: 4,
      framesTransmitted: 4,
      accepted: 2,
      rejected: 2,
      lost: 0,
      uncertain: 0,
      durableLost: 0,
      durableOrphan: 0,
      unresolvedUncertain: 0,
      recovered: true,
      readinessFailedClosed: true,
      incompleteReportedComplete: 0,
      proofs: {
        outageUpgradeRefused: true,
        outageTicketNotConsumed: true,
        freshTicketIssued: true,
      },
    },
    s3: {
      fault: "s3",
      framesCaptured: 4,
      framesTransmitted: 4,
      accepted: 3,
      rejected: 0,
      lost: 1,
      uncertain: 0,
      durableLost: 1,
      durableOrphan: 0,
      unresolvedUncertain: 0,
      recovered: true,
      readinessFailedClosed: true,
      incompleteReportedComplete: 0,
      proofs: {
        sameCandidateImage: true,
        unreachableEndpointUnready: true,
        acceptedLossRecorded: true,
        productionCandidateRestored: true,
      },
    },
    repair: {
      attempted: 1,
      repaired: 0,
      outstandingActionable: 1,
      secondPassRepaired: 0,
      idempotent: true,
    },
  };
}

test("the fault stage repairs stored orphans and preserves genuine accepted loss as actionable", async () => {
  const values = faultProbeResults();
  const calls = [];
  const result = await runRealtimeFaultRecoveryStage({
    nodeProcessProbe: async () => { calls.push("node-process"); return values.nodeProcess; },
    postgresProbe: async () => { calls.push("postgres"); return values.postgres; },
    s3Probe: async () => { calls.push("s3"); return values.s3; },
    repairProbe: async (input) => {
      calls.push("repair");
      assert.deepEqual(input, { durableLost: 1, durableOrphan: 0 });
      return values.repair;
    },
  });
  assert.deepEqual(calls, ["node-process", "postgres", "s3", "repair"]);
  assert.deepEqual(result, stageMeasurements("fault-recovery"));
  for (const privateValue of ["private-ticket", "private-session", "private-audio"]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test("the fault stage rejects open accounting, missing safety proofs, incomplete claims, and repair drift", async () => {
  const base = faultProbeResults();
  const execute = (values) => runRealtimeFaultRecoveryStage({
    nodeProcessProbe: async () => values.nodeProcess,
    postgresProbe: async () => values.postgres,
    s3Probe: async () => values.s3,
    repairProbe: async () => values.repair,
  });
  const cases = [
    [(copy) => { copy.nodeProcess.framesCaptured += 1; }],
    [(copy) => { copy.nodeProcess.framesTransmitted += 1; }],
    [(copy) => { copy.nodeProcess.uncertain = 0; copy.nodeProcess.accepted += 1; }],
    [(copy) => { copy.nodeProcess.unresolvedUncertain = 0; }],
    [(copy) => { copy.nodeProcess.durableLost = 1; }],
    [(copy) => { copy.nodeProcess.proofs.ambiguousFrameNotReplayed = false; }],
    [(copy) => { copy.nodeProcess.incompleteReportedComplete = 1; }],
    [(copy) => { copy.postgres.readinessFailedClosed = false; }],
    [(copy) => { copy.postgres.lost = 1; copy.postgres.accepted -= 1; copy.postgres.durableLost = 1; }],
    [(copy) => { copy.postgres.proofs.outageTicketNotConsumed = false; }],
    [(copy) => { copy.s3.proofs.sameCandidateImage = false; }],
    [(copy) => { copy.s3.proofs.unreachableEndpointUnready = false; }],
    [(copy) => { copy.s3.proofs.acceptedLossRecorded = false; }],
    [(copy) => { copy.s3.durableLost = 0; }],
    [(copy) => { copy.s3.recovered = false; }],
    [(copy) => { copy.repair.attempted = 2; }],
    [(copy) => { copy.repair.repaired = 2; }],
    [(copy) => { copy.repair.outstandingActionable = 2; }],
    [(copy) => { copy.repair.repaired = 3; copy.repair.outstandingActionable = 0; }],
    [(copy) => { copy.repair.secondPassRepaired = 1; }],
    [(copy) => { copy.repair.idempotent = false; }],
  ];
  for (const [mutate] of cases) {
    const copy = structuredClone(base);
    mutate(copy);
    await assert.rejects(() => execute(copy), /realtime fault-recovery stage failed/i);
  }

  await assert.rejects(
    () => runRealtimeFaultRecoveryStage({
      nodeProcessProbe: async () => { throw new Error("private-ticket private-session"); },
      postgresProbe: async () => base.postgres,
      s3Probe: async () => base.s3,
      repairProbe: async () => base.repair,
    }),
    (error) => error.message === "realtime fault-recovery stage failed",
  );
});

function repairSummary(repaired) {
  return {
    mode: "apply",
    driver: "s3",
    scanned: 3,
    retainedCandidates: 3,
    skippedRetention: 0,
    wouldRepair: 0,
    repaired,
    alreadyIndexed: 2,
    incompleteObjects: 0,
    indexWithoutObject: 0,
    refused: 0,
    errors: [],
  };
}

function faultRepairHarness({ snapshots, summaries } = {}) {
  const closeCalls = [];
  const repairCalls = [];
  const remainingSnapshots = structuredClone(snapshots ?? [
    { lostOutstanding: 0, orphanOutstanding: 0, repaired: 0 },
    { lostOutstanding: 2, orphanOutstanding: 0, repaired: 0 },
    { lostOutstanding: 2, orphanOutstanding: 0, repaired: 0 },
    { lostOutstanding: 2, orphanOutstanding: 0, repaired: 0 },
  ]);
  const remainingSummaries = structuredClone(summaries ?? [repairSummary(0), repairSummary(0)]);
  const db = {
    withTenant: async () => {},
    assertRestrictedRole: async () => {},
    end: async () => { closeCalls.push("db"); },
  };
  const store = {
    driver: "s3",
    inventory: async () => [],
    get: async () => null,
    close: async () => { closeCalls.push("store"); },
  };
  return {
    closeCalls,
    repairCalls,
    input: {
      db,
      store,
      databaseUrl: "postgresql://private-repair-database",
      tenantId: probeTenant,
      env: { PRIVATE_REPAIR_SECRET: "must-not-leave-repair" },
      outcomeSnapshot: async ({ db: selectedDb, tenantId }) => {
        assert.equal(selectedDb, db);
        assert.equal(tenantId, probeTenant);
        return remainingSnapshots.shift();
      },
      repair: async (options) => {
        repairCalls.push(options);
        assert.equal(options.databaseUrl, "postgresql://private-repair-database");
        assert.equal(options.audioObjectStore, store);
        assert.equal(options.apply, true);
        assert.deepEqual(options.tenantIds, [probeTenant]);
        return remainingSummaries.shift();
      },
    },
  };
}

test("the repair observer preserves absent audio as actionable without fabricating an orphan", async () => {
  const harness = faultRepairHarness();
  const adapter = await createRealtimeFaultRepairProbe(harness.input);
  const result = await adapter.repairProbe({ durableLost: 2, durableOrphan: 0 });
  assert.deepEqual(result, {
    attempted: 2,
    repaired: 0,
    outstandingActionable: 2,
    secondPassRepaired: 0,
    idempotent: true,
  });
  assert.equal(harness.repairCalls.length, 2);
  for (const privateValue of [
    "private-repair-database",
    "must-not-leave-repair",
    probeTenant,
  ]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
  await adapter.close();
  await adapter.close();
  assert.deepEqual(harness.closeCalls.sort(), ["db", "store"]);
});

test("the repair observer repairs an actually observed stored orphan exactly once", async () => {
  const harness = faultRepairHarness({
    snapshots: [
      { lostOutstanding: 0, orphanOutstanding: 0, repaired: 0 },
      { lostOutstanding: 2, orphanOutstanding: 1, repaired: 0 },
      { lostOutstanding: 2, orphanOutstanding: 0, repaired: 1 },
      { lostOutstanding: 2, orphanOutstanding: 0, repaired: 1 },
    ],
    summaries: [repairSummary(1), repairSummary(0)],
  });
  const adapter = await createRealtimeFaultRepairProbe(harness.input);
  const result = await adapter.repairProbe({ durableLost: 2, durableOrphan: 1 });
  assert.deepEqual(result, {
    attempted: 3,
    repaired: 1,
    outstandingActionable: 2,
    secondPassRepaired: 0,
    idempotent: true,
  });
  await adapter.close();
});

test("the repair observer fails closed on contamination, drift, repair lies, and reuse", async () => {
  const cases = [
    { snapshots: [
      { lostOutstanding: 1, orphanOutstanding: 0, repaired: 0 },
    ] },
    { snapshots: [
      { lostOutstanding: 0, orphanOutstanding: 0, repaired: 0 },
      { lostOutstanding: 1, orphanOutstanding: 0, repaired: 0 },
    ] },
    { summaries: [{ ...repairSummary(0), refused: 1, errors: [{ reason: "private" }] }] },
    { summaries: [repairSummary(1)] },
    { snapshots: [
      { lostOutstanding: 0, orphanOutstanding: 0, repaired: 0 },
      { lostOutstanding: 2, orphanOutstanding: 0, repaired: 0 },
      { lostOutstanding: 1, orphanOutstanding: 0, repaired: 0 },
    ] },
    { summaries: [repairSummary(0), repairSummary(1)] },
  ];
  for (const mutation of cases) {
    const harness = faultRepairHarness(mutation);
    let adapter = null;
    try {
      adapter = await createRealtimeFaultRepairProbe(harness.input);
      await assert.rejects(
        () => adapter.repairProbe({ durableLost: 2, durableOrphan: 0 }),
        (error) => error.message === "realtime fault repair probe failed",
      );
    } catch (error) {
      assert.equal(error.message, "realtime fault repair probe failed");
    } finally {
      await adapter?.close();
    }
  }

  const harness = faultRepairHarness();
  const adapter = await createRealtimeFaultRepairProbe(harness.input);
  await adapter.repairProbe({ durableLost: 2, durableOrphan: 0 });
  await assert.rejects(
    () => adapter.repairProbe({ durableLost: 2, durableOrphan: 0 }),
    (error) => error.message === "realtime fault repair probe failed",
  );
  await adapter.close();
});

test("proof CLI arguments reject unsafe paths, ports, projects, actors, acknowledgements, and extra flags", () => {
  assert.equal(parseRealtimeProofPort("18081"), 18_081);
  const valid = [
    "preflight",
    "--selection", "/tmp/release-selection.json",
    "--project-name", "qrai-realtime-proof",
    "--provider", "release-staging",
    "--actor-class", "release-operator",
    "--node-port", "18081",
    "--secondary-node-port", "18082",
    "--fault-node-port", "18083",
    "--acknowledge-staging-isolated", "yes",
  ];
  assert.deepEqual(parseRealtimeImageProofArguments(valid), {
    command: "preflight",
    selectionPath: "/tmp/release-selection.json",
    projectName: "qrai-realtime-proof",
    provider: "release-staging",
    actorClass: "release-operator",
    nodePort: 18_081,
    secondaryNodePort: 18_082,
    faultNodePort: 18_083,
  });

  const cases = [
    [[...valid, "--skip-soak", "yes"], /unknown|exact/i],
    [[...valid, "--provider", "other"], /duplicate/i],
    [[...valid.slice(0, 2), "relative.json", ...valid.slice(3)], /absolute/i],
    [[...valid.slice(0, 4), "../../unsafe", ...valid.slice(5)], /project/i],
    [[...valid.slice(0, 10), "8081", ...valid.slice(11)], /8081|proof port/i],
    [[...valid.slice(0, 12), "18081", ...valid.slice(13)], /distinct|port/i],
    [[...valid.slice(0, 14), "18081", ...valid.slice(15)], /distinct|port/i],
    [[...valid.slice(0, 16), "no"], /acknowledge/i],
    [[...valid.slice(0, 6), "bad provider", ...valid.slice(7)], /provider/i],
    [[...valid.slice(0, 8), "developer", ...valid.slice(9)], /actor/i],
  ];
  for (const [argv, pattern] of cases) {
    assert.throws(() => parseRealtimeImageProofArguments(argv), pattern);
  }

  assert.deepEqual(parseRealtimeImageProofArguments(["probe", "--stage", "retention"]), {
    command: "probe",
    stage: "retention",
  });
  for (const stage of ["candidate-running-images", "protocol-parity", "hostile-capacity"]) {
    assert.deepEqual(parseRealtimeImageProofArguments(["probe", "--stage", stage]), {
      command: "probe",
      stage,
    });
  }
  for (const argv of [
    ["probe"],
    ["probe", "--stage"],
    ["probe", "--stage", "unknown"],
    ["probe", "--stage", "retention", "--skip", "yes"],
  ]) {
    assert.throws(() => parseRealtimeImageProofArguments(argv), /stage|argument|exact/i);
  }
});

test("candidate runtime collection inspects exact Compose containers, local digests, health, and effective UIDs", () => {
  const value = selection();
  const observations = candidateRunningObservations(value);
  const commands = [];
  const commandRunner = (file, args, environment) => {
    commands.push([file, args]);
    assert.equal(environment.NODE_BACKEND_IMAGE, composeImageEnvironment(value, "candidate").NODE_BACKEND_IMAGE);
    if (file === "git" && args.join(" ") === "rev-parse HEAD") return candidateSha;
    if (file === "git" && args.join(" ") === "status --porcelain") return "";
    if (file !== "docker") throw new Error("unexpected proof command");
    if (args.includes("config")) return JSON.stringify(renderedProofTopology(value));
    if (args[0] === "compose" && args.includes("ps")) {
      return observations[args.at(-1)].containerId;
    }
    if (args[0] === "inspect") {
      const observation = Object.values(observations).find(({ containerId }) => containerId === args[1]);
      return JSON.stringify([{
        Id: observation.containerId,
        Image: observation.imageId,
        Config: {
          Image: observation.configuredImage,
          User: observation.configuredUser,
        },
        State: { Running: observation.running, Health: { Status: observation.health } },
      }]);
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const observation = Object.values(observations)
        .find(({ configuredImage }) => configuredImage === args[2]);
      return JSON.stringify([{
        Id: observation.imageId,
        RepoDigests: observation.repoDigests,
      }]);
    }
    if (args[0] === "exec" && args.slice(2).join(" ") === "id -u") {
      return String(Object.values(observations)
        .find(({ containerId }) => containerId === args[1]).effectiveUid);
    }
    throw new Error(`unexpected proof command: ${args.join(" ")}`);
  };
  const result = collectRealtimeCandidateRunningImagesRuntime({
    selection: value,
    projectName: "qrai-realtime-proof",
    nodePort: 18_081,
    secondaryNodePort: 18_082,
    faultNodePort: 18_083,
    env: { PRIVATE_RUNTIME_SECRET: "must-not-leave-collector" },
    commandRunner,
  });
  assert.deepEqual(result, {
    images: runningImages(value),
    measurements: stageMeasurements("candidate-running-images"),
  });
  assert.equal(commands.filter(([file]) => file === "git").length, 2);
  assert.equal(commands.filter(([file, args]) => file === "docker" && args[0] === "inspect").length, 4);
  assert.equal(commands.filter(([file, args]) => file === "docker" && args[0] === "exec").length, 4);
  assert.equal(JSON.stringify(result).includes("must-not-leave-collector"), false);
});

function s3FaultProcessHarness({
  containerOverride = {},
  imageOverride = {},
  readiness = { reachable: false, statusCode: null },
  residual = "",
  privateFailure = null,
} = {}) {
  const value = selection();
  const observation = candidateRunningObservations(value)["node-realtime"];
  const calls = [];
  let psCalls = 0;
  const commandRunner = (file, args, environment) => {
    calls.push([file, args]);
    assert.equal(
      environment.NODE_BACKEND_IMAGE,
      composeImageEnvironment(value, "candidate").NODE_BACKEND_IMAGE,
    );
    assert.equal(environment.REALTIME_PROOF_FAULT_NODE_PORT, "18083");
    if (privateFailure !== null && args.includes("up")) throw new Error(privateFailure);
    if (file !== "docker") throw new Error("unexpected S3 fault command");
    if (args[0] === "compose" && args.includes("up")) return "";
    if (args[0] === "compose" && args.includes("ps")) {
      psCalls += 1;
      return psCalls === 1 ? observation.containerId : residual;
    }
    if (args[0] === "inspect") {
      return JSON.stringify([{
        Id: observation.containerId,
        Image: observation.imageId,
        Config: {
          Image: observation.configuredImage,
          User: observation.configuredUser,
        },
        State: {
          Running: false,
          ExitCode: 2,
          Health: { Status: "unhealthy" },
        },
        ...containerOverride,
      }]);
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return JSON.stringify([{
        Id: observation.imageId,
        RepoDigests: observation.repoDigests,
        Config: { User: observation.configuredUser },
        ...imageOverride,
      }]);
    }
    if (args[0] === "compose" && args.includes("rm")) return "";
    throw new Error(`unexpected S3 fault command: ${args.join(" ")}`);
  };
  return {
    value,
    calls,
    input: {
      selection: value,
      projectName: "qrai-realtime-proof",
      faultNodePort: 18_083,
      env: { PRIVATE_RUNTIME_SECRET: "must-not-leave-fault-probe" },
      commandRunner,
      delayImpl: async () => {},
      readinessProbe: async ({ port, timeoutMs }) => {
        assert.equal(port, 18_083);
        assert.equal(timeoutMs, 2_000);
        return readiness;
      },
    },
  };
}

test("the same-image S3 fault process stays unready, non-root, bounded, and is always removed", async () => {
  const harness = s3FaultProcessHarness();
  const result = await probeRealtimeS3FaultProcessRuntime(harness.input);
  assert.deepEqual(result, {
    sameCandidateImage: true,
    configuredNonRoot: true,
    unreachableEndpointUnready: true,
    removed: true,
  });
  const renderedCalls = harness.calls.map(([, args]) => args.join(" "));
  assert.match(renderedCalls[0], /--profile realtime-proof-fault up -d --no-build --no-deps node-realtime-proof-s3-fault$/);
  assert.match(renderedCalls.at(-2), /--profile realtime-proof-fault rm --stop --force node-realtime-proof-s3-fault$/);
  assert.match(renderedCalls.at(-1), /--profile realtime-proof-fault ps --all --quiet node-realtime-proof-s3-fault$/);
  for (const privateValue of [
    "must-not-leave-fault-probe",
    candidateRunningObservations(harness.value)["node-realtime"].containerId,
  ]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test("the S3 fault process probe fails closed on identity, readiness, exit, cleanup, and private errors", async () => {
  const value = selection();
  const nodeReference = composeImageEnvironment(value, "candidate").NODE_BACKEND_IMAGE;
  const mutations = [
    { containerOverride: { State: { Running: true, ExitCode: 0, Health: { Status: "healthy" } } } },
    { containerOverride: { State: { Running: false, ExitCode: 0, Health: { Status: "unhealthy" } } } },
    { containerOverride: { Config: { Image: "qrai/node:mutable", User: "node" } } },
    { containerOverride: { Config: { Image: nodeReference, User: "root" } } },
    { imageOverride: { Id: `sha256:${"9".repeat(64)}` } },
    { imageOverride: { RepoDigests: [] } },
    { imageOverride: { Config: { User: "0" } } },
    { readiness: { reachable: true, statusCode: 200 } },
    { readiness: { reachable: false, statusCode: 503 } },
    { residual: "private-residual-container" },
  ];
  for (const mutation of mutations) {
    const harness = s3FaultProcessHarness(mutation);
    await assert.rejects(
      () => probeRealtimeS3FaultProcessRuntime(harness.input),
      (error) => error.message === "realtime S3 fault process probe failed",
    );
    assert.equal(harness.calls.some(([, args]) => args.includes("rm")), true);
  }

  const privateFailure = "private-container private-image private-ticket";
  const harness = s3FaultProcessHarness({ privateFailure });
  await assert.rejects(
    () => probeRealtimeS3FaultProcessRuntime(harness.input),
    (error) => error.message === "realtime S3 fault process probe failed" &&
      !String(error).includes(privateFailure),
  );
  assert.equal(harness.calls.some(([, args]) => args.includes("rm")), true);
});

function nodeProcessLifecycleHarness({
  initial = {
    running: true,
    health: "healthy",
    pid: 321,
    startedAt: "2026-08-10T00:00:00.000000000Z",
    exitCode: 0,
    restartPolicy: "unless-stopped",
  },
  stopped = {
    running: false,
    health: "unhealthy",
    pid: 0,
    startedAt: "2026-08-10T00:00:00.000000000Z",
    exitCode: 137,
    restartPolicy: "no",
  },
  restarted = {
    running: true,
    health: "healthy",
    pid: 654,
    startedAt: "2026-08-10T00:01:00.000000000Z",
    exitCode: 0,
    restartPolicy: "unless-stopped",
  },
  configuredImage = null,
  replacement = null,
  missing = false,
  privateFailure = null,
  ignoreRestoredPolicy = false,
} = {}) {
  const value = selection();
  const expectedImage = composeImageEnvironment(value, "candidate").NODE_BACKEND_IMAGE;
  const containerId = "d".repeat(64);
  const imageId = `sha256:${"5".repeat(64)}`;
  const calls = [];
  let state = { ...initial };
  let psCalls = 0;
  const commandRunner = (file, args, environment) => {
    calls.push([file, args]);
    assert.equal(environment.NODE_BACKEND_IMAGE, expectedImage);
    assert.equal(environment.PRIVATE_NODE_LIFECYCLE, "must-not-leave-lifecycle");
    if (file !== "docker") throw new Error("unexpected Node lifecycle command");
    if (args[0] === "compose" && args.includes("ps")) {
      psCalls += 1;
      if (missing) return "";
      return psCalls === 1 || replacement === null ? containerId : replacement;
    }
    if (args[0] === "inspect") {
      return JSON.stringify([{
        Id: containerId,
        Image: imageId,
        Config: { Image: configuredImage ?? expectedImage },
        HostConfig: { RestartPolicy: { Name: state.restartPolicy } },
        RestartCount: state.restartCount ?? 0,
        State: {
          Running: state.running,
          Health: { Status: state.health },
          Pid: state.pid,
          StartedAt: state.startedAt,
          ExitCode: state.exitCode,
        },
      }]);
    }
    if (args[0] === "update" && args[1] === "--restart=no") {
      state = { ...state, restartPolicy: "no" };
      return containerId;
    }
    if (args[0] === "kill") {
      if (privateFailure !== null) throw new Error(privateFailure);
      state = { ...stopped };
      return containerId;
    }
    if (args[0] === "update" && args[1] === "--restart=unless-stopped") {
      if (!ignoreRestoredPolicy) state = { ...state, restartPolicy: "unless-stopped" };
      return containerId;
    }
    if (args[0] === "start") {
      state = {
        ...restarted,
        restartPolicy: ignoreRestoredPolicy ? restarted.restartPolicy : "unless-stopped",
      };
      return containerId;
    }
    throw new Error(`unexpected Node lifecycle command: ${args.join(" ")}`);
  };
  return {
    calls,
    input: {
      selection: value,
      projectName: "qrai-realtime-proof",
      env: {
        PRIVATE_NODE_LIFECYCLE: "must-not-leave-lifecycle",
      },
      commandRunner,
      delayImpl: async () => {},
      healthAttempts: 2,
    },
  };
}

test("the Node process lifecycle SIGKILLs and restores the same exact immutable container", async () => {
  const harness = nodeProcessLifecycleHarness();
  const lifecycle = createRealtimeNodeProcessFaultLifecycleRuntime(harness.input);
  const killed = await lifecycle.killNodeProcess();
  const restored = await lifecycle.startNodeProcess();
  assert.deepEqual(killed, { killed: true });
  assert.deepEqual(restored, { healthy: true });
  const rendered = harness.calls.map(([, args]) => args.join(" "));
  assert.equal(rendered.some((value) => /^update --restart=no /.test(value)), true);
  assert.equal(rendered.some((value) => /^kill --signal KILL /.test(value)), true);
  assert.equal(rendered.some((value) => /^update --restart=unless-stopped /.test(value)), true);
  assert.equal(rendered.some((value) => /^start /.test(value)), true);
  for (const privateValue of [
    "must-not-leave-lifecycle",
    "d".repeat(64),
    composeImageEnvironment(selection(), "candidate").NODE_BACKEND_IMAGE,
  ]) {
    assert.equal(JSON.stringify({ killed, restored }).includes(privateValue), false);
  }
});

test("the Node process lifecycle rejects identity, stop, restart, replacement, and private failures", async () => {
  const cases = [
    { missing: true },
    { initial: { running: false, health: "unhealthy", pid: 0, startedAt: "", exitCode: 0, restartPolicy: "unless-stopped" } },
    { configuredImage: "qrai/node:mutable" },
    { stopped: { running: true, health: "healthy", pid: 321, startedAt: "2026-08-10T00:00:00Z", exitCode: 0, restartPolicy: "no" } },
    { stopped: { running: false, health: "unhealthy", pid: 0, startedAt: "2026-08-10T00:00:00Z", exitCode: 0, restartPolicy: "no" } },
    { replacement: "e".repeat(64) },
    { restarted: { running: true, health: "unhealthy", pid: 654, startedAt: "2026-08-10T00:01:00Z", exitCode: 0, restartPolicy: "unless-stopped" } },
    { restarted: { running: true, health: "healthy", pid: 321, startedAt: "2026-08-10T00:00:00.000000000Z", exitCode: 0, restartPolicy: "unless-stopped" } },
    { ignoreRestoredPolicy: true, restarted: { running: true, health: "healthy", pid: 654, startedAt: "2026-08-10T00:01:00Z", exitCode: 0, restartPolicy: "no" } },
    { privateFailure: "private-container private-image private-ticket" },
  ];
  for (const mutation of cases) {
    const harness = nodeProcessLifecycleHarness(mutation);
    const lifecycle = createRealtimeNodeProcessFaultLifecycleRuntime(harness.input);
    let operationError = null;
    try {
      await lifecycle.killNodeProcess();
      await lifecycle.startNodeProcess();
    } catch (error) {
      operationError = error;
      try {
        await lifecycle.startNodeProcess();
      } catch {
        // The lifecycle still must attempt policy restoration after a partial fault.
      }
    }
    assert.equal(operationError?.message, "realtime Node process lifecycle failed");
    assert.equal(String(operationError).includes("private-"), false);
    if (mutation.privateFailure !== null && mutation.privateFailure !== undefined) {
      assert.equal(
        harness.calls.some(([, args]) => args[0] === "update" && args[1] === "--restart=unless-stopped"),
        true,
      );
    }
  }
});

function postgresLifecycleHarness({
  initial = { running: true, health: "healthy" },
  stopped = { running: false, health: "unhealthy" },
  restarted = { running: true, health: "healthy" },
  replacement = null,
  missing = false,
  privateFailure = null,
} = {}) {
  const containerId = "b".repeat(64);
  const calls = [];
  let inspectCall = 0;
  let psCall = 0;
  const states = [initial, stopped, restarted];
  const commandRunner = (file, args, environment) => {
    calls.push([file, args]);
    assert.equal(environment.PRIVATE_POSTGRES_LIFECYCLE, "must-not-leave-lifecycle");
    if (privateFailure !== null && args.includes("stop")) throw new Error(privateFailure);
    if (file !== "docker") throw new Error("unexpected Postgres lifecycle command");
    if (args[0] === "compose" && args.includes("ps")) {
      psCall += 1;
      if (missing) return "";
      return psCall === 1 || replacement === null ? containerId : replacement;
    }
    if (args[0] === "inspect") {
      const state = states[Math.min(inspectCall, states.length - 1)];
      inspectCall += 1;
      return JSON.stringify([{
        Id: containerId,
        State: {
          Running: state.running,
          Health: { Status: state.health },
        },
      }]);
    }
    if (args[0] === "compose" && args.includes("stop")) return "";
    if (args[0] === "compose" && args.includes("start")) return "";
    throw new Error(`unexpected Postgres lifecycle command: ${args.join(" ")}`);
  };
  return {
    calls,
    input: {
      projectName: "qrai-realtime-proof",
      env: { PRIVATE_POSTGRES_LIFECYCLE: "must-not-leave-lifecycle" },
      commandRunner,
      delayImpl: async () => {},
    },
  };
}

test("the Compose Postgres lifecycle stops and restores the same exact healthy container", async () => {
  const harness = postgresLifecycleHarness();
  const lifecycle = createRealtimePostgresFaultLifecycleRuntime(harness.input);
  assert.deepEqual(await lifecycle.stopPostgres(), { stopped: true });
  assert.deepEqual(await lifecycle.startPostgres(), { healthy: true });
  const rendered = harness.calls.map(([, args]) => args.join(" "));
  assert.equal(rendered.some((value) => / stop --timeout 10 postgres$/.test(value)), true);
  assert.equal(rendered.some((value) => / start postgres$/.test(value)), true);
  assert.equal(rendered.filter((value) => / ps --all --quiet postgres$/.test(value)).length, 2);
});

test("the Compose Postgres lifecycle rejects missing, running, replaced, unhealthy, and private states", async () => {
  const cases = [
    { missing: true },
    { initial: { running: false, health: "unhealthy" } },
    { stopped: { running: true, health: "healthy" } },
    { replacement: "c".repeat(64) },
    { restarted: { running: true, health: "unhealthy" } },
    { privateFailure: "private-container private-database-url" },
  ];
  for (const mutation of cases) {
    const harness = postgresLifecycleHarness(mutation);
    const lifecycle = createRealtimePostgresFaultLifecycleRuntime(harness.input);
    await assert.rejects(
      async () => {
        await lifecycle.stopPostgres();
        await lifecycle.startPostgres();
      },
      (error) => error.message === "realtime Postgres lifecycle failed" &&
        !String(error).includes("private-"),
    );
  }
});

test("the candidate CLI stage dispatches strict project and selection configuration with identity-only output", async () => {
  const privateSelectionPath = "/tmp/private-release-selection.json";
  const env = {
    REALTIME_PROOF_SELECTION_PATH: privateSelectionPath,
    REALTIME_PROOF_PROJECT_NAME: "qrai-realtime-proof",
    REALTIME_PROOF_NODE_PORT: "18081",
    REALTIME_PROOF_SECONDARY_NODE_PORT: "18082",
    REALTIME_PROOF_FAULT_NODE_PORT: "18083",
  };
  const candidate = {
    images: runningImages(),
    measurements: stageMeasurements("candidate-running-images"),
  };
  const result = await runRealtimeImageProofStage({
    stage: "candidate-running-images",
    env,
    candidateStage: async (configuration) => {
      assert.deepEqual(configuration, {
        selectionPath: privateSelectionPath,
        projectName: "qrai-realtime-proof",
        nodePort: 18_081,
        secondaryNodePort: 18_082,
        faultNodePort: 18_083,
      });
      return candidate;
    },
  });
  assert.deepEqual(result, {
    status: "passed",
    stage: "candidate-running-images",
    ...candidate,
  });
  assert.equal(JSON.stringify(result).includes(privateSelectionPath), false);

  for (const override of [
    { REALTIME_PROOF_SELECTION_PATH: "relative.json" },
    { REALTIME_PROOF_PROJECT_NAME: "../unsafe" },
    { REALTIME_PROOF_SECONDARY_NODE_PORT: "18081" },
    { REALTIME_PROOF_FAULT_NODE_PORT: "18082" },
  ]) {
    await assert.rejects(
      () => runRealtimeImageProofStage({
        stage: "candidate-running-images",
        env: { ...env, ...override },
        candidateStage: async () => candidate,
      }),
      /candidate-running-images.*configuration|proof stage.*failed/i,
    );
  }
});

test("the retention CLI stage validates environment, closes real adapters, and emits only aggregate evidence", async () => {
  const calls = [];
  const privateDatabase = "postgresql://private-user:private-password@private-db/proof";
  const privateLearner = "private-proof-learner";
  const env = {
    DATABASE_URL: privateDatabase,
    JWT_SECRET: probeSecret,
    REALTIME_PROOF_NODE_PORT: "18081",
    REALTIME_PROOF_ORIGIN: probeOrigin,
    REALTIME_PROOF_TENANT_ID: probeTenant,
    REALTIME_PROOF_LEARNER_ID: privateLearner,
    REALTIME_PROOF_TIMEOUT_MS: "10000",
  };
  const measurements = stageMeasurements("retention");
  const result = await runRealtimeImageProofStage({
    stage: "retention",
    env,
    retentionAdaptersFactory: async ({ env: selectedEnv }) => {
      assert.equal(selectedEnv, env);
      calls.push("create");
      return {
        observationProbe: async () => {},
        cleanupProbe: async () => {},
        async close() { calls.push("close"); },
      };
    },
    retentionStage: async (input) => {
      calls.push("run");
      assert.equal(input.nodePort, 18_081);
      assert.equal(input.origin, probeOrigin);
      assert.equal(input.jwtSecret, probeSecret);
      assert.equal(input.tenantId, probeTenant);
      assert.equal(input.learnerId, privateLearner);
      assert.equal(input.timeoutMs, 10_000);
      assert.equal(typeof input.observationProbe, "function");
      assert.equal(typeof input.cleanupProbe, "function");
      return measurements;
    },
  });
  assert.deepEqual(calls, ["create", "run", "close"]);
  assert.deepEqual(result, { status: "passed", stage: "retention", measurements });
  const serialized = JSON.stringify(result);
  for (const privateValue of [privateDatabase, privateLearner, probeSecret, probeTenant]) {
    assert.equal(serialized.includes(privateValue), false);
  }

  const privateFailure = `private-stage-failure-${privateDatabase}`;
  await assert.rejects(
    () => runRealtimeImageProofStage({
      stage: "retention",
      env,
      retentionAdaptersFactory: async () => ({
        observationProbe: async () => {},
        cleanupProbe: async () => {},
        async close() { calls.push("failure-close"); },
      }),
      retentionStage: async () => { throw new Error(privateFailure); },
    }),
    (error) => {
      assert.match(String(error), /realtime proof stage retention failed/i);
      assert.equal(String(error?.stack ?? error).includes(privateFailure), false);
      return true;
    },
  );
  assert.equal(calls.at(-1), "failure-close");

  for (const [key, value] of [
    ["REALTIME_PROOF_NODE_PORT", "8081"],
    ["REALTIME_PROOF_ORIGIN", "http://private.invalid"],
    ["JWT_SECRET", "short"],
    ["REALTIME_PROOF_TIMEOUT_MS", "0"],
  ]) {
    await assert.rejects(
      () => runRealtimeImageProofStage({
        stage: "retention",
        env: { ...env, [key]: value },
        retentionAdaptersFactory: async () => { throw new Error("must not construct"); },
        retentionStage: async () => measurements,
      }),
      /realtime proof stage retention (configuration|failed)/i,
    );
  }
});

test("the protocol and hostile CLI stages dispatch exact validated configuration with no private output", async () => {
  const privateLearner = "private-cli-dispatch-learner";
  const privateMetricsToken = "private-cli-metrics-token";
  const env = {
    JWT_SECRET: probeSecret,
    REALTIME_PROOF_NODE_PORT: "18081",
    REALTIME_PROOF_SECONDARY_NODE_PORT: "18082",
    REALTIME_PROOF_ORIGIN: probeOrigin,
    REALTIME_PROOF_DISALLOWED_ORIGIN: "https://disallowed.quran.example.org",
    REALTIME_PROOF_TENANT_ID: probeTenant,
    REALTIME_PROOF_LEARNER_ID: privateLearner,
    REALTIME_PROOF_METRICS_TOKEN: privateMetricsToken,
    REALTIME_PROOF_TIMEOUT_MS: "10000",
  };
  const protocolMeasurements = stageMeasurements("protocol-parity");
  const hostileMeasurements = stageMeasurements("hostile-capacity");
  const calls = [];
  const protocol = await runRealtimeImageProofStage({
    stage: "protocol-parity",
    env,
    protocolStage: async (input) => {
      calls.push({ stage: "protocol", input });
      return protocolMeasurements;
    },
  });
  const hostile = await runRealtimeImageProofStage({
    stage: "hostile-capacity",
    env,
    hostileCapacityStage: async (input) => {
      calls.push({ stage: "hostile", input });
      return hostileMeasurements;
    },
  });
  assert.deepEqual(protocol, {
    status: "passed",
    stage: "protocol-parity",
    measurements: protocolMeasurements,
  });
  assert.deepEqual(hostile, {
    status: "passed",
    stage: "hostile-capacity",
    measurements: hostileMeasurements,
  });
  assert.equal(calls[0].input.nodePort, 18_081);
  assert.equal(calls[0].input.secondaryNodePort, 18_082);
  assert.equal(calls[0].input.disallowedOrigin, "https://disallowed.quran.example.org");
  assert.equal(calls[1].input.metricsToken, privateMetricsToken);
  for (const result of [protocol, hostile]) {
    const serialized = JSON.stringify(result);
    for (const privateValue of [probeSecret, probeTenant, privateLearner, privateMetricsToken]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  }

  for (const [stage, override] of [
    ["protocol-parity", { REALTIME_PROOF_SECONDARY_NODE_PORT: "18081" }],
    ["protocol-parity", { REALTIME_PROOF_DISALLOWED_ORIGIN: probeOrigin }],
    ["hostile-capacity", { REALTIME_PROOF_METRICS_TOKEN: "" }],
  ]) {
    await assert.rejects(
      () => runRealtimeImageProofStage({
        stage,
        env: { ...env, ...override },
        protocolStage: async () => protocolMeasurements,
        hostileCapacityStage: async () => hostileMeasurements,
      }),
      new RegExp(`realtime proof stage ${stage} (configuration|failed)`, "i"),
    );
  }
});

test("evidence output is external, owner-only, atomic, and write-once", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qrai-realtime-evidence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "evidence.json");
  const evidence = createRealtimeImageEvidence(validInput());

  writeRealtimeImageEvidenceOnce({
    outputPath,
    evidence,
    repositoryRoot: process.cwd(),
    validatedAt: completedAt,
  });
  assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), evidence);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.throws(
    () => writeRealtimeImageEvidenceOnce({
      outputPath,
      evidence,
      repositoryRoot: process.cwd(),
      validatedAt: completedAt,
    }),
    /exist|write-once/i,
  );

  assert.throws(
    () => writeRealtimeImageEvidenceOnce({
      outputPath: join(process.cwd(), "realtime-evidence-must-not-exist.json"),
      evidence,
      repositoryRoot: process.cwd(),
      validatedAt: completedAt,
    }),
    /outside.*checkout/i,
  );
  symlinkSync(process.cwd(), join(directory, "checkout-link"));
  assert.throws(
    () => writeRealtimeImageEvidenceOnce({
      outputPath: join(directory, "checkout-link", "realtime-evidence-must-not-exist.json"),
      evidence,
      repositoryRoot: process.cwd(),
      validatedAt: completedAt,
    }),
    /outside.*checkout/i,
  );
});
