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
  createRealtimeProofPreflight,
  parseRealtimeProofPort,
  validateRealtimeProofRenderedTopology,
} from "../../scripts/lib/realtime-image-probe.mjs";
import { parseRealtimeImageProofArguments } from "../../scripts/realtime-image-proof.mjs";

const MiB = 1024 * 1024;
const candidateSha = "0123456789abcdef0123456789abcdef01234567";
const previousSha = "89abcdef0123456789abcdef0123456789abcdef";
const selectionCreatedAt = "2026-08-08T07:59:00.000Z";
const startedAt = "2026-08-08T08:00:00.000Z";
const completedAt = "2026-08-08T08:51:00.000Z";
const expiresAt = "2026-08-09T08:51:00.000Z";

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
        framesSent: 12,
        accepted: 7,
        rejected: 2,
        lost: 2,
        uncertain: 1,
        durableLost: 2,
        durableOrphan: 1,
        repaired: 3,
        outstandingActionable: 0,
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

function renderedProofTopology(value = selection(), nodePort = 18_081) {
  const environment = composeImageEnvironment(value, "candidate");
  const storage = {
    AUDIO_STORAGE_DRIVER: "s3",
    AUDIO_STORAGE_FILESYSTEM_ACKNOWLEDGED_DEV_ONLY: "0",
    AUDIO_STORAGE_S3_BUCKET: "qrai-production-private-audio",
    AUDIO_STORAGE_S3_REGION: "eu-central-1",
    AUDIO_STORAGE_S3_EXPECTED_OWNER: "123456789012",
    AUDIO_STORAGE_S3_ENCRYPTION: "AES256",
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
        environment: { ...storage },
        ports: [{
          mode: "ingress",
          target: 8081,
          published: String(nodePort),
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
    [(copy) => { copy.stages[1].measurements.ackFieldCount = 8; }, /seven-field/i],
    [(copy) => { copy.stages[2].measurements.lost = 1; }, /accounting|loss/i],
    [(copy) => { copy.stages[2].measurements.ackP95Ms = 250; }, /p95/i],
    [(copy) => { copy.stages[2].measurements.sessionsAccepted = 99; }, /100 sessions/i],
    [(copy) => { copy.stages[3].measurements.retentionModesTested = 2; }, /retention/i],
    [(copy) => { copy.stages[3].measurements.privacyLeaks = 1; }, /privacy/i],
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
  for (const stage of REQUIRED_REALTIME_IMAGE_STAGES) assert.match(rendered, new RegExp(stage));
  assert.match(rendered, /down.*--remove-orphans/);
  assert.doesNotMatch(rendered, /cargo run|pnpm.*dev|server\/src\/realtime\/main\.mjs|--build|docker build/);
  assert.throws(() => realtimeImageCommandPlan({ projectName: "../../unsafe" }), /projectName/);
});

test("the proof overlay exposes only Node realtime on a configurable loopback and forces production S3", () => {
  const overlay = parseYaml(readFileSync("docker-compose.realtime-proof.yml", "utf8"));
  assert.deepEqual(
    overlay.services?.["node-realtime"]?.ports,
    ["127.0.0.1:${REALTIME_PROOF_NODE_PORT:-18081}:8081"],
  );
  assert.equal(overlay.services?.["realtime-gateway"], undefined);

  for (const service of ["node-api", "job-worker", "node-realtime"]) {
    const config = overlay.services?.[service];
    assert.equal(config?.build, undefined);
    assert.equal(config?.image, undefined);
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
  });
  assert.equal(preflight.sourceState.headSha, candidateSha);
  assert.deepEqual(preflight.topology, validated.topology);

  const cases = [
    [(copy) => { copy.services["node-realtime"].ports[0].host_ip = "0.0.0.0"; }, /loopback/i],
    [(copy) => { copy.services["node-realtime"].ports[0].published = "8081"; }, /Node.*port|8081/i],
    [(copy) => { copy.services["realtime-gateway"].ports[0].published = "18081"; }, /Rust.*8081/i],
    [(copy) => { copy.services["node-realtime"].image = "qrai/node-backend:mutable"; }, /selected.*image/i],
    [(copy) => { copy.services["node-api"].build = { context: "." }; }, /source build/i],
    [(copy) => { copy.services["job-worker"].environment.AUDIO_STORAGE_DRIVER = "filesystem"; }, /production S3/i],
    [(copy) => { copy.services["node-realtime"].environment.AUDIO_STORAGE_S3_EXPECTED_OWNER = ""; }, /expected owner/i],
    [(copy) => { copy.services["node-api"].environment.AUDIO_STORAGE_S3_BUCKET = "another-bucket"; }, /same production S3/i],
    [(copy) => { copy.services["node-realtime"].ports.push(copy.services["node-realtime"].ports[0]); }, /exactly one/i],
  ];
  for (const [mutate, pattern] of cases) {
    const copy = structuredClone(rendered);
    mutate(copy);
    assert.throws(
      () => validateRealtimeProofRenderedTopology({ rendered: copy, selection: value, nodePort: 18_081 }),
      pattern,
    );
  }
  assert.throws(
    () => createRealtimeProofPreflight({
      sourceState: { headSha: candidateSha, clean: false },
      selection: value,
      rendered,
      nodePort: 18_081,
    }),
    /clean/i,
  );
  assert.throws(
    () => createRealtimeProofPreflight({
      sourceState: { headSha: previousSha, clean: true },
      selection: value,
      rendered,
      nodePort: 18_081,
    }),
    /candidate SHA/i,
  );
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
    "--acknowledge-staging-isolated", "yes",
  ];
  assert.deepEqual(parseRealtimeImageProofArguments(valid), {
    command: "preflight",
    selectionPath: "/tmp/release-selection.json",
    projectName: "qrai-realtime-proof",
    provider: "release-staging",
    actorClass: "release-operator",
    nodePort: 18_081,
  });

  const cases = [
    [[...valid, "--skip-soak", "yes"], /unknown|exact/i],
    [[...valid, "--provider", "other"], /duplicate/i],
    [[...valid.slice(0, 2), "relative.json", ...valid.slice(3)], /absolute/i],
    [[...valid.slice(0, 4), "../../unsafe", ...valid.slice(5)], /project/i],
    [[...valid.slice(0, 10), "8081", ...valid.slice(11)], /8081|proof port/i],
    [[...valid.slice(0, 12), "no"], /acknowledge/i],
    [[...valid.slice(0, 6), "bad provider", ...valid.slice(7)], /provider/i],
    [[...valid.slice(0, 8), "developer", ...valid.slice(9)], /actor/i],
  ];
  for (const [argv, pattern] of cases) {
    assert.throws(() => parseRealtimeImageProofArguments(argv), pattern);
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
