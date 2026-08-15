#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VECTOR_PATH = path.join(ROOT, "tests/fixtures/audio/muaalem-shadow-vectors.json");
const CANDIDATE_PATH = path.join(ROOT, "services/asr-inference/acoustic-candidates.json");
const QURAN_PATH = path.join(ROOT, "packages/quran-data/src/data/full-quran/surah-001.json");
const CANDIDATE_INPUTS = [
  "services/asr-inference",
  "tests/fixtures/audio",
  "packages/quran-data/src/data/full-quran/surah-001.json",
];

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function requireObject(value, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(message);
  }
  return value;
}

function canonicalReferenceDigest(words) {
  return `sha256:${sha256(Buffer.from(words.join(" "), "utf8"))}`;
}

export function buildObservationRequest(vectors, vector, audioPath, canonicalWords) {
  requireObject(vectors, "invalid vector declaration");
  requireObject(vector, "invalid proof vector");
  const reference = requireObject(vectors.reference, "invalid vector reference");
  if (
    !Array.isArray(canonicalWords) ||
    canonicalWords.length === 0 ||
    canonicalWords.some((word) => typeof word !== "string" || word.length === 0) ||
    !Array.isArray(reference.wordIds) ||
    !Array.isArray(reference.spansMs) ||
    reference.wordIds.length !== canonicalWords.length ||
    reference.spansMs.length !== canonicalWords.length ||
    canonicalReferenceDigest(canonicalWords) !== reference.textSha256
  ) {
    fail("canonical reference does not match the declared proof vectors");
  }
  const durationMs = vector.durationSeconds * 1_000;
  if (
    vector.sampleRate !== 16_000 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    typeof audioPath !== "string" ||
    !audioPath.startsWith("/proof/")
  ) {
    fail("invalid proof vector runtime boundary");
  }

  const segments = reference.spansMs.map((span, index) => {
    if (
      !Array.isArray(span) ||
      span.length !== 2 ||
      !Number.isSafeInteger(span[0]) ||
      !Number.isSafeInteger(span[1]) ||
      span[0] < 0 ||
      span[1] <= span[0] ||
      span[1] > durationMs ||
      (index > 0 && span[0] < reference.spansMs[index - 1][1]) ||
      typeof reference.wordIds[index] !== "string" ||
      reference.wordIds[index].length === 0
    ) {
      fail("invalid server-owned proof span");
    }
    return {
      wordId: reference.wordIds[index],
      canonicalText: canonicalWords[index],
      startMs: span[0],
      endMs: span[1],
    };
  });

  return {
    audioPath,
    sampleRate: 16_000,
    durationMs,
    referenceText: canonicalWords.join(" "),
    segments,
    coreWordIds: [...reference.wordIds],
  };
}

function hasKeyDeep(value, key) {
  if (Array.isArray(value)) {
    return value.some((item) => hasKeyDeep(item, key));
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(
    ([entryKey, entryValue]) => entryKey === key || hasKeyDeep(entryValue, key),
  );
}

function requireExactKeys(value, expected, message) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(message);
  }
}

export function validateAndSummarizeObservation(response, vectors, vectorId) {
  requireObject(response, "candidate worker returned a non-object response");
  requireExactKeys(
    response,
    ["status", "observations", "refusalReason"],
    "candidate worker response shape changed",
  );
  if (
    response.status !== "observed" ||
    response.refusalReason !== null ||
    !Array.isArray(response.observations) ||
    response.observations.length !== 1
  ) {
    fail("candidate worker did not produce exactly one shadow observation");
  }

  const observation = requireObject(
    response.observations[0],
    "candidate worker observation is not an object",
  );
  requireExactKeys(
    observation,
    [
      "analysisBasis",
      "calibrationStatus",
      "coreWordIds",
      "referenceDigest",
      "predictedPhonemes",
      "phonemeRawProbabilities",
      "sifat",
    ],
    "candidate worker observation exposed an unreviewed field",
  );
  if (
    observation.analysisBasis !== "acoustic" ||
    observation.calibrationStatus !== "uncalibrated" ||
    observation.referenceDigest !== vectors.reference.textSha256 ||
    !Array.isArray(observation.coreWordIds) ||
    observation.coreWordIds.length !== vectors.reference.wordIds.length ||
    observation.coreWordIds.some((wordId, index) => wordId !== vectors.reference.wordIds[index]) ||
    typeof observation.predictedPhonemes !== "string" ||
    observation.predictedPhonemes.length === 0 ||
    !Array.isArray(observation.phonemeRawProbabilities) ||
    observation.phonemeRawProbabilities.length === 0 ||
    observation.phonemeRawProbabilities.some(
      (score) => typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1,
    ) ||
    !Array.isArray(observation.sifat) ||
    observation.sifat.length === 0
  ) {
    fail("candidate worker observation violated the shadow contract");
  }

  const containsLearnerFinding =
    hasKeyDeep(response, "findings") || hasKeyDeep(response, "learnerFinding");
  const containsConfidence = hasKeyDeep(response, "confidence");
  const containsRawSifatProbability =
    hasKeyDeep(observation.sifat, "rawProbability") ||
    hasKeyDeep(observation.sifat, "probability") ||
    hasKeyDeep(observation.sifat, "prob") ||
    hasKeyDeep(observation.sifat, "score");
  if (containsLearnerFinding || containsConfidence || containsRawSifatProbability) {
    fail("candidate worker leaked learner authority or an unreviewed sifat score");
  }

  let sifatUnitCount = 0;
  for (const groupValue of observation.sifat) {
    const group = requireObject(groupValue, "candidate worker emitted an invalid sifat group");
    if (typeof group.phonemesGroup !== "string" || group.phonemesGroup.length === 0) {
      fail("candidate worker emitted an invalid sifat group label");
    }
    for (const [name, unitValue] of Object.entries(group)) {
      if (name === "phonemesGroup" || unitValue === null) {
        continue;
      }
      const unit = requireObject(unitValue, "candidate worker emitted an invalid sifat unit");
      requireExactKeys(
        unit,
        ["label", "labelIndex", "scoreStatus"],
        "candidate worker emitted an unreviewed sifat unit field",
      );
      if (
        typeof unit.label !== "string" ||
        unit.label.length === 0 ||
        !Number.isSafeInteger(unit.labelIndex) ||
        unit.labelIndex < 0 ||
        unit.scoreStatus !== "withheld-upstream-decoder-bug"
      ) {
        fail("candidate worker did not withhold every sifat numeric score");
      }
      sifatUnitCount += 1;
    }
  }

  const scores = observation.phonemeRawProbabilities;
  return {
    vectorId,
    status: "observed",
    analysisBasis: "acoustic",
    calibrationStatus: "uncalibrated",
    phonemeCount: [...observation.predictedPhonemes].length,
    phonemeScoreCount: scores.length,
    phonemeScoreMin: Math.min(...scores),
    phonemeScoreMax: Math.max(...scores),
    predictedPhonemesSha256: sha256(Buffer.from(observation.predictedPhonemes, "utf8")),
    sifatGroupCount: observation.sifat.length,
    sifatUnitCount,
    allSifatScoresWithheld: true,
    containsLearnerFinding,
    containsConfidence,
    containsRawSifatProbability,
  };
}

export function candidateBuildArgs(imageTag) {
  if (typeof imageTag !== "string" || !/^qrai-acoustic-proof:[a-f0-9]{6,40}$/.test(imageTag)) {
    fail("invalid candidate proof image tag");
  }
  return [
    "build",
    "--target",
    "acoustic-candidate",
    "--file",
    "services/asr-inference/Dockerfile",
    "--tag",
    imageTag,
    ".",
  ];
}

export function candidateRunArgs({ imageTag, containerName, proofDir }) {
  candidateBuildArgs(imageTag);
  if (
    typeof containerName !== "string" ||
    !/^qrai-acoustic-proof-[a-f0-9-]+$/.test(containerName) ||
    typeof proofDir !== "string" ||
    !path.isAbsolute(proofDir) ||
    proofDir.includes(",")
  ) {
    fail("invalid candidate proof container boundary");
  }
  return [
    "run",
    "--rm",
    "--interactive",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=32m",
    "--mount",
    `type=bind,src=${proofDir},dst=/proof,readonly`,
    imageTag,
    "python",
    "acoustic_tajweed.py",
    "--worker",
  ];
}

function wavFromPcm16(pcm, sampleRate, channels) {
  const frameBytes = channels * 2;
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isSafeInteger(channels) ||
    channels <= 0 ||
    pcm.length % frameBytes !== 0
  ) {
    fail("invalid PCM proof source");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * frameBytes, 28);
  header.writeUInt16LE(frameBytes, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function deriveProofAudio(vectors, proofDir) {
  const pcm = readFileSync(path.join(ROOT, vectors.source.pcmFile));
  if (pcm.length !== vectors.source.pcmByteLength || sha256(pcm) !== vectors.source.pcmSha256) {
    fail("manifest-bound PCM proof source does not match its digest");
  }
  const frameBytes = vectors.correct.channels * 2;
  const start = vectors.correct.startSample * frameBytes;
  const end = (vectors.correct.startSample + vectors.correct.sampleCount) * frameBytes;
  if (start < 0 || end > pcm.length || end <= start) {
    fail("declared correct vector does not fit its PCM source");
  }
  const correctPcm = Buffer.from(pcm.subarray(start, end));
  if (sha256(correctPcm) !== vectors.correct.pcmSha256) {
    fail("correct vector PCM digest mismatch");
  }
  const correctWav = wavFromPcm16(
    correctPcm,
    vectors.correct.sampleRate,
    vectors.correct.channels,
  );
  if (sha256(correctWav) !== vectors.correct.sha256) {
    fail("correct vector WAV digest mismatch");
  }

  const alteredPcm = Buffer.from(correctPcm);
  alteredPcm.fill(
    0,
    vectors.altered.muteStartSample * frameBytes,
    vectors.altered.muteEndSampleExclusive * frameBytes,
  );
  if (sha256(alteredPcm) !== vectors.altered.pcmSha256) {
    fail("altered vector PCM digest mismatch");
  }
  const alteredWav = wavFromPcm16(
    alteredPcm,
    vectors.correct.sampleRate,
    vectors.correct.channels,
  );
  if (sha256(alteredWav) !== vectors.altered.sha256) {
    fail("altered vector WAV digest mismatch");
  }

  writeFileSync(path.join(proofDir, "correct.wav"), correctWav, { mode: 0o444 });
  writeFileSync(path.join(proofDir, "altered.wav"), alteredWav, { mode: 0o444 });
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").slice(-4_000);
    fail(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout?.trim() ?? "";
}

function parseMemoryMiB(value) {
  const match = String(value).trim().match(/^([0-9]+(?:\.[0-9]+)?)(B|KiB|MiB|GiB|TiB)$/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const factors = { B: 1 / 1024 / 1024, KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1024 * 1024 };
  return amount * factors[match[2]];
}

async function runCandidateWorker(args, containerName, requests) {
  const child = spawn("docker", args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let stdoutBuffer = "";
  const lines = [];
  const waiters = [];
  let exited = false;
  let exitCode = null;

  function settleLines() {
    while (lines.length > 0 && waiters.length > 0) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(lines.shift());
    }
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    while (stdoutBuffer.includes("\n")) {
      const newline = stdoutBuffer.indexOf("\n");
      lines.push(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
    }
    settleLines();
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8_000);
  });
  child.once("error", (error) => {
    exited = true;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("candidate worker exited before returning proof"));
      }
      resolve(code);
    });
  });

  function nextLine() {
    if (lines.length > 0) {
      return Promise.resolve(lines.shift());
    }
    if (exited) {
      return Promise.reject(new Error("candidate worker is not running"));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error("candidate worker proof timed out"));
      }, 120_000);
      waiters.push(waiter);
    });
  }

  let sampling = true;
  const memorySamples = [];
  const sampler = (async () => {
    while (sampling) {
      try {
        const { stdout } = await execFile(
          "docker",
          ["stats", "--no-stream", "--format", "{{.MemUsage}}", containerName],
          { cwd: ROOT, timeout: 5_000 },
        );
        const used = parseMemoryMiB(stdout.split("/")[0]);
        if (used !== null && Number.isFinite(used)) {
          memorySamples.push(used);
        }
      } catch {
        // The first sample can race container creation and the last can race `--rm` cleanup.
      }
      if (sampling) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  })();

  const responses = [];
  try {
    for (const request of requests) {
      const started = performance.now();
      child.stdin.write(`${JSON.stringify(request)}\n`);
      const line = await nextLine();
      responses.push({ response: JSON.parse(line), wallLatencyMs: Math.round(performance.now() - started) });
    }
    child.stdin.end();
    const code = await exitPromise;
    if (code !== 0) {
      fail(`candidate worker exited ${code}${stderr ? `: ${stderr}` : ""}`);
    }
  } finally {
    sampling = false;
    await sampler;
    if (!exited) {
      child.kill("SIGTERM");
      await exitPromise;
    }
    if (exitCode !== 0 && exitCode !== null) {
      spawnSync("docker", ["rm", "--force", containerName], { stdio: "ignore" });
    }
  }

  return {
    responses,
    memory: {
      sampleCount: memorySamples.length,
      peakContainerMemoryMiB: memorySamples.length > 0 ? Math.max(...memorySamples) : null,
      finalContainerMemoryMiB: memorySamples.length > 0 ? memorySamples.at(-1) : null,
    },
  };
}

function compareRecordedStructuralProof(actual, recorded) {
  const exactFields = [
    "vectorId",
    "status",
    "analysisBasis",
    "calibrationStatus",
    "phonemeCount",
    "phonemeScoreCount",
    "predictedPhonemesSha256",
    "sifatGroupCount",
    "sifatUnitCount",
    "allSifatScoresWithheld",
    "containsLearnerFinding",
    "containsConfidence",
    "containsRawSifatProbability",
  ];
  for (const field of exactFields) {
    if (actual[field] !== recorded[field]) {
      fail(`exact candidate structural output changed at ${field}`);
    }
  }
  for (const field of ["phonemeScoreMin", "phonemeScoreMax"]) {
    if (Math.abs(actual[field] - recorded[field]) > 0.000_001) {
      fail(`exact candidate numeric shadow output changed at ${field}`);
    }
  }
}

function parseArgs(argv) {
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output" && index + 1 < argv.length) {
      output = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      fail("usage: node scripts/acoustic-candidate-proof.mjs --output <external-json-path>");
    }
  }
  if (!output) {
    fail("usage: node scripts/acoustic-candidate-proof.mjs --output <external-json-path>");
  }
  const relative = path.relative(ROOT, output);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    fail("candidate proof output must be outside the candidate checkout");
  }
  return { output };
}

async function main() {
  const { output } = parseArgs(process.argv.slice(2));
  const dirtyCandidateInputs = runChecked("git", ["status", "--porcelain", "--", ...CANDIDATE_INPUTS]);
  if (dirtyCandidateInputs) {
    fail("candidate image inputs differ from the committed candidate SHA");
  }
  const candidateSha = runChecked("git", ["rev-parse", "HEAD"]);
  const vectors = readJson(VECTOR_PATH);
  const registry = readJson(CANDIDATE_PATH);
  const candidate = registry.candidates?.find((item) => item.id === registry.activeCandidateId);
  if (
    vectors.schemaVersion !== 2 ||
    vectors.releaseEligible !== false ||
    !candidate ||
    candidate.status !== "shadow-only" ||
    candidate.releaseEligible !== false ||
    vectors.candidate.id !== candidate.id ||
    vectors.candidate.artifactSha256 !== candidate.model.artifactSha256
  ) {
    fail("candidate proof identities are not immutable and shadow-only");
  }

  const quran = readJson(QURAN_PATH);
  const ayah = quran.ayahs?.find((item) => item.ayahNumber === vectors.reference.ayah);
  if (!ayah || quran.surahNumber !== vectors.reference.surah || !Array.isArray(ayah.words)) {
    fail("canonical proof reference is unavailable");
  }

  const proofDir = mkdtempSync(path.join(tmpdir(), "qrai-acoustic-proof-"));
  const imageTag = `qrai-acoustic-proof:${candidateSha.slice(0, 12)}`;
  const containerName = `qrai-acoustic-proof-${candidateSha.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  try {
    deriveProofAudio(vectors, proofDir);
    console.log("Building the exact acoustic-candidate target...");
    runChecked("docker", candidateBuildArgs(imageTag), { stdio: "inherit" });
    const inspected = JSON.parse(
      runChecked("docker", ["image", "inspect", imageTag, "--format", "{{json .}}"]),
    );
    if (
      !/^sha256:[a-f0-9]{64}$/.test(inspected.Id) ||
      typeof inspected.Architecture !== "string" ||
      inspected.Architecture.length === 0 ||
      !Number.isSafeInteger(inspected.Size) ||
      inspected.Size <= 0 ||
      !inspected.Config ||
      !inspected.Config.User ||
      inspected.Config.User === "root" ||
      inspected.Config.User === "0"
    ) {
      fail("candidate image identity or non-root runtime is invalid");
    }

    const correctRequest = buildObservationRequest(
      vectors,
      vectors.correct,
      "/proof/correct.wav",
      ayah.words,
    );
    const alteredRequest = buildObservationRequest(
      vectors,
      vectors.correct,
      "/proof/altered.wav",
      ayah.words,
    );
    const execution = await runCandidateWorker(
      candidateRunArgs({ imageTag, containerName, proofDir }),
      containerName,
      [correctRequest, alteredRequest],
    );
    const summaries = execution.responses.map((item, index) => {
      const vector = index === 0 ? vectors.correct : vectors.altered;
      const summary = validateAndSummarizeObservation(item.response, vectors, vector.id);
      const recorded = vectors.exactImageProof.observations.find(
        (observation) => observation.vectorId === vector.id,
      );
      if (!recorded) {
        fail("recorded exact-image observation is unavailable");
      }
      compareRecordedStructuralProof(summary, recorded);
      return { ...summary, wallLatencyMs: item.wallLatencyMs };
    });
    if (summaries[0].predictedPhonemesSha256 === summaries[1].predictedPhonemesSha256) {
      fail("correct and altered vectors produced the same structural observation");
    }
    if (
      execution.memory.sampleCount < 2 ||
      execution.memory.peakContainerMemoryMiB === null ||
      execution.memory.finalContainerMemoryMiB === null
    ) {
      fail("candidate proof did not capture bounded runtime memory evidence");
    }

    const proof = {
      schemaVersion: 1,
      evidenceKind: "protected-acoustic-shadow-structural-proof",
      evidenceEligibility: "integration-only-not-model-evaluation-or-calibration",
      releaseEligible: false,
      generatedAt: new Date().toISOString(),
      candidateSha,
      candidate: {
        id: candidate.id,
        status: candidate.status,
        modelRevision: candidate.model.revision,
        artifactSha256: candidate.model.artifactSha256,
        implementationCommit: candidate.implementation.commit,
        qpsCommit: candidate.qps.commit,
        qpsProfileId: candidate.qps.profileId,
        qpsProfileChecksum: candidate.qps.profileChecksum,
      },
      image: {
        target: "acoustic-candidate",
        digest: inspected.Id,
        architecture: inspected.Architecture,
        sizeBytes: inspected.Size,
        user: inspected.Config.User,
        network: "none",
        rootFilesystemReadOnly: true,
        sourceMounted: false,
        proofInputsMountedReadOnly: true,
      },
      vectors: {
        declarationId: vectors.id,
        correctSha256: vectors.correct.sha256,
        alteredSha256: vectors.altered.sha256,
        canonicalReferenceSha256: vectors.reference.textSha256,
      },
      observations: summaries,
      performanceObservation: {
        claim: "single-host-engineering-observation-only-not-release-benchmark",
        benchmarkEligible: false,
        releaseCriteriaSatisfied: false,
        coldWallLatencyMs: summaries[0].wallLatencyMs,
        warmAlteredWallLatencyMs: summaries[1].wallLatencyMs,
        ...execution.memory,
      },
    };
    mkdirSync(path.dirname(output), { recursive: true });
    const temporaryOutput = `${output}.tmp-${process.pid}`;
    writeFileSync(temporaryOutput, `${JSON.stringify(proof, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryOutput, output);
    console.log(`Protected acoustic shadow proof written to ${output}`);
  } finally {
    rmSync(proofDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`acoustic candidate proof failed: ${error.message}`);
    process.exitCode = 1;
  });
}
