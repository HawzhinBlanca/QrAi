"""Offline, row-authoritative evaluation for Quran recitation candidates.

The evaluator reads exact, digest-bound artifacts and row-level labels/scores. It never accepts
caller-supplied metric summaries and never signs or promotes its output. Signature verification and
release trust are separate authorities.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from eval_metrics import (
    average_precision,
    cluster_bootstrap_ci,
    expected_calibration_error,
    krippendorff_alpha_nominal,
    precision_recall_f1,
    roc_auc,
)


EVALUATOR_VERSION = "qrai-offline-evaluator-v1"
_SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
_STABLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_UTC_TIMESTAMP = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$"
)
_MUTABLE_ALIASES = {"head", "latest", "main", "master"}
_ELIGIBILITY = {"fixture-regression", "research-only", "release-candidate"}
_TASKS = {"quran-word-alignment", "acoustic-tajweed"}
_APPROVAL_ROLES = {"product-owner", "quran-scholar", "privacy-legal", "data-steward"}
_METRIC_NAMES = (
    "averagePrecision",
    "rocAuc",
    "precision",
    "recall",
    "f1",
    "falsePositiveRate",
    "expectedCalibrationError",
    "teacherAgreementRate",
)


class EvaluationError(ValueError):
    """Input cannot support an evaluation evidence payload."""


def _fail(message: str) -> None:
    raise EvaluationError(message)


def _reject_constant(value: str) -> None:
    _fail(f"non-standard JSON constant is forbidden: {value}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail(f"duplicate JSON key is forbidden: {key}")
        result[key] = value
    return result


def _read_json(path: str | Path, label: str) -> tuple[Any, bytes]:
    raw = Path(path).read_bytes()
    try:
        value = json.loads(
            raw,
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
    except UnicodeDecodeError as exc:
        _fail(f"{label} must be UTF-8 JSON: {exc}")
    except json.JSONDecodeError as exc:
        _fail(f"{label} is invalid JSON at line {exc.lineno} column {exc.colno}")
    return value, raw


def _object(
    value: Any,
    label: str,
    *,
    required: set[str],
    optional: set[str] | None = None,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{label} must be an object")
    allowed = required | (optional or set())
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - allowed)
    if missing:
        _fail(f"{label} is missing required field: {', '.join(missing)}")
    if unknown:
        _fail(f"{label} has unknown field: {', '.join(unknown)}")
    return value


def _array(value: Any, label: str, *, allow_empty: bool = False) -> list[Any]:
    if not isinstance(value, list) or (not allow_empty and not value):
        qualifier = "an array" if allow_empty else "a non-empty array"
        _fail(f"{label} must be {qualifier}")
    return value


def _stable_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _STABLE_ID.fullmatch(value):
        _fail(f"{label} must be a stable ASCII identifier")
    return value


def _digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        _fail(f"{label} must be sha256 plus 64 lowercase hex characters")
    return value


def _timestamp(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _UTC_TIMESTAMP.fullmatch(value):
        _fail(f"{label} must be a UTC RFC 3339 timestamp")
    return value


def _integer(value: Any, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        _fail(f"{label} must be an integer >= {minimum}")
    return value


def _number(
    value: Any,
    label: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        _fail(f"{label} must be a finite number")
    if minimum is not None and result < minimum:
        _fail(f"{label} must be >= {minimum}")
    if maximum is not None and result > maximum:
        _fail(f"{label} must be <= {maximum}")
    return result


def _boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        _fail(f"{label} must be boolean")
    return value


def _sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _sha256_file(path: str | Path) -> str:
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return "sha256:" + hasher.hexdigest()


def _require_file_digest(path: str | Path, expected: str, label: str) -> None:
    actual = _sha256_file(path)
    if actual != expected:
        _fail(f"{label} digest mismatch")


def _evaluator_source_digest() -> str:
    hasher = hashlib.sha256()
    root = Path(__file__).resolve().parent
    for name in ("eval_metrics.py", "evaluate_candidate.py"):
        payload = (root / name).read_bytes()
        encoded_name = name.encode("utf-8")
        hasher.update(len(encoded_name).to_bytes(4, "big"))
        hasher.update(encoded_name)
        hasher.update(len(payload).to_bytes(8, "big"))
        hasher.update(payload)
    return "sha256:" + hasher.hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    """Stable UTF-8 storage bytes; the detached signer performs RFC 8785 canonicalization."""
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        _fail(f"evidence is not finite JSON: {exc}")


def _validate_candidate(value: Any) -> dict[str, Any]:
    candidate = _object(
        value,
        "candidate",
        required={
            "candidateId",
            "modelVersion",
            "modelArtifactSha256",
            "implementationSha256",
            "runtimeLockSha256",
            "imageDigest",
            "registrySha256",
            "executionStatus",
            "licenseReviewStatus",
        },
    )
    for field in ("candidateId", "modelVersion"):
        identifier = _stable_id(candidate[field], f"candidate {field}")
        if identifier.lower() in _MUTABLE_ALIASES:
            _fail(f"candidate {field} is a mutable alias")
    for field in (
        "modelArtifactSha256",
        "implementationSha256",
        "runtimeLockSha256",
        "imageDigest",
        "registrySha256",
    ):
        _digest(candidate[field], f"candidate {field}")
    if candidate["executionStatus"] not in {
        "runnable",
        "packaging-required",
        "research-only",
        "test-only",
    }:
        _fail("candidate executionStatus is unknown")
    if candidate["licenseReviewStatus"] not in {"approved", "pending", "rejected", "test-only"}:
        _fail("candidate licenseReviewStatus is unknown")
    return candidate


def _validate_dataset(value: Any) -> dict[str, Any]:
    dataset = _object(
        value,
        "dataset",
        required={
            "datasetVersion",
            "evidenceClass",
            "manifestSha256",
            "splitManifestSha256",
            "splitId",
            "sealed",
            "reciterDisjoint",
            "consentStatus",
            "licenseReviewStatus",
        },
    )
    _stable_id(dataset["datasetVersion"], "dataset datasetVersion")
    if dataset["evidenceClass"] not in {"consented-held-out", "declared-fixture"}:
        _fail("dataset evidenceClass is unknown")
    _digest(dataset["manifestSha256"], "dataset manifestSha256")
    _digest(dataset["splitManifestSha256"], "dataset splitManifestSha256")
    if dataset["splitId"] != "held-out":
        _fail("dataset splitId must be held-out")
    _boolean(dataset["sealed"], "dataset sealed")
    _boolean(dataset["reciterDisjoint"], "dataset reciterDisjoint")
    for field in ("consentStatus", "licenseReviewStatus"):
        if dataset[field] not in {"approved", "pending", "rejected", "test-only"}:
            _fail(f"dataset {field} is unknown")
    return dataset


def _validate_dataset_manifest(value: Any, expected: dict[str, Any]) -> None:
    manifest = _object(
        value,
        "dataset manifest",
        required={
            "schemaVersion",
            "datasetVersion",
            "evidenceClass",
            "sealed",
            "consentStatus",
            "licenseReviewStatus",
        },
    )
    if manifest["schemaVersion"] != "qrai-evaluation-dataset/v1":
        _fail("dataset manifest schemaVersion is unsupported")
    for field in (
        "datasetVersion",
        "evidenceClass",
        "sealed",
        "consentStatus",
        "licenseReviewStatus",
    ):
        if manifest[field] != expected[field]:
            _fail(f"dataset manifest {field} does not match request")


def _validate_split_manifest(value: Any) -> tuple[list[str], list[str]]:
    manifest = _object(
        value,
        "split manifest",
        required={"schemaVersion", "heldOutReciterIds", "calibrationReciterIds"},
    )
    if manifest["schemaVersion"] != "qrai-evaluation-split/v1":
        _fail("split manifest schemaVersion is unsupported")

    held_out = [
        _stable_id(item, f"heldOutReciterIds[{index}]")
        for index, item in enumerate(_array(manifest["heldOutReciterIds"], "heldOutReciterIds"))
    ]
    calibration = [
        _stable_id(item, f"calibrationReciterIds[{index}]")
        for index, item in enumerate(
            _array(manifest["calibrationReciterIds"], "calibrationReciterIds", allow_empty=True)
        )
    ]
    if len(set(held_out)) != len(held_out) or len(set(calibration)) != len(calibration):
        _fail("split manifest contains a duplicate reciter")
    overlap = sorted(set(held_out) & set(calibration))
    if overlap:
        _fail("reciter leakage between calibration and held-out split")
    if len(held_out) < 2:
        _fail("evaluation requires at least two held-out reciters")
    return held_out, calibration


def _validate_protocol(value: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    protocol = _object(
        value,
        "protocol",
        required={
            "schemaVersion",
            "protocolVersion",
            "approvalStatus",
            "operatingThreshold",
            "calibrationBins",
            "bootstrap",
            "requiredSlices",
        },
    )
    if protocol["schemaVersion"] != "qrai-evaluation-protocol/v1":
        _fail("protocol schemaVersion is unsupported")
    _stable_id(protocol["protocolVersion"], "protocol protocolVersion")
    if protocol["approvalStatus"] not in {"approved", "pending", "rejected", "test-only"}:
        _fail("protocol approvalStatus is unknown")
    _number(protocol["operatingThreshold"], "protocol operatingThreshold", minimum=0, maximum=1)
    _integer(protocol["calibrationBins"], "protocol calibrationBins", minimum=1)

    bootstrap = _object(
        protocol["bootstrap"],
        "protocol bootstrap",
        required={"confidenceLevel", "replicateCount", "seed"},
    )
    _number(bootstrap["confidenceLevel"], "bootstrap confidenceLevel", minimum=0, maximum=1)
    if bootstrap["confidenceLevel"] in {0, 1}:
        _fail("bootstrap confidenceLevel must be strictly between 0 and 1")
    _integer(bootstrap["replicateCount"], "bootstrap replicateCount", minimum=1)
    _integer(bootstrap["seed"], "bootstrap seed", minimum=0)

    slices: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw_slice in enumerate(_array(protocol["requiredSlices"], "requiredSlices")):
        slice_definition = _object(
            raw_slice,
            f"requiredSlices[{index}]",
            required={"sliceId", "dimensions"},
        )
        slice_id = _stable_id(slice_definition["sliceId"], f"requiredSlices[{index}].sliceId")
        if slice_id in seen:
            _fail(f"duplicate required slice: {slice_id}")
        seen.add(slice_id)
        dimensions = _object(
            slice_definition["dimensions"],
            f"requiredSlices[{index}].dimensions",
            required={"languageBackground", "ageBand", "deviceClass", "noiseCondition"},
        )
        for field, dimension in dimensions.items():
            _stable_id(dimension, f"slice {slice_id} dimension {field}")
        slices.append({"sliceId": slice_id, "dimensions": dimensions})
    return protocol, slices


def _validate_calibration(
    value: Any,
    *,
    dataset_manifest_sha256: str,
    split_manifest_sha256: str,
    artifact_path: str | Path | None,
    source_path: str | Path | None,
) -> dict[str, Any] | None:
    if value is None:
        return None
    calibration = _object(
        value,
        "calibration",
        required={
            "calibratorId",
            "calibratorVersion",
            "method",
            "artifactSha256",
            "sourceSha256",
            "fitDatasetManifestSha256",
            "fitSplitManifestSha256",
        },
    )
    _stable_id(calibration["calibratorId"], "calibration calibratorId")
    _stable_id(calibration["calibratorVersion"], "calibration calibratorVersion")
    if calibration["method"] not in {"isotonic", "platt", "temperature-scaling"}:
        _fail("calibration method is unknown")
    for field in (
        "artifactSha256",
        "sourceSha256",
        "fitDatasetManifestSha256",
        "fitSplitManifestSha256",
    ):
        _digest(calibration[field], f"calibration {field}")
    if artifact_path is None or source_path is None:
        _fail("calibration requires exact artifact and source files")
    _require_file_digest(artifact_path, calibration["artifactSha256"], "calibrator artifact")
    _require_file_digest(source_path, calibration["sourceSha256"], "calibrator source")
    if calibration["fitDatasetManifestSha256"] != dataset_manifest_sha256:
        _fail("calibrator fit dataset manifest does not match evaluated dataset authority")
    if calibration["fitSplitManifestSha256"] != split_manifest_sha256:
        _fail("calibrator fit split manifest does not match evaluated split authority")
    return calibration


def _validate_approvals(value: Any) -> list[dict[str, Any]]:
    approvals = _array(value, "approvals", allow_empty=True)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(approvals):
        approval = _object(
            raw,
            f"approvals[{index}]",
            required={"role", "approvalId", "decision", "artifactSha256", "approvedAt"},
        )
        role = approval["role"]
        if role not in _APPROVAL_ROLES:
            _fail(f"approval role is unknown: {role!r}")
        if role in seen:
            _fail(f"duplicate approval role: {role}")
        seen.add(role)
        _stable_id(approval["approvalId"], f"approval {role} approvalId")
        if approval["decision"] != "approved":
            _fail(f"approval {role} decision must be approved")
        _digest(approval["artifactSha256"], f"approval {role} artifactSha256")
        _timestamp(approval["approvedAt"], f"approval {role} approvedAt")
        out.append(approval)
    return sorted(out, key=lambda item: item["role"])


def _validate_rows(
    value: Any,
    *,
    held_out_reciters: Sequence[str],
    required_slice_ids: set[str],
) -> list[dict[str, Any]]:
    rows = _array(value, "rows")
    out: list[dict[str, Any]] = []
    row_ids: set[str] = set()
    observed_reciters: set[str] = set()
    for index, raw in enumerate(rows):
        row = _object(
            raw,
            f"rows[{index}]",
            required={
                "rowId",
                "reciterId",
                "splitId",
                "label",
                "score",
                "sliceIds",
                "sourceBacked",
                "ratings",
            },
        )
        row_id = _stable_id(row["rowId"], f"rows[{index}].rowId")
        if row_id in row_ids:
            _fail(f"duplicate rowId: {row_id}")
        row_ids.add(row_id)
        reciter_id = _stable_id(row["reciterId"], f"rows[{index}].reciterId")
        observed_reciters.add(reciter_id)
        if row["splitId"] != "held-out":
            _fail(f"row {row_id} splitId must be held-out")
        label = row["label"]
        if isinstance(label, bool) or label not in {0, 1}:
            _fail(f"row {row_id} label must be binary 0 or 1")
        score = _number(row["score"], f"row {row_id} score", minimum=0, maximum=1)
        slice_ids = [
            _stable_id(item, f"row {row_id} sliceIds[{slice_index}]")
            for slice_index, item in enumerate(_array(row["sliceIds"], f"row {row_id} sliceIds"))
        ]
        if len(set(slice_ids)) != len(slice_ids):
            _fail(f"row {row_id} contains duplicate sliceIds")
        unknown_slices = sorted(set(slice_ids) - required_slice_ids)
        if unknown_slices:
            _fail(f"row {row_id} names unknown slice: {', '.join(unknown_slices)}")
        source_backed = _boolean(row["sourceBacked"], f"row {row_id} sourceBacked")
        ratings = _array(row["ratings"], f"row {row_id} ratings")
        if len(ratings) < 2:
            _fail(f"row {row_id} ratings requires at least two adjudicator labels")
        checked_ratings: list[int] = []
        for rating_index, rating in enumerate(ratings):
            if isinstance(rating, bool) or rating not in {0, 1}:
                _fail(f"row {row_id} ratings[{rating_index}] must be binary 0 or 1")
            checked_ratings.append(rating)
        out.append(
            {
                "rowId": row_id,
                "reciterId": reciter_id,
                "splitId": "held-out",
                "label": label,
                "score": score,
                "sliceIds": slice_ids,
                "sourceBacked": source_backed,
                "ratings": checked_ratings,
            }
        )

    expected_reciters = set(held_out_reciters)
    if observed_reciters != expected_reciters:
        _fail("held-out reciters do not match the sealed split manifest")
    labels = {row["label"] for row in out}
    if labels != {0, 1}:
        _fail("evaluation rows must contain both label classes")
    return out


def _finite_metric(value: float, label: str) -> float:
    if not math.isfinite(value):
        _fail(f"computed metric {label} is undefined or non-finite")
    return float(value)


def _metric_set(rows: Sequence[dict[str, Any]], threshold: float, bins: int) -> dict[str, Any]:
    labels = np.asarray([row["label"] for row in rows], dtype=np.int64)
    scores = np.asarray([row["score"] for row in rows], dtype=np.float64)
    if set(labels.tolist()) != {0, 1}:
        _fail("every evaluated cohort and slice must contain both label classes")
    operation = precision_recall_f1(labels, scores, threshold)
    negative_count = int(np.sum(labels == 0))
    false_positive_rate = operation["fp"] / negative_count
    agreement = krippendorff_alpha_nominal([row["ratings"] for row in rows])
    return {
        "averagePrecision": _finite_metric(average_precision(labels, scores), "averagePrecision"),
        "rocAuc": _finite_metric(roc_auc(labels, scores), "rocAuc"),
        "operatingPoint": {
            "threshold": float(threshold),
            "precision": _finite_metric(operation["precision"], "precision"),
            "recall": _finite_metric(operation["recall"], "recall"),
            "f1": _finite_metric(operation["f1"], "f1"),
            "falsePositiveRate": _finite_metric(false_positive_rate, "falsePositiveRate"),
        },
        "expectedCalibrationError": _finite_metric(
            expected_calibration_error(labels, scores, bins), "expectedCalibrationError"
        ),
        "teacherAgreementRate": _finite_metric(agreement, "teacherAgreementRate"),
    }


def _metric_value(
    rows: Sequence[dict[str, Any]], threshold: float, bins: int, metric_name: str
) -> float:
    metrics = _metric_set(rows, threshold, bins)
    if metric_name in {"averagePrecision", "rocAuc", "expectedCalibrationError", "teacherAgreementRate"}:
        return float(metrics[metric_name])
    return float(metrics["operatingPoint"][metric_name])


def _uncertainty(
    rows: Sequence[dict[str, Any]],
    *,
    threshold: float,
    bins: int,
    confidence_level: float,
    replicate_count: int,
    seed: int,
) -> dict[str, Any]:
    cluster_ids = np.asarray([row["reciterId"] for row in rows])
    intervals: list[dict[str, Any]] = []
    for metric_index, metric_name in enumerate(_METRIC_NAMES):
        def statistic(indices: np.ndarray, name: str = metric_name) -> float:
            subset = [rows[int(index)] for index in indices]
            try:
                return _metric_value(subset, threshold, bins, name)
            except EvaluationError:
                return float("nan")

        result = cluster_bootstrap_ci(
            statistic,
            cluster_ids,
            n_resamples=replicate_count,
            alpha=1.0 - confidence_level,
            seed=seed + metric_index,
        )
        if result["n_valid"] == 0:
            _fail(f"bootstrap produced no valid replicate for {metric_name}")
        intervals.append(
            {
                "metric": metric_name,
                "pointEstimate": _finite_metric(result["point"], metric_name),
                "lower": _finite_metric(result["lo"], f"{metric_name} lower interval"),
                "upper": _finite_metric(result["hi"], f"{metric_name} upper interval"),
                "validReplicateCount": int(result["n_valid"]),
            }
        )
    return {
        "method": "reciter-cluster-bootstrap",
        "confidenceLevel": confidence_level,
        "replicateCount": replicate_count,
        "seed": seed,
        "intervals": intervals,
    }


def _counts(rows: Sequence[dict[str, Any]]) -> dict[str, int]:
    positive_count = sum(row["label"] == 1 for row in rows)
    source_count = sum(row["sourceBacked"] for row in rows)
    return {
        "rowCount": len(rows),
        "positiveCount": positive_count,
        "negativeCount": len(rows) - positive_count,
        "reciterCount": len({row["reciterId"] for row in rows}),
        "sourceBackedFindingCount": source_count,
        "unsourcedLearnerOutputCount": len(rows) - source_count,
    }


def _validate_release_controls(
    *,
    eligibility: str,
    candidate: dict[str, Any],
    dataset: dict[str, Any],
    protocol: dict[str, Any],
    calibration: dict[str, Any] | None,
    approvals: Sequence[dict[str, Any]],
    calibration_reciters: Sequence[str],
) -> None:
    if eligibility != "release-candidate":
        return
    if dataset["evidenceClass"] == "declared-fixture":
        _fail("declared fixture cannot claim release eligibility")
    if calibration is None:
        _fail("release candidate requires a calibrator")
    if not calibration_reciters:
        _fail("release candidate requires a non-empty calibration reciter split")
    if candidate["executionStatus"] != "runnable" or candidate["licenseReviewStatus"] != "approved":
        _fail("release candidate artifact must be runnable and license-approved")
    if (
        dataset["evidenceClass"] != "consented-held-out"
        or dataset["sealed"] is not True
        or dataset["reciterDisjoint"] is not True
        or dataset["consentStatus"] != "approved"
        or dataset["licenseReviewStatus"] != "approved"
    ):
        _fail("release candidate dataset controls are incomplete")
    if protocol["approvalStatus"] != "approved":
        _fail("release candidate protocol is not approved")
    roles = {approval["role"] for approval in approvals}
    if roles != _APPROVAL_ROLES:
        _fail("release candidate requires all external approval roles")
    if protocol["bootstrap"]["replicateCount"] < 10_000:
        _fail("release candidate requires at least 10000 cluster-bootstrap replicates")


def evaluate_files(
    *,
    request_path: str | Path,
    protocol_path: str | Path,
    registry_path: str | Path,
    model_artifact_path: str | Path,
    implementation_path: str | Path,
    runtime_lock_path: str | Path,
    dataset_manifest_path: str | Path,
    split_manifest_path: str | Path,
    rows_path: str | Path,
    calibrator_artifact_path: str | Path | None = None,
    calibrator_source_path: str | Path | None = None,
) -> dict[str, Any]:
    request_value, request_raw = _read_json(request_path, "evaluation request")
    request = _object(
        request_value,
        "evaluation request",
        required={
            "schemaVersion",
            "evaluationTask",
            "eligibility",
            "generatedAt",
            "candidate",
            "dataset",
            "protocol",
            "rawResults",
            "calibration",
            "approvals",
        },
    )
    if request["schemaVersion"] != "qrai-evaluation-request/v1":
        _fail("evaluation request schemaVersion is unsupported")
    if request["evaluationTask"] not in _TASKS:
        _fail("evaluationTask is unknown")
    if request["eligibility"] not in _ELIGIBILITY:
        _fail("eligibility is unknown")
    generated_at = _timestamp(request["generatedAt"], "generatedAt")

    candidate = _validate_candidate(request["candidate"])
    dataset = _validate_dataset(request["dataset"])
    protocol_reference = _object(
        request["protocol"],
        "protocol reference",
        required={"protocolVersion", "protocolSha256"},
    )
    _stable_id(protocol_reference["protocolVersion"], "protocol reference protocolVersion")
    _digest(protocol_reference["protocolSha256"], "protocol reference protocolSha256")
    raw_results_reference = _object(
        request["rawResults"],
        "rawResults reference",
        required={"rowResultsSha256"},
    )
    _digest(raw_results_reference["rowResultsSha256"], "rawResults rowResultsSha256")

    _require_file_digest(model_artifact_path, candidate["modelArtifactSha256"], "model artifact")
    _require_file_digest(implementation_path, candidate["implementationSha256"], "implementation")
    _require_file_digest(runtime_lock_path, candidate["runtimeLockSha256"], "runtime lock")
    _require_file_digest(registry_path, candidate["registrySha256"], "candidate registry")
    _require_file_digest(dataset_manifest_path, dataset["manifestSha256"], "dataset manifest")
    _require_file_digest(split_manifest_path, dataset["splitManifestSha256"], "split manifest")
    _require_file_digest(protocol_path, protocol_reference["protocolSha256"], "protocol")
    _require_file_digest(rows_path, raw_results_reference["rowResultsSha256"], "row results")

    dataset_manifest, _ = _read_json(dataset_manifest_path, "dataset manifest")
    _validate_dataset_manifest(dataset_manifest, dataset)
    split_manifest, _ = _read_json(split_manifest_path, "split manifest")
    held_out_reciters, calibration_reciters = _validate_split_manifest(split_manifest)
    if dataset["reciterDisjoint"] is not True:
        _fail("dataset must declare reciterDisjoint true")

    protocol_value, _ = _read_json(protocol_path, "protocol")
    protocol, required_slices = _validate_protocol(protocol_value)
    if protocol["protocolVersion"] != protocol_reference["protocolVersion"]:
        _fail("protocol version does not match request")

    calibration = _validate_calibration(
        request["calibration"],
        dataset_manifest_sha256=dataset["manifestSha256"],
        split_manifest_sha256=dataset["splitManifestSha256"],
        artifact_path=calibrator_artifact_path,
        source_path=calibrator_source_path,
    )
    approvals = _validate_approvals(request["approvals"])

    rows_value, _ = _read_json(rows_path, "row results")
    rows = _validate_rows(
        rows_value,
        held_out_reciters=held_out_reciters,
        required_slice_ids={item["sliceId"] for item in required_slices},
    )
    _validate_release_controls(
        eligibility=request["eligibility"],
        candidate=candidate,
        dataset=dataset,
        protocol=protocol,
        calibration=calibration,
        approvals=approvals,
        calibration_reciters=calibration_reciters,
    )

    threshold = float(protocol["operatingThreshold"])
    bins = int(protocol["calibrationBins"])
    bootstrap = protocol["bootstrap"]
    aggregate_metrics = _metric_set(rows, threshold, bins)
    aggregate_uncertainty = _uncertainty(
        rows,
        threshold=threshold,
        bins=bins,
        confidence_level=float(bootstrap["confidenceLevel"]),
        replicate_count=int(bootstrap["replicateCount"]),
        seed=int(bootstrap["seed"]),
    )

    slices: list[dict[str, Any]] = []
    for slice_definition in required_slices:
        slice_id = slice_definition["sliceId"]
        slice_rows = [row for row in rows if slice_id in row["sliceIds"]]
        if not slice_rows:
            _fail(f"required slice has no rows: {slice_id}")
        if len({row["reciterId"] for row in slice_rows}) < 2:
            _fail(f"required slice needs at least two reciters: {slice_id}")
        slice_metrics = _metric_set(slice_rows, threshold, bins)
        slices.append(
            {
                "sliceId": slice_id,
                "dimensions": slice_definition["dimensions"],
                "rowCount": len(slice_rows),
                "positiveCount": sum(row["label"] == 1 for row in slice_rows),
                "negativeCount": sum(row["label"] == 0 for row in slice_rows),
                "reciterCount": len({row["reciterId"] for row in slice_rows}),
                "metrics": slice_metrics,
            }
        )

    source_sha256 = _evaluator_source_digest()
    evidence_id_basis = canonical_json_bytes(
        {
            "candidate": candidate,
            "dataset": dataset,
            "evaluatorSourceSha256": source_sha256,
            "protocolSha256": protocol_reference["protocolSha256"],
            "requestSha256": _sha256_bytes(request_raw),
            "rowResultsSha256": raw_results_reference["rowResultsSha256"],
        }
    )
    evidence_id = "eval-" + hashlib.sha256(evidence_id_basis).hexdigest()
    return {
        "schemaVersion": "qrai-model-evaluation-evidence/v1",
        "evidenceId": evidence_id,
        "evaluationTask": request["evaluationTask"],
        "evidenceKind": "row-level-computed-evaluation",
        "eligibility": request["eligibility"],
        "candidate": candidate,
        "dataset": dataset,
        "evaluator": {
            "evaluatorVersion": EVALUATOR_VERSION,
            "sourceSha256": source_sha256,
            "protocolVersion": protocol_reference["protocolVersion"],
            "protocolSha256": protocol_reference["protocolSha256"],
            "protocolApprovalStatus": protocol["approvalStatus"],
        },
        "rawResults": {
            "rowManifestSha256": _sha256_bytes(request_raw),
            "rowResultsSha256": raw_results_reference["rowResultsSha256"],
        },
        "counts": _counts(rows),
        "metrics": aggregate_metrics,
        "uncertainty": aggregate_uncertainty,
        "slices": slices,
        "calibration": calibration,
        "approvals": approvals,
        "generatedAt": generated_at,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    parser.add_argument("--protocol", required=True)
    parser.add_argument("--registry", required=True)
    parser.add_argument("--model-artifact", required=True)
    parser.add_argument("--implementation", required=True)
    parser.add_argument("--runtime-lock", required=True)
    parser.add_argument("--dataset-manifest", required=True)
    parser.add_argument("--split-manifest", required=True)
    parser.add_argument("--rows", required=True)
    parser.add_argument("--calibrator-artifact")
    parser.add_argument("--calibrator-source")
    parser.add_argument("--output", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        evidence = evaluate_files(
            request_path=args.request,
            protocol_path=args.protocol,
            registry_path=args.registry,
            model_artifact_path=args.model_artifact,
            implementation_path=args.implementation,
            runtime_lock_path=args.runtime_lock,
            dataset_manifest_path=args.dataset_manifest,
            split_manifest_path=args.split_manifest,
            rows_path=args.rows,
            calibrator_artifact_path=args.calibrator_artifact,
            calibrator_source_path=args.calibrator_source,
        )
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("xb") as stream:
            stream.write(canonical_json_bytes(evidence) + b"\n")
    except (EvaluationError, OSError) as exc:
        print(f"evaluation refused: {exc}", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {"evidenceId": evidence["evidenceId"], "eligibility": evidence["eligibility"]},
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
