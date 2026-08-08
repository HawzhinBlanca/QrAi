import assert from "node:assert/strict";
import test from "node:test";

import {
  buildObservationRequest,
  candidateBuildArgs,
  candidateRunArgs,
  validateAndSummarizeObservation,
} from "./acoustic-candidate-proof.mjs";

const words = ["word-one", "word-two"];
const vectors = {
  correct: { id: "correct", sampleRate: 16_000, durationSeconds: 1 },
  reference: {
    wordIds: ["1:1:1", "1:1:2"],
    spansMs: [[0, 400], [400, 1_000]],
    textSha256: "sha256:9b2da4e8847068bf0afffb14c7ecc10583a24fa8014ca178bde519fb2cd3944a",
  },
};

function observedResponse(overrides = {}) {
  return {
    status: "observed",
    refusalReason: null,
    observations: [
      {
        analysisBasis: "acoustic",
        calibrationStatus: "uncalibrated",
        coreWordIds: vectors.reference.wordIds,
        referenceDigest: vectors.reference.textSha256,
        predictedPhonemes: "ab",
        phonemeRawProbabilities: [0.7, 0.8],
        sifat: [
          {
            phonemesGroup: "group",
            hams: {
              label: "present",
              labelIndex: 1,
              scoreStatus: "withheld-upstream-decoder-bug",
            },
            jahr: null,
          },
        ],
        ...overrides,
      },
    ],
  };
}

test("exact candidate requests preserve canonical bytes and server-owned spans", () => {
  const request = buildObservationRequest(vectors, vectors.correct, "/proof/correct.wav", words);

  assert.deepEqual(request, {
    audioPath: "/proof/correct.wav",
    sampleRate: 16_000,
    durationMs: 1_000,
    referenceText: "word-one word-two",
    segments: [
      { wordId: "1:1:1", canonicalText: "word-one", startMs: 0, endMs: 400 },
      { wordId: "1:1:2", canonicalText: "word-two", startMs: 400, endMs: 1_000 },
    ],
    coreWordIds: ["1:1:1", "1:1:2"],
  });
});

test("protected proof builds the current target and runs offline without a source mount", () => {
  assert.deepEqual(candidateBuildArgs("qrai-acoustic-proof:abc123"), [
    "build",
    "--target",
    "acoustic-candidate",
    "--file",
    "services/asr-inference/Dockerfile",
    "--tag",
    "qrai-acoustic-proof:abc123",
    ".",
  ]);

  const args = candidateRunArgs({
    imageTag: "qrai-acoustic-proof:abc123",
    containerName: "qrai-acoustic-proof-abc123",
    proofDir: "/private/tmp/qrai-proof",
  });
  assert.ok(args.includes("none"), "candidate proof must disable the container network");
  assert.ok(args.includes("--read-only"), "candidate proof must make the root filesystem read-only");
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("ALL"), "candidate proof must drop every Linux capability");
  assert.ok(
    args.includes("type=bind,src=/private/tmp/qrai-proof,dst=/proof,readonly"),
    "only the generated proof inputs may be mounted read-only",
  );
  assert.ok(!args.some((value) => value.includes("/Users/hawzhin/QrAi")));
  assert.deepEqual(args.slice(-4), [
    "qrai-acoustic-proof:abc123",
    "python",
    "acoustic_tajweed.py",
    "--worker",
  ]);
});

test("exact candidate proof emits only safe, shadow-only observation summaries", () => {
  const summary = validateAndSummarizeObservation(
    observedResponse(),
    vectors,
    vectors.correct.id,
  );

  assert.deepEqual(
    {
      vectorId: summary.vectorId,
      status: summary.status,
      analysisBasis: summary.analysisBasis,
      calibrationStatus: summary.calibrationStatus,
      phonemeCount: summary.phonemeCount,
      phonemeScoreCount: summary.phonemeScoreCount,
      sifatGroupCount: summary.sifatGroupCount,
      sifatUnitCount: summary.sifatUnitCount,
      allSifatScoresWithheld: summary.allSifatScoresWithheld,
      containsLearnerFinding: summary.containsLearnerFinding,
      containsConfidence: summary.containsConfidence,
      containsRawSifatProbability: summary.containsRawSifatProbability,
    },
    {
      vectorId: "correct",
      status: "observed",
      analysisBasis: "acoustic",
      calibrationStatus: "uncalibrated",
      phonemeCount: 2,
      phonemeScoreCount: 2,
      sifatGroupCount: 1,
      sifatUnitCount: 1,
      allSifatScoresWithheld: true,
      containsLearnerFinding: false,
      containsConfidence: false,
      containsRawSifatProbability: false,
    },
  );
  assert.match(summary.predictedPhonemesSha256, /^[a-f0-9]{64}$/);
});

test("exact candidate proof fails closed on learner authority, malformed scores, or score leakage", () => {
  for (const [name, response] of [
    ["learner findings", observedResponse({ findings: [{ rule: "x" }] })],
    ["confidence", observedResponse({ confidence: 0.9 })],
    ["non-finite score", observedResponse({ phonemeRawProbabilities: [Number.NaN] })],
    [
      "unwithheld sifat score",
      observedResponse({
        sifat: [
          {
            phonemesGroup: "group",
            hams: { label: "present", labelIndex: 1, scoreStatus: "available", score: 0.9 },
          },
        ],
      }),
    ],
  ]) {
    assert.throws(
      () => validateAndSummarizeObservation(response, vectors, vectors.correct.id),
      { name: "Error" },
      name,
    );
  }
});
