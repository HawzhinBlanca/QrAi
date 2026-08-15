import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const DIGEST = `sha256:${"a".repeat(64)}`;

function runPython(source) {
  const result = spawnSync("python3", ["-c", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: `${process.cwd()}/services/asr-inference`,
    },
  });
  assert.equal(
    result.status,
    0,
    `Python readiness case failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test("unloaded ASR is live but not ready and owns exactly one loader worker", () => {
  runPython(`
import threading, time
from readiness import AsrReadinessController

digest = ${JSON.stringify(DIGEST)}
entered = threading.Event()
release = threading.Event()

def load():
    entered.set()
    assert release.wait(2)
    return digest

controller = AsrReadinessController(
    model_id="fixture/asr",
    expected_digest=digest,
    load_and_resolve=load,
    probe=lambda: None,
    probe_timeout_seconds=0.2,
    retry_seconds=0.01,
)
assert controller.start() is True
assert entered.wait(1)
assert controller.start() is False
snapshot = controller.snapshot()
assert snapshot.ready is False
assert snapshot.phase == "loading"
assert snapshot.reason == "model-loading"
release.set()
deadline = time.monotonic() + 1
while not controller.snapshot().ready and time.monotonic() < deadline:
    time.sleep(0.005)
assert controller.snapshot().ready is True
controller.stop()
`);
});

test("a failed model load is 503-equivalent and one worker recovers on retry", () => {
  runPython(`
import time
from readiness import AsrReadinessController

digest = ${JSON.stringify(DIGEST)}
attempts = 0

def load():
    global attempts
    attempts += 1
    if attempts == 1:
        raise RuntimeError("declared transient fixture failure")
    return digest

controller = AsrReadinessController(
    model_id="fixture/asr",
    expected_digest=digest,
    load_and_resolve=load,
    probe=lambda: None,
    probe_timeout_seconds=0.2,
    retry_seconds=0.05,
)
controller.start()
deadline = time.monotonic() + 1
saw_failure = False
while time.monotonic() < deadline:
    snapshot = controller.snapshot()
    saw_failure = saw_failure or snapshot.reason == "model-load-failed"
    if snapshot.ready:
        break
    time.sleep(0.002)
snapshot = controller.snapshot()
assert saw_failure
assert snapshot.ready is True
assert snapshot.attempt == 2
assert attempts == 2
controller.stop()
`);
});

test("missing and wrong selected-model digests fail closed", () => {
  runPython(`
import time
from readiness import AsrReadinessController

actual = ${JSON.stringify(DIGEST)}
cases = [
    (None, "model-digest-missing"),
    ("sha256:" + "b" * 64, "model-digest-mismatch"),
]
for expected, reason in cases:
    controller = AsrReadinessController(
        model_id="fixture/asr",
        expected_digest=expected,
        load_and_resolve=lambda: actual,
        probe=lambda: None,
        probe_timeout_seconds=0.2,
        retry_seconds=10,
    )
    controller.start()
    deadline = time.monotonic() + 1
    while controller.snapshot().phase != "failed" and time.monotonic() < deadline:
        time.sleep(0.002)
    snapshot = controller.snapshot()
    assert snapshot.ready is False
    assert snapshot.reason == reason
    assert snapshot.artifact_digest == actual
    controller.stop()
`);
});

test("a permanent digest refusal never creates a reload storm or a replacement worker", () => {
  runPython(`
import time
from readiness import AsrReadinessController

actual = ${JSON.stringify(DIGEST)}
loads = 0
def load():
    global loads
    loads += 1
    return actual

controller = AsrReadinessController(
    model_id="fixture/asr",
    expected_digest="sha256:" + "b" * 64,
    load_and_resolve=load,
    probe=lambda: None,
    probe_timeout_seconds=0.2,
    retry_seconds=0.01,
)
controller.start()
deadline = time.monotonic() + 1
while controller.snapshot().phase != "failed" and time.monotonic() < deadline:
    time.sleep(0.002)
time.sleep(0.05)
assert controller.snapshot().reason == "model-digest-mismatch"
assert loads == 1
assert controller.start() is False
controller.stop()
`);
});

test("a transient known-audio probe failure retries and recovers", () => {
  runPython(`
import time
from readiness import AsrReadinessController

digest = ${JSON.stringify(DIGEST)}
probes = 0
def probe():
    global probes
    probes += 1
    if probes == 1:
        raise RuntimeError("declared transient probe fixture failure")

controller = AsrReadinessController(
    model_id="fixture/asr",
    expected_digest=digest,
    load_and_resolve=lambda: digest,
    probe=probe,
    probe_timeout_seconds=0.2,
    retry_seconds=0.02,
)
controller.start()
deadline = time.monotonic() + 1
while not controller.snapshot().ready and time.monotonic() < deadline:
    time.sleep(0.002)
snapshot = controller.snapshot()
assert snapshot.ready is True
assert snapshot.attempt == 2
assert probes == 2
controller.stop()
`);
});

test("a probe that exceeds its deadline stays unready without overlapping probe workers", () => {
  runPython(`
import threading, time
from readiness import AsrReadinessController

digest = ${JSON.stringify(DIGEST)}
entered = threading.Event()
release = threading.Event()
calls = 0

def probe():
    global calls
    calls += 1
    entered.set()
    release.wait(1)

controller = AsrReadinessController(
    model_id="fixture/asr",
    expected_digest=digest,
    load_and_resolve=lambda: digest,
    probe=probe,
    probe_timeout_seconds=0.02,
    retry_seconds=0.01,
)
controller.start()
assert entered.wait(1)
deadline = time.monotonic() + 1
while controller.snapshot().reason != "known-audio-probe-timeout" and time.monotonic() < deadline:
    time.sleep(0.002)
snapshot = controller.snapshot()
assert snapshot.ready is False
assert snapshot.reason == "known-audio-probe-timeout"
assert controller.start() is False
time.sleep(0.05)
assert calls == 1
release.set()
controller.stop()
`);
});

test("the declared known-audio probe fixture is exact, short, and contains no learner audio", () => {
  runPython(`
import hashlib, io, wave
from readiness import known_audio_wav_bytes

audio = known_audio_wav_bytes()
assert len(audio) == 3244
assert hashlib.sha256(audio).hexdigest() == "2976da01e205a110c9fa41d47659e238a5c6d3c3f3137582f2949853faa201dd"
with wave.open(io.BytesIO(audio), "rb") as wav:
    assert wav.getnchannels() == 1
    assert wav.getsampwidth() == 2
    assert wav.getframerate() == 16000
    assert wav.getnframes() == 1600
    assert wav.readframes(1600) == b"\\x00" * 3200
`);
});

test("production wiring keeps liveness separate and makes Compose consume readiness", () => {
  const server = readFileSync("services/asr-inference/server.py", "utf8");
  const dockerfile = readFileSync("services/asr-inference/Dockerfile", "utf8");
  const compose = readFileSync("docker-compose.yml", "utf8");
  const staging = readFileSync("scripts/recreate-staging.sh", "utf8");

  assert.match(server, /AsrReadinessController/);
  assert.match(server, /@app\.get\("\/health"\)[\s\S]*?@app\.get\("\/ready"\)/);
  assert.doesNotMatch(server, /\n_load_model\(\)\n\napp = FastAPI/);
  assert.match(server, /ASR_READINESS_PROBE_TIMEOUT_SECONDS", "60"/);
  assert.match(dockerfile, /readiness\.py/);
  assert.match(compose, /ASR_MODEL_DIGEST:\s*"sha256:ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e"/);
  assert.match(compose, /localhost:8091\/ready/);
  assert.match(staging, /wait_for_health "asr-inference" "http:\/\/localhost:8091\/ready"/);
});
