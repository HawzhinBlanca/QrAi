"""Fail-closed runtime authority for acoustic confidence calibrators.

The offline evaluator proves a calibrator against immutable evidence. This loader performs the
separate runtime check: the selected artifact must be explicitly approved and bound to the exact
scorer, dataset manifest, and verified evaluation evidence digests. An empty registry is a valid
production state and resolves to no calibrator.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Mapping


_DEFAULT_REGISTRY = Path(__file__).with_name("calibrator-registry.json")
_SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
_STABLE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{2,127}$")
_METHODS = {"isotonic", "platt", "temperature-scaling"}
_ROOT_KEYS = {"schemaVersion", "activeCalibratorId", "calibrators"}
_RECORD_KEYS = {
    "id",
    "status",
    "method",
    "artifactPath",
    "artifactSha256",
    "artifactSizeBytes",
    "scorerArtifactSha256",
    "datasetManifestSha256",
    "evaluationEvidenceSha256",
}


def _digest(value: Any) -> bool:
    return isinstance(value, str) and _SHA256.fullmatch(value) is not None


def _safe_filename(value: Any) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and Path(value).name == value
        and "/" not in value
        and "\\" not in value
    )


def load_calibrator_registry(path: str | Path = _DEFAULT_REGISTRY) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("invalid calibrator registry") from error

    if not isinstance(value, dict) or set(value) != _ROOT_KEYS:
        raise ValueError("invalid calibrator registry shape")
    if value["schemaVersion"] != 1:
        raise ValueError("invalid calibrator registry schema")
    active_id = value["activeCalibratorId"]
    if active_id is not None and (
        not isinstance(active_id, str) or _STABLE_ID.fullmatch(active_id) is None
    ):
        raise ValueError("invalid active calibrator id")
    records = value["calibrators"]
    if not isinstance(records, list):
        raise ValueError("calibrators must be an array")

    seen: set[str] = set()
    for record in records:
        if not isinstance(record, dict) or set(record) != _RECORD_KEYS:
            raise ValueError("invalid calibrator record shape")
        calibrator_id = record["id"]
        if (
            not isinstance(calibrator_id, str)
            or _STABLE_ID.fullmatch(calibrator_id) is None
            or calibrator_id in seen
        ):
            raise ValueError("calibrator ids must be unique stable ids")
        seen.add(calibrator_id)
        if record["status"] != "approved":
            raise ValueError("calibrator registry contains a non-approved record")
        if record["method"] not in _METHODS:
            raise ValueError("calibrator method is unknown")
        if not _safe_filename(record["artifactPath"]):
            raise ValueError("calibrator artifact path must be a filename")
        if (
            isinstance(record["artifactSizeBytes"], bool)
            or not isinstance(record["artifactSizeBytes"], int)
            or record["artifactSizeBytes"] <= 0
        ):
            raise ValueError("calibrator artifact size must be positive")
        for field in (
            "artifactSha256",
            "scorerArtifactSha256",
            "datasetManifestSha256",
            "evaluationEvidenceSha256",
        ):
            if not _digest(record[field]):
                raise ValueError(f"calibrator {field} must be sha256")

    if active_id is not None and sum(record["id"] == active_id for record in records) != 1:
        raise ValueError("active calibrator must resolve exactly once")
    return value


def resolve_approved_calibrator(
    registry: Mapping[str, Any],
    *,
    scorer_artifact_sha256: str,
    dataset_manifest_sha256: str,
    evaluation_evidence_sha256: str,
    artifact_root: str | Path,
) -> dict[str, Any]:
    """Resolve only an exact, byte-verified active calibrator.

    Invalid registries are rejected by ``load_calibrator_registry``. Runtime binding or artifact
    failures are ordinary unavailable states so the caller can remain shadow-only without leaking
    local paths.
    """

    active_id = registry.get("activeCalibratorId")
    if active_id is None:
        return {"status": "unavailable", "reason": "no-approved-calibrator"}
    records = registry.get("calibrators")
    if not isinstance(records, list):
        return {"status": "unavailable", "reason": "invalid-calibrator-registry"}
    matches = [record for record in records if isinstance(record, dict) and record.get("id") == active_id]
    if len(matches) != 1 or matches[0].get("status") != "approved":
        return {"status": "unavailable", "reason": "invalid-calibrator-registry"}
    record = matches[0]
    bindings = (
        (scorer_artifact_sha256, record.get("scorerArtifactSha256")),
        (dataset_manifest_sha256, record.get("datasetManifestSha256")),
        (evaluation_evidence_sha256, record.get("evaluationEvidenceSha256")),
    )
    if any(not _digest(actual) or actual != expected for actual, expected in bindings):
        return {"status": "unavailable", "reason": "calibrator-binding-mismatch"}

    artifact = Path(artifact_root) / record["artifactPath"]
    try:
        stat = artifact.stat()
    except OSError:
        return {"status": "unavailable", "reason": "calibrator-artifact-unavailable"}
    if not artifact.is_file() or stat.st_size != record["artifactSizeBytes"]:
        return {"status": "unavailable", "reason": "calibrator-artifact-mismatch"}
    digest = hashlib.sha256()
    try:
        with artifact.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return {"status": "unavailable", "reason": "calibrator-artifact-unavailable"}
    if "sha256:" + digest.hexdigest() != record["artifactSha256"]:
        return {"status": "unavailable", "reason": "calibrator-artifact-mismatch"}
    return {"status": "active", "calibrator": dict(record)}
