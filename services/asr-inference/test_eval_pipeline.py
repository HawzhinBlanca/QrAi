"""End-to-end tests for the row-level offline evaluation authority.

All numbers are declared test fixtures. They exercise recomputation and refusal semantics and are
never model, calibration, or release evidence.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

from evaluate_candidate import EvaluationError, canonical_json_bytes, evaluate_files, main


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _write_json(path: Path, value: object) -> None:
    path.write_bytes(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    )


def _workspace(root: Path) -> dict[str, Path]:
    files = {
        "request": root / "request.json",
        "protocol": root / "protocol.json",
        "registry": root / "registry.json",
        "model_artifact": root / "model.bin",
        "implementation": root / "implementation.tar",
        "runtime_lock": root / "runtime.lock",
        "dataset_manifest": root / "dataset.json",
        "split_manifest": root / "split.json",
        "rows": root / "rows.json",
        "output": root / "evidence.json",
    }

    files["model_artifact"].write_bytes(b"declared-test-model")
    files["implementation"].write_bytes(b"declared-test-implementation")
    files["runtime_lock"].write_bytes(b"declared-test-runtime-lock")
    _write_json(files["registry"], {"schemaVersion": "qrai-test-registry/v1"})

    dataset = {
        "schemaVersion": "qrai-evaluation-dataset/v1",
        "datasetVersion": "declared-fixture-v1",
        "evidenceClass": "declared-fixture",
        "sealed": True,
        "consentStatus": "test-only",
        "licenseReviewStatus": "test-only",
    }
    split = {
        "schemaVersion": "qrai-evaluation-split/v1",
        "heldOutReciterIds": ["fixture-reciter-1", "fixture-reciter-2"],
        "calibrationReciterIds": [],
    }
    protocol = {
        "schemaVersion": "qrai-evaluation-protocol/v1",
        "protocolVersion": "fixture-protocol-v1",
        "approvalStatus": "test-only",
        "operatingThreshold": 0.5,
        "calibrationBins": 2,
        "bootstrap": {
            "confidenceLevel": 0.95,
            "replicateCount": 50,
            "seed": 7,
        },
        "requiredSlices": [
            {
                "sliceId": "fixture-slice",
                "dimensions": {
                    "languageBackground": "test-only",
                    "ageBand": "test-only",
                    "deviceClass": "test-only",
                    "noiseCondition": "test-only",
                },
            }
        ],
    }
    rows = [
        {
            "rowId": "row-1",
            "reciterId": "fixture-reciter-1",
            "splitId": "held-out",
            "label": 1,
            "score": 0.9,
            "sliceIds": ["fixture-slice"],
            "sourceBacked": True,
            "ratings": [1, 1],
        },
        {
            "rowId": "row-2",
            "reciterId": "fixture-reciter-1",
            "splitId": "held-out",
            "label": 0,
            "score": 0.8,
            "sliceIds": ["fixture-slice"],
            "sourceBacked": True,
            "ratings": [0, 0],
        },
        {
            "rowId": "row-3",
            "reciterId": "fixture-reciter-2",
            "splitId": "held-out",
            "label": 1,
            "score": 0.7,
            "sliceIds": ["fixture-slice"],
            "sourceBacked": True,
            "ratings": [1, 1],
        },
        {
            "rowId": "row-4",
            "reciterId": "fixture-reciter-2",
            "splitId": "held-out",
            "label": 0,
            "score": 0.1,
            "sliceIds": ["fixture-slice"],
            "sourceBacked": True,
            "ratings": [0, 0],
        },
    ]
    _write_json(files["dataset_manifest"], dataset)
    _write_json(files["split_manifest"], split)
    _write_json(files["protocol"], protocol)
    _write_json(files["rows"], rows)

    request = {
        "schemaVersion": "qrai-evaluation-request/v1",
        "evaluationTask": "acoustic-tajweed",
        "eligibility": "fixture-regression",
        "generatedAt": "2026-01-01T00:00:00Z",
        "candidate": {
            "candidateId": "fixture-candidate",
            "modelVersion": "fixture-model-v1",
            "modelArtifactSha256": _sha256_file(files["model_artifact"]),
            "implementationSha256": _sha256_file(files["implementation"]),
            "runtimeLockSha256": _sha256_file(files["runtime_lock"]),
            "imageDigest": _sha256_bytes(b"declared-test-image"),
            "registrySha256": _sha256_file(files["registry"]),
            "executionStatus": "test-only",
            "licenseReviewStatus": "test-only",
        },
        "dataset": {
            "datasetVersion": dataset["datasetVersion"],
            "evidenceClass": dataset["evidenceClass"],
            "manifestSha256": _sha256_file(files["dataset_manifest"]),
            "splitManifestSha256": _sha256_file(files["split_manifest"]),
            "splitId": "held-out",
            "sealed": dataset["sealed"],
            "reciterDisjoint": True,
            "consentStatus": dataset["consentStatus"],
            "licenseReviewStatus": dataset["licenseReviewStatus"],
        },
        "protocol": {
            "protocolVersion": protocol["protocolVersion"],
            "protocolSha256": _sha256_file(files["protocol"]),
        },
        "rawResults": {"rowResultsSha256": _sha256_file(files["rows"])},
        "calibration": None,
        "approvals": [],
    }
    _write_json(files["request"], request)
    return files


def _evaluate(files: dict[str, Path]) -> dict:
    return evaluate_files(
        request_path=files["request"],
        protocol_path=files["protocol"],
        registry_path=files["registry"],
        model_artifact_path=files["model_artifact"],
        implementation_path=files["implementation"],
        runtime_lock_path=files["runtime_lock"],
        dataset_manifest_path=files["dataset_manifest"],
        split_manifest_path=files["split_manifest"],
        rows_path=files["rows"],
    )


def _load(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _rewrite_request(files: dict[str, Path], mutate) -> None:
    value = _load(files["request"])
    mutate(value)
    _write_json(files["request"], value)


def _rewrite_rows(files: dict[str, Path], mutate) -> None:
    value = _load(files["rows"])
    mutate(value)
    _write_json(files["rows"], value)
    _rewrite_request(
        files,
        lambda request: request["rawResults"].update(
            {"rowResultsSha256": _sha256_file(files["rows"])}
        ),
    )


def _expect_error(files: dict[str, Path], message: str) -> None:
    try:
        _evaluate(files)
    except EvaluationError as exc:
        assert message in str(exc), str(exc)
        return
    raise AssertionError(f"expected EvaluationError containing {message!r}")


def test_computes_known_metrics_from_exact_rows_and_is_deterministic():
    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        first = _evaluate(files)
        second = _evaluate(files)

        assert canonical_json_bytes(first) == canonical_json_bytes(second)
        assert first["eligibility"] == "fixture-regression"
        assert abs(first["metrics"]["averagePrecision"] - 5 / 6) < 1e-12
        assert abs(first["metrics"]["rocAuc"] - 0.75) < 1e-12
        operating = first["metrics"]["operatingPoint"]
        assert operating == {
            "threshold": 0.5,
            "precision": 2 / 3,
            "recall": 1.0,
            "f1": 0.8,
            "falsePositiveRate": 0.5,
        }
        assert first["metrics"]["teacherAgreementRate"] == 1.0
        assert first["counts"] == {
            "rowCount": 4,
            "positiveCount": 2,
            "negativeCount": 2,
            "reciterCount": 2,
            "sourceBackedFindingCount": 4,
            "unsourcedLearnerOutputCount": 0,
        }
        assert first["rawResults"]["rowResultsSha256"] == _sha256_file(files["rows"])
        assert first["rawResults"]["rowManifestSha256"] == _sha256_file(files["request"])
        assert first["uncertainty"]["method"] == "reciter-cluster-bootstrap"
        assert first["slices"][0]["sliceId"] == "fixture-slice"


def test_cli_writes_the_same_canonical_payload_without_a_signature():
    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        status = main(
            [
                "--request", str(files["request"]),
                "--protocol", str(files["protocol"]),
                "--registry", str(files["registry"]),
                "--model-artifact", str(files["model_artifact"]),
                "--implementation", str(files["implementation"]),
                "--runtime-lock", str(files["runtime_lock"]),
                "--dataset-manifest", str(files["dataset_manifest"]),
                "--split-manifest", str(files["split_manifest"]),
                "--rows", str(files["rows"]),
                "--output", str(files["output"]),
            ]
        )
        assert status == 0
        assert files["output"].read_bytes() == canonical_json_bytes(_evaluate(files)) + b"\n"
        assert "signature" not in _load(files["output"])


def test_rejects_aggregate_only_input_and_unknown_fields():
    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        _rewrite_request(files, lambda request: request.update({"metrics": {"f1": 1.0}}))
        _expect_error(files, "unknown field")


def test_rejects_every_digest_mismatch_before_computing_metrics():
    cases = (
        ("model_artifact", "model artifact digest mismatch"),
        ("implementation", "implementation digest mismatch"),
        ("runtime_lock", "runtime lock digest mismatch"),
        ("registry", "candidate registry digest mismatch"),
        ("dataset_manifest", "dataset manifest digest mismatch"),
        ("split_manifest", "split manifest digest mismatch"),
        ("protocol", "protocol digest mismatch"),
        ("rows", "row results digest mismatch"),
    )
    for file_key, expected_message in cases:
        with tempfile.TemporaryDirectory() as tmp:
            files = _workspace(Path(tmp))
            target = files[file_key]
            target.write_bytes(target.read_bytes() + b" ")
            _expect_error(files, expected_message)


def test_rejects_non_finite_scores_missing_classes_and_missing_reciters():
    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        raw = files["rows"].read_text(encoding="utf-8").replace("0.9", "NaN", 1)
        files["rows"].write_text(raw, encoding="utf-8")
        _rewrite_request(
            files,
            lambda request: request["rawResults"].update(
                {"rowResultsSha256": _sha256_file(files["rows"])}
            ),
        )
        _expect_error(files, "non-standard JSON constant")

    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        _rewrite_rows(files, lambda rows: [row.update({"label": 1}) for row in rows])
        _expect_error(files, "both label classes")

    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        _rewrite_rows(
            files,
            lambda rows: [row.update({"reciterId": "fixture-reciter-1"}) for row in rows],
        )
        _expect_error(files, "held-out reciters do not match")


def test_rejects_split_leakage_mutable_aliases_and_fixture_release_claims():
    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        split = _load(files["split_manifest"])
        split["calibrationReciterIds"] = ["fixture-reciter-1"]
        _write_json(files["split_manifest"], split)
        _rewrite_request(
            files,
            lambda request: request["dataset"].update(
                {"splitManifestSha256": _sha256_file(files["split_manifest"])}
            ),
        )
        _expect_error(files, "reciter leakage")

    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        _rewrite_request(files, lambda request: request["candidate"].update({"modelVersion": "latest"}))
        _expect_error(files, "mutable alias")

    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        _rewrite_request(files, lambda request: request.update({"eligibility": "release-candidate"}))
        _expect_error(files, "declared fixture cannot claim release eligibility")


def test_rejects_duplicate_rows_and_incomplete_or_degenerate_slices():
    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        _rewrite_rows(files, lambda rows: rows[1].update({"rowId": rows[0]["rowId"]}))
        _expect_error(files, "duplicate rowId")

    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        _rewrite_rows(files, lambda rows: rows[-1].update({"sliceIds": []}))
        _expect_error(files, "sliceIds")

    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        _rewrite_rows(
            files,
            lambda rows: [row.update({"sliceIds": []}) for row in rows if row["label"] == 0],
        )
        _expect_error(files, "sliceIds")


def test_rejects_release_shape_without_calibration_controls_and_full_approvals():
    with tempfile.TemporaryDirectory() as tmp:
        files = _workspace(Path(tmp))
        dataset = _load(files["dataset_manifest"])
        dataset.update(
            {
                "evidenceClass": "consented-held-out",
                "consentStatus": "approved",
                "licenseReviewStatus": "approved",
            }
        )
        _write_json(files["dataset_manifest"], dataset)

        def make_release(request):
            request["eligibility"] = "release-candidate"
            request["candidate"].update(
                {"executionStatus": "runnable", "licenseReviewStatus": "approved"}
            )
            request["dataset"].update(
                {
                    "evidenceClass": "consented-held-out",
                    "consentStatus": "approved",
                    "licenseReviewStatus": "approved",
                    "manifestSha256": _sha256_file(files["dataset_manifest"]),
                }
            )

        _rewrite_request(files, make_release)
        _expect_error(files, "release candidate requires a calibrator")


if __name__ == "__main__":
    tests = [
        (name, value)
        for name, value in sorted(globals().items())
        if name.startswith("test_") and callable(value)
    ]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  ok   {name}")
        except Exception as exc:  # noqa: BLE001 - minimal stdlib test runner
            failed += 1
            print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
