"""Runtime-neutral model attribution for the Python inference worker.

This module intentionally imports no torch/model packages, so attribution can be tested and
validated without downloading or loading a checkpoint. It identifies only artifacts the process
can resolve honestly; an alias with no digest is refused instead of being relabelled as evidence.
"""

from __future__ import annotations

import re
from typing import Any, Mapping


MODEL_COMPONENTS = (
    "asr",
    "forced-aligner",
    "quran-aligner",
    "acoustic-scorer",
    "calibrator",
)
MODEL_ANALYSIS_BASES = ("acoustic", "quran-constrained", "text-rule")
_SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
_FULL_COMMIT = re.compile(r"^[a-f0-9]{40}$")


def _fail(message: str) -> None:
    raise ValueError(f"invalid model attribution: {message}")


def _require_digest(value: str | None, setting: str) -> str:
    if value is None or not _SHA256.fullmatch(value):
        raise ValueError(f"{setting} must be sha256 plus 64 lowercase hex characters")
    return value


def require_immutable_hf_revision(value: str | None) -> str:
    if value is None or not _FULL_COMMIT.fullmatch(value):
        raise ValueError(
            "ASR_MODEL_REVISION must be a full 40-character lowercase commit hash"
        )
    return value


def _active(
    component: str,
    implementation_id: str,
    artifact_digest: str,
    dataset_version: str,
    analysis_basis: str,
    calibrator_id: str | None = None,
) -> dict[str, Any]:
    return {
        "component": component,
        "status": "active",
        "implementationId": implementation_id,
        "artifactDigest": artifact_digest,
        "datasetVersion": dataset_version,
        "analysisBasis": analysis_basis,
        "calibratorId": calibrator_id,
    }


def _envelope(primary: str, components: list[dict[str, Any]]) -> dict[str, Any]:
    attribution = {
        "schemaVersion": 1,
        "primaryComponent": primary,
        "components": components,
    }
    validate_model_attribution(attribution)
    return attribution


def _digest_from_checkpoint_url(url: str | None) -> str | None:
    if not url:
        return None
    for segment in url.split("/"):
        if re.fullmatch(r"[a-f0-9]{64}", segment):
            return f"sha256:{segment}"
    return None


def build_asr_attribution(
    *,
    model_id: str,
    model_urls: Mapping[str, str],
    package_version: str,
    declared_digest: str | None = None,
    model_revision: str | None = None,
    dataset_version: str = "upstream-training-data-undisclosed",
) -> dict[str, Any]:
    if "/" in model_id:
        artifact_digest = _require_digest(declared_digest, "ASR_MODEL_DIGEST")
        revision = require_immutable_hf_revision(model_revision)
        implementation_id = f"huggingface-transformers-pipeline:{model_id}@{revision}"
    else:
        artifact_digest = _require_digest(
            _digest_from_checkpoint_url(model_urls.get(model_id)),
            f"verified openai-whisper checkpoint URL for {model_id}",
        )
        implementation_id = f"openai-whisper:{model_id}@{package_version}"

    return _envelope(
        "asr",
        [
            _active(
                "asr",
                implementation_id,
                artifact_digest,
                dataset_version,
                "acoustic",
            )
        ],
    )


def build_forced_aligner_attribution(
    model_id: str,
    *,
    declared_digest: str | None = None,
    dataset_version: str = "upstream-training-data-undisclosed",
) -> dict[str, Any]:
    artifact_digest = _require_digest(declared_digest, "FORCE_ALIGN_MODEL_DIGEST")
    return _envelope(
        "forced-aligner",
        [
            _active(
                "forced-aligner",
                f"huggingface-ctc:{model_id}",
                artifact_digest,
                dataset_version,
                "acoustic",
            )
        ],
    )


def build_acoustic_attribution(candidate: Mapping[str, Any]) -> dict[str, Any]:
    model = candidate.get("model")
    if not isinstance(model, Mapping):
        raise ValueError("acoustic candidate must contain model attribution")
    repository = model.get("repository")
    revision = model.get("revision")
    dataset_version = model.get("trainingDataset")
    if not isinstance(repository, str) or not repository:
        raise ValueError("acoustic model repository must be declared")
    if not isinstance(revision, str) or not _FULL_COMMIT.fullmatch(revision):
        raise ValueError("acoustic model revision must be a full commit hash")
    if not isinstance(dataset_version, str) or not dataset_version:
        raise ValueError("acoustic training dataset identity must be declared")
    component = _active(
        "acoustic-scorer",
        f"quran-muaalem:{repository}@{revision}",
        _require_digest(model.get("artifactSha256"), "acoustic artifact digest"),
        dataset_version,
        "acoustic",
    )
    unavailable_calibrator = {
        "component": "calibrator",
        "status": "unavailable",
        "reason": "no held-out calibration artifact has been approved",
    }
    return _envelope("acoustic-scorer", [component, unavailable_calibrator])


def validate_model_attribution(
    value: Any,
    *,
    expected_digests: Mapping[str, str] | None = None,
    legacy_model_version: str | None = None,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail("value must be an object")
    if value.get("schemaVersion") != 1:
        _fail("schemaVersion must be 1")
    primary = value.get("primaryComponent")
    if primary not in MODEL_COMPONENTS:
        _fail(f"unknown model component: {primary}")
    components = value.get("components")
    if not isinstance(components, list) or not components:
        _fail("components must be a non-empty array")

    seen: set[str] = set()
    active: dict[str, dict[str, Any]] = {}
    for record in components:
        if not isinstance(record, dict):
            _fail("each component record must be an object")
        component = record.get("component")
        if component not in MODEL_COMPONENTS:
            _fail(f"unknown model component: {component}")
        if component in seen:
            _fail(f"duplicate model component: {component}")
        seen.add(component)

        if record.get("status") == "unavailable":
            if not isinstance(record.get("reason"), str) or not record["reason"]:
                _fail(f"unavailable component {component} requires a reason")
            if "artifactDigest" in record:
                _fail(f"unavailable component {component} cannot claim an artifact digest")
            continue
        if record.get("status") != "active":
            _fail(f"component {component} has an unknown status")
        if not isinstance(record.get("implementationId"), str) or not record["implementationId"]:
            _fail(f"component {component} requires implementationId")
        if not isinstance(record.get("artifactDigest"), str) or not _SHA256.fullmatch(
            record["artifactDigest"]
        ):
            _fail(f"component {component} has an invalid artifactDigest")
        if not isinstance(record.get("datasetVersion"), str) or not record["datasetVersion"]:
            _fail(f"component {component} requires datasetVersion")
        if record.get("analysisBasis") not in MODEL_ANALYSIS_BASES:
            _fail(f"component {component} has an unknown analysisBasis")
        calibrator_id = record.get("calibratorId")
        if calibrator_id is not None and (not isinstance(calibrator_id, str) or not calibrator_id):
            _fail(f"component {component} has an invalid calibratorId")
        active[component] = record

    primary_record = active.get(primary)
    if primary_record is None:
        _fail(f"primary component {primary} must be active")

    for record in active.values():
        calibrator_id = record["calibratorId"]
        if calibrator_id is None:
            continue
        calibrator = active.get("calibrator")
        if calibrator is None or calibrator["implementationId"] != calibrator_id:
            _fail(f"component {record['component']} names an unavailable or mismatched calibrator")

    if legacy_model_version is not None and legacy_model_version != primary_record["implementationId"]:
        _fail("modelVersion must equal the primary component implementationId")

    if expected_digests is not None:
        for component, digest in expected_digests.items():
            if component not in MODEL_COMPONENTS:
                _fail(f"unknown expected model component: {component}")
            if active.get(component, {}).get("artifactDigest") != digest:
                _fail(f"artifact digest mismatch for {component}")

    return value
