import hashlib
import asyncio
import copy
import json
from dataclasses import dataclass
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from acoustic_tajweed import (
    AcousticRefusal,
    AcousticEngine,
    AcousticWorkerClient,
    _serialize_sifat,
    build_qps_reference,
    load_shadow_candidate,
    select_model_dtype,
    validate_observation_request,
)
from calibration_registry import load_calibrator_registry, resolve_approved_calibrator


ROOT = Path(__file__).resolve().parent


def _approved_calibrator(artifact: Path) -> dict:
    return {
        "id": "muaalem-v3.2-platt-kurdish-l1-v1",
        "status": "approved",
        "method": "platt",
        "artifactPath": artifact.name,
        "artifactSha256": "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest(),
        "artifactSizeBytes": artifact.stat().st_size,
        "scorerArtifactSha256": "sha256:" + "1" * 64,
        "datasetManifestSha256": "sha256:" + "2" * 64,
        "evaluationEvidenceSha256": "sha256:" + "3" * 64,
    }


def _write_calibrator_registry(path: Path, record: dict | None) -> Path:
    value = {
        "schemaVersion": 1,
        "activeCalibratorId": record["id"] if record is not None else None,
        "calibrators": [] if record is None else [record],
    }
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def test_production_calibrator_registry_is_valid_and_has_no_active_authority():
    registry = load_calibrator_registry(ROOT / "calibrator-registry.json")

    assert registry == {
        "schemaVersion": 1,
        "activeCalibratorId": None,
        "calibrators": [],
    }
    assert resolve_approved_calibrator(
        registry,
        scorer_artifact_sha256="sha256:" + "1" * 64,
        dataset_manifest_sha256="sha256:" + "2" * 64,
        evaluation_evidence_sha256="sha256:" + "3" * 64,
        artifact_root=ROOT,
    ) == {"status": "unavailable", "reason": "no-approved-calibrator"}


def test_calibrator_resolution_requires_exact_scorer_dataset_evaluation_and_artifact_bytes(
    tmp_path,
):
    artifact = tmp_path / "calibrator.json"
    artifact.write_bytes(b"declared calibrator fixture")
    record = _approved_calibrator(artifact)
    registry = load_calibrator_registry(
        _write_calibrator_registry(tmp_path / "registry.json", record)
    )

    resolved = resolve_approved_calibrator(
        registry,
        scorer_artifact_sha256=record["scorerArtifactSha256"],
        dataset_manifest_sha256=record["datasetManifestSha256"],
        evaluation_evidence_sha256=record["evaluationEvidenceSha256"],
        artifact_root=tmp_path,
    )
    assert resolved["status"] == "active"
    assert resolved["calibrator"] == record

    bindings = {
        "scorer_artifact_sha256": record["scorerArtifactSha256"],
        "dataset_manifest_sha256": record["datasetManifestSha256"],
        "evaluation_evidence_sha256": record["evaluationEvidenceSha256"],
    }
    for field in bindings:
        mismatched = {**bindings, field: "sha256:" + "9" * 64}
        assert resolve_approved_calibrator(
            registry, artifact_root=tmp_path, **mismatched
        ) == {"status": "unavailable", "reason": "calibrator-binding-mismatch"}

    artifact.write_bytes(b"tampered")
    assert resolve_approved_calibrator(
        registry,
        artifact_root=tmp_path,
        **bindings,
    ) == {"status": "unavailable", "reason": "calibrator-artifact-mismatch"}


def test_invalid_registry_or_active_calibrator_on_shadow_candidate_fails_closed(tmp_path):
    unresolved = tmp_path / "unresolved.json"
    unresolved.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "activeCalibratorId": "missing",
                "calibrators": [],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="active calibrator must resolve exactly once"):
        load_calibrator_registry(unresolved)

    artifact = tmp_path / "calibrator.json"
    artifact.write_bytes(b"declared calibrator fixture")
    active = _write_calibrator_registry(
        tmp_path / "active.json", _approved_calibrator(artifact)
    )
    with pytest.raises(ValueError, match="shadow candidate cannot activate a calibrator"):
        load_shadow_candidate(ROOT / "acoustic-candidates.json", calibrator_registry_path=active)


def test_shadow_candidate_is_exactly_pinned_and_explicitly_not_release_eligible():
    candidate = load_shadow_candidate(ROOT / "acoustic-candidates.json")

    assert candidate["id"] == "muaalem-v3.2-shadow"
    assert candidate["status"] == "shadow-only"
    assert candidate["releaseEligible"] is False
    assert candidate["model"]["revision"] == "01a1ef9fbe40d144ef845101e89ff924aed3fef5"
    assert candidate["model"]["artifactSha256"] == (
        "sha256:6b6a2e85303d17ff0f3af5e1fc79ac83daecee409c756ddf27f0ced59393bb41"
    )
    assert candidate["model"]["artifactSizeBytes"] == 2_423_124_012
    assert {
        item["path"]: (item["sha256"], item["sizeBytes"])
        for item in candidate["model"]["files"]
    } == {
        "added_tokens.json": (
            "sha256:8ac65705686105b31937d2fa8c15f3d7143ead07fb46380ec28042aa4f25e2ee",
            45,
        ),
        "config.json": (
            "sha256:2094c962ca4a167304d8a2c6d2ca429060cbb6c817de09904739ab088bbcf16f",
            2_183,
        ),
        "model.safetensors": (
            "sha256:6b6a2e85303d17ff0f3af5e1fc79ac83daecee409c756ddf27f0ced59393bb41",
            2_423_124_012,
        ),
        "preprocessor_config.json": (
            "sha256:8e6281aad64f97e40534135a59dcc5d33571efae376f2a25adf5551951897ab4",
            275,
        ),
        "special_tokens_map.json": (
            "sha256:e9f51460cefd9c0211c0f0f346682595d02936f05b2ebd409d9fc05c78e481d5",
            96,
        ),
        "tokenizer_config.json": (
            "sha256:c778e27e2430b6743c5501b7e045ed2928257e7ac430442c3772df6d7ec74e82",
            1_090,
        ),
        "vocab.json": (
            "sha256:dcbdac0162632df023002ca1cdd48e74f0f77a328d7f69503f9ff021afb19473",
            1_532,
        ),
    }
    assert candidate["implementation"]["commit"] == (
        "2e444e040516781ecef72fe9bbc513bb34dedad4"
    )
    assert candidate["qps"]["commit"] == "fb64a1a8b0d7f5c38ffe26de0c69cc4a2b840950"
    assert candidate["limits"] == {
        "sampleRate": 16_000,
        "maxWindowMs": 15_000,
        "maxWords": 256,
    }


def test_shadow_candidate_refuses_an_unpinned_or_inconsistent_model_file(tmp_path):
    manifest = json.loads((ROOT / "acoustic-candidates.json").read_text(encoding="utf-8"))
    manifest["candidates"][0]["model"]["files"][0]["sha256"] = "mutable"
    path = tmp_path / "invalid-acoustic-candidate.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="acoustic model file digest must be sha256"):
        load_shadow_candidate(path)


def test_cpu_model_runtime_uses_float32_instead_of_nan_prone_bfloat16():
    fake_torch = SimpleNamespace(float32="float32", bfloat16="bfloat16")

    assert select_model_dtype(fake_torch, "cpu", None) == "float32"
    assert select_model_dtype(fake_torch, "cuda", None) == "bfloat16"
    assert select_model_dtype(fake_torch, "cpu", "bfloat16") == "bfloat16"
    with pytest.raises(AcousticRefusal, match="invalid-acoustic-runtime-configuration"):
        select_model_dtype(fake_torch, "cpu", "float16")


def test_sifat_categorical_observation_withholds_upstream_decoder_score():
    @dataclass
    class Unit:
        text: str
        prob: float
        idx: int

    @dataclass
    class Sifa:
        phonemes_group: str
        ghonna: Unit | None = None

    result = _serialize_sifat(
        [Sifa(phonemes_group="p", ghonna=Unit(text="maghnoon", prob=2.0, idx=1))]
    )

    assert result == [
        {
            "phonemesGroup": "p",
            "ghonna": {
                "label": "maghnoon",
                "labelIndex": 1,
                "scoreStatus": "withheld-upstream-decoder-bug",
            },
        }
    ]
    assert "probability" not in json.dumps(result).lower()
    assert "confidence" not in json.dumps(result).lower()


def test_profile_checksum_binds_the_exact_scholar_pending_profile():
    candidate = load_shadow_candidate(ROOT / "acoustic-candidates.json")
    profile = candidate["qps"]["profile"]
    encoded = json.dumps(profile, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()

    assert profile == {
        "rewaya": "hafs",
        "recitation_speed": "murattal",
        "madd_monfasel_len": 4,
        "madd_mottasel_len": 4,
        "madd_mottasel_waqf": 4,
        "madd_aared_len": 4,
    }
    assert candidate["qps"]["profileStatus"] == "pending-scholar-approval"
    assert candidate["qps"]["profileChecksum"] == "sha256:" + hashlib.sha256(encoded).hexdigest()


def test_qps_builder_passes_canonical_bytes_without_normalization_or_upstream_aya_lookup():
    candidate = load_shadow_candidate(ROOT / "acoustic-candidates.json")
    source = "\u0628\u0651\u064e"
    seen = {}

    def fake_phonetizer(text, profile, remove_spaces=False):
        seen["text"] = text
        seen["profile"] = profile
        seen["remove_spaces"] = remove_spaces
        return SimpleNamespace(phonemes="p", sifat=[], mappings=[])

    class FakeProfile:
        def __init__(self, **values):
            self.values = values

    result = build_qps_reference(
        source,
        candidate,
        phonetizer=fake_phonetizer,
        profile_type=FakeProfile,
    )

    assert seen["text"] == source
    assert seen["profile"].values == candidate["qps"]["profile"]
    assert seen["remove_spaces"] is True
    assert result.phonemes == "p"


def test_observation_request_refuses_non_16khz_or_unmeasured_spans():
    base = {
        "audioPath": "/private/window.wav",
        "sampleRate": 16_000,
        "durationMs": 1_200,
        "referenceText": "canonical",
        "segments": [
            {"wordId": "1:1:1", "startMs": 100, "endMs": 600, "canonicalText": "canonical"}
        ],
        "coreWordIds": ["1:1:1"],
    }

    validate_observation_request(base, max_window_ms=15_000, max_words=256)

    with pytest.raises(AcousticRefusal, match="unsupported-sample-rate"):
        validate_observation_request({**base, "sampleRate": 48_000}, 15_000, 256)

    bad = {**base, "segments": [{**base["segments"][0], "endMs": 100}]}
    with pytest.raises(AcousticRefusal, match="invalid-server-derived-spans"):
        validate_observation_request(bad, 15_000, 256)

    with pytest.raises(AcousticRefusal, match="reference-mismatch"):
        validate_observation_request({**base, "coreWordIds": ["1:1:2"]}, 15_000, 256)


def test_child_worker_is_restarted_after_exit_and_never_reuses_a_dead_process(tmp_path):
    worker = tmp_path / "one_shot_worker.py"
    worker.write_text(
        "import json, sys\n"
        "for line in sys.stdin:\n"
        "    value = json.loads(line)\n"
        "    print(json.dumps({'status': 'observed', 'value': value['value']}), flush=True)\n"
        "    raise SystemExit(0)\n",
        encoding="utf-8",
    )

    async def exercise():
        client = AcousticWorkerClient(
            command=[sys.executable, str(worker)],
            timeout_seconds=2,
            response_limit_bytes=4096,
        )
        try:
            assert await client.observe({"value": 1}) == {"status": "observed", "value": 1}
            assert await client.observe({"value": 2}) == {"status": "observed", "value": 2}
        finally:
            await client.close()

    asyncio.run(exercise())


def test_child_worker_timeout_is_bounded_and_kills_the_stuck_process(tmp_path):
    worker = tmp_path / "stuck_worker.py"
    worker.write_text(
        "import sys, time\n"
        "for _line in sys.stdin:\n"
        "    time.sleep(60)\n",
        encoding="utf-8",
    )

    async def exercise():
        client = AcousticWorkerClient(
            command=[sys.executable, str(worker)],
            timeout_seconds=0.05,
            response_limit_bytes=4096,
        )
        try:
            with pytest.raises(AcousticRefusal, match="acoustic-worker-timeout"):
                await client.observe({"value": 1})
            assert client.running is False
        finally:
            await client.close()

    asyncio.run(exercise())


def test_declared_scorer_double_proves_reference_to_raw_observation_without_confidence(tmp_path):
    candidate = copy.deepcopy(load_shadow_candidate(ROOT / "acoustic-candidates.json"))
    artifact = tmp_path / candidate["model"]["artifact"]
    artifact.write_bytes(b"declared acoustic model fixture")
    candidate["model"]["artifactSizeBytes"] = artifact.stat().st_size
    candidate["model"]["artifactSha256"] = (
        "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
    )
    candidate["model"]["files"] = [
        {
            "path": candidate["model"]["artifact"],
            "sha256": candidate["model"]["artifactSha256"],
            "sizeBytes": candidate["model"]["artifactSizeBytes"],
        }
    ]
    seen = {}

    class FakeWave(list):
        ndim = 1

    class FakeProfile:
        def __init__(self, **values):
            self.values = values

    def fake_phonetizer(text, profile, remove_spaces=False):
        seen["referenceText"] = text
        seen["profile"] = profile.values
        seen["removeSpaces"] = remove_spaces
        return SimpleNamespace(phonemes="reference-qps", sifat=[], mappings=[])

    @dataclass
    class Unit:
        text: str
        probs: list[float]

    @dataclass
    class Sifa:
        phonemes_group: str
        ghonna: object | None = None

    class FakeModel:
        def __call__(self, waves, references, sampling_rate):
            seen["samplingRate"] = sampling_rate
            seen["qps"] = references[0].phonemes
            assert len(waves[0]) == 1600
            return [
                SimpleNamespace(
                    phonemes=Unit(text="declared-output", probs=[0.25, 0.75]),
                    sifat=[Sifa(phonemes_group="p")],
                )
            ]

    engine = AcousticEngine(
        candidate,
        tmp_path,
        model_factory=lambda _root, _candidate: FakeModel(),
        phonetizer=fake_phonetizer,
        profile_type=FakeProfile,
        audio_loader=lambda _path: (FakeWave([0.0] * 1600), 16_000),
    )
    result = engine.observe(
        {
            "audioPath": str(tmp_path / "declared.wav"),
            "sampleRate": 16_000,
            "durationMs": 100,
            "referenceText": "canonical",
            "segments": [
                {
                    "wordId": "1:1:1",
                    "canonicalText": "canonical",
                    "startMs": 0,
                    "endMs": 100,
                }
            ],
            "coreWordIds": ["1:1:1"],
        }
    )

    assert result["status"] == "observed"
    assert result["observations"][0]["phonemeRawProbabilities"] == [0.25, 0.75]
    assert "confidence" not in json.dumps(result).lower()
    assert seen == {
        "referenceText": "canonical",
        "profile": candidate["qps"]["profile"],
        "removeSpaces": True,
        "samplingRate": 16_000,
        "qps": "reference-qps",
    }
