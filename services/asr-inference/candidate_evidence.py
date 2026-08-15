"""Fail-closed validation for ASR candidate registry and benchmark evidence.

This module validates identities and aggregate evidence only. It never reads recitation audio,
does not compute release metrics, and does not sign a release decision; W1.12 owns those steps.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any


_SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
_COMMIT = re.compile(r"^[a-f0-9]{40}$")
_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_RUNTIMES = {"openai-whisper", "huggingface-transformers", "research-adapter"}
# How a candidate's artifactDigest was established. Closed on purpose, like every other status field
# below: this one is a statement of FACT about verification that a release reviewer relies on, and it
# was checked only by `_string` — a type check that accepts any claim at all, including bases for
# evidence this project does not possess. Measured: rewriting a basis to "verified-measured-benchmark"
# (a benchmark W1.5 records as blocked for want of a corpus) left every release-evidence,
# claim-authority and attribution suite green. Add a value here only when the project can actually
# establish it. See test_model_attribution.py::test_artifact_digest_basis_vocabulary_is_closed.
ARTIFACT_DIGEST_BASES = {
    # Digest computed from the bytes served by the candidate's pinned upstream download URL.
    "verified-upstream-download-url",
    # Digest read from Git LFS metadata at an immutable commit.
    "upstream-lfs-sha256-at-immutable-commit",
}
_APPROVAL_ROLES = {"product-owner", "quran-scholar", "privacy-legal", "data-steward"}
_SLICE_DIMENSIONS = ("accent", "age", "device", "noise")


class CandidateEvidenceError(ValueError):
    """The registry or evidence cannot be trusted structurally."""


def _fail(message: str) -> None:
    raise CandidateEvidenceError(message)


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{label} must be an object")
    return value


def _list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list) or not value:
        _fail(f"{label} must be a non-empty array")
    return value


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        _fail(f"{label} must be a non-empty string")
    return value


def _digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        _fail(f"{label} must be sha256 plus 64 lowercase hex characters")
    return value


def _commit(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _COMMIT.fullmatch(value):
        _fail(f"{label} must be a full 40-character lowercase commit hash")
    return value


def _number(value: Any, label: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result) or (positive and result <= 0):
        qualifier = "positive finite" if positive else "finite"
        _fail(f"{label} must be a {qualifier} number")
    return result


def _positive_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        _fail(f"{label} must be a positive integer")
    return value


def validate_candidate_registry(value: Any) -> dict[str, Any]:
    registry = _object(value, "candidate registry")
    if registry.get("schemaVersion") != 1:
        _fail("candidate registry schemaVersion must be 1")

    selection = _object(registry.get("selection"), "selection")
    status = selection.get("status")
    if status not in {"blocked-no-eligible-benchmark", "reviewed-winner"}:
        _fail("selection status is unknown")
    selected_id = selection.get("selectedCandidateId")
    if status == "blocked-no-eligible-benchmark":
        if selected_id is not None or selection.get("evidenceDigest") is not None:
            _fail("blocked selection cannot name a candidate or evidence digest")
        _list(selection.get("blockerCodes"), "selection blockerCodes")
    else:
        _string(selected_id, "selection selectedCandidateId")
        _digest(selection.get("evidenceDigest"), "selection evidenceDigest")

    candidates = _list(registry.get("candidates"), "candidates")
    seen: set[str] = set()
    for index, raw_candidate in enumerate(candidates):
        candidate = _object(raw_candidate, f"candidates[{index}]")
        candidate_id = _string(candidate.get("id"), f"candidates[{index}].id")
        if not _ID.fullmatch(candidate_id):
            _fail(f"candidate id {candidate_id!r} is not a stable lowercase id")
        if candidate_id in seen:
            _fail(f"duplicate candidate id: {candidate_id}")
        seen.add(candidate_id)

        runtime = candidate.get("runtime")
        if runtime not in _RUNTIMES:
            _fail(f"candidate {candidate_id} has an unknown runtime")
        _string(candidate.get("modelId"), f"candidate {candidate_id} modelId")
        revision = candidate.get("revision")
        if runtime == "huggingface-transformers":
            _commit(revision, f"candidate {candidate_id} revision")
        elif revision is not None:
            _fail(f"candidate {candidate_id} revision must be null for runtime {runtime}")
        _string(candidate.get("artifactFile"), f"candidate {candidate_id} artifactFile")
        _digest(candidate.get("artifactDigest"), f"candidate {candidate_id} artifactDigest")
        basis = _string(
            candidate.get("artifactDigestBasis"), f"candidate {candidate_id} artifactDigestBasis"
        )
        if basis not in ARTIFACT_DIGEST_BASES:
            _fail(
                f"candidate {candidate_id} artifactDigestBasis {basis!r} is not one of the bases this "
                f"project can establish: {sorted(ARTIFACT_DIGEST_BASES)}"
            )
        _string(candidate.get("upstreamUrl"), f"candidate {candidate_id} upstreamUrl")
        _string(
            candidate.get("trainingDataDisclosure"),
            f"candidate {candidate_id} trainingDataDisclosure",
        )
        _string(candidate.get("licenseSpdx"), f"candidate {candidate_id} licenseSpdx")
        if candidate.get("licenseReviewStatus") not in {
            "approved",
            "pending-independent-review",
            "rejected",
        }:
            _fail(f"candidate {candidate_id} has an unknown licenseReviewStatus")
        if candidate.get("executionStatus") not in {
            "runnable",
            "packaging-required",
            "research-only",
        }:
            _fail(f"candidate {candidate_id} has an unknown executionStatus")
        if candidate.get("benchmarkEligibility") not in {"candidate", "research-only"}:
            _fail(f"candidate {candidate_id} has an unknown benchmarkEligibility")
        for capability in _list(
            candidate.get("outputCapabilities"), f"candidate {candidate_id} outputCapabilities"
        ):
            _string(capability, f"candidate {candidate_id} output capability")

    if selected_id is not None:
        if selected_id not in seen:
            _fail("selected candidate does not exist in registry")
        selected_candidate = next(
            candidate for candidate in candidates if candidate["id"] == selected_id
        )
        if selected_candidate["licenseReviewStatus"] != "approved":
            _fail("selected candidate license review must be approved")
        if selected_candidate["executionStatus"] != "runnable":
            _fail("selected candidate must be runnable")
        if selected_candidate["benchmarkEligibility"] != "candidate":
            _fail("selected candidate must be benchmark eligible")
    return registry


def load_candidate_registry(path: str | Path) -> dict[str, Any]:
    return validate_candidate_registry(json.loads(Path(path).read_text(encoding="utf-8")))


def _candidate_by_id(registry: dict[str, Any], candidate_id: str) -> dict[str, Any]:
    for candidate in registry["candidates"]:
        if candidate["id"] == candidate_id:
            return candidate
    _fail(f"candidateId {candidate_id!r} is not registered")


def resolve_runtime_candidate(
    registry_value: Any,
    *,
    candidate_id: str | None,
    runtime: str,
    model_id: str,
    revision: str | None,
    artifact_digest: str,
) -> dict[str, Any]:
    """Bind one process configuration to one checked-in candidate identity."""
    registry = validate_candidate_registry(registry_value)
    if candidate_id is None or not candidate_id.strip():
        _fail("ASR_CANDIDATE_ID is required")
    candidate = _candidate_by_id(registry, candidate_id)
    supplied = {
        "runtime": runtime,
        "modelId": model_id,
        "revision": revision,
        "artifactDigest": artifact_digest,
    }
    for field, value in supplied.items():
        if candidate.get(field) != value:
            _fail(f"runtime {field} does not match registry candidate {candidate_id}")
    if candidate["executionStatus"] != "runnable":
        _fail(f"registry candidate {candidate_id} is not runnable")
    return candidate


def verify_artifact_file(path: str | Path, expected_digest: str) -> str:
    expected = _digest(expected_digest, "expected artifact digest")
    hasher = hashlib.sha256()
    with Path(path).open("rb") as artifact:
        for chunk in iter(lambda: artifact.read(1024 * 1024), b""):
            hasher.update(chunk)
    actual = "sha256:" + hasher.hexdigest()
    if actual != expected:
        _fail("downloaded artifact digest mismatch")
    return actual


def _metrics(value: Any, label: str) -> dict[str, float]:
    raw = _object(value, label)
    if not raw:
        _fail(f"{label} must not be empty")
    return {key: _number(metric, f"{label}.{key}") for key, metric in raw.items()}


def assess_candidate_evidence(value: Any, registry_value: Any) -> dict[str, Any]:
    registry = validate_candidate_registry(registry_value)
    evidence = _object(value, "candidate evidence")
    if evidence.get("schemaVersion") != 1:
        _fail("candidate evidence schemaVersion must be 1")
    evidence_kind = evidence.get("evidenceKind")
    if evidence_kind not in {"declared-fixture", "measured-held-out"}:
        _fail("evidenceKind must be declared-fixture or measured-held-out")

    supplied_candidate = _object(evidence.get("candidate"), "candidate")
    candidate_id = _string(supplied_candidate.get("candidateId"), "candidate candidateId")
    candidate = _candidate_by_id(registry, candidate_id)
    for field in ("runtime", "modelId", "revision", "artifactDigest"):
        if supplied_candidate.get(field) != candidate.get(field):
            _fail(f"candidate {field} does not match registry")
    _digest(supplied_candidate.get("runtimeLockDigest"), "candidate runtimeLockDigest")
    _digest(supplied_candidate.get("imageDigest"), "candidate imageDigest")

    dataset = _object(evidence.get("dataset"), "dataset")
    _string(dataset.get("version"), "dataset version")
    _digest(dataset.get("manifestDigest"), "dataset manifestDigest")
    if dataset.get("split") != "held-out":
        _fail("dataset split must be held-out")
    if dataset.get("reciterDisjoint") is not True:
        _fail("dataset must be reciter-disjoint")
    if dataset.get("sealed") is not True:
        _fail("dataset manifest must be sealed")
    consent_status = dataset.get("consentStatus")
    if consent_status not in {"approved", "pending", "rejected"}:
        _fail("dataset consentStatus is unknown")

    evaluator = _object(evidence.get("evaluator"), "evaluator")
    _digest(evaluator.get("implementationDigest"), "evaluator implementationDigest")
    _commit(evaluator.get("sourceCommit"), "evaluator sourceCommit")

    protocol = _object(evidence.get("protocol"), "protocol")
    _string(protocol.get("version"), "protocol version")
    _digest(protocol.get("digest"), "protocol digest")
    approval_status = protocol.get("approvalStatus")
    if approval_status not in {"approved", "pending", "rejected"}:
        _fail("protocol approvalStatus is unknown")

    approvals: dict[str, str] = {}
    for index, raw_approval in enumerate(_list(protocol.get("approvals"), "protocol approvals")):
        approval = _object(raw_approval, f"protocol approvals[{index}]")
        role = approval.get("role")
        if role not in _APPROVAL_ROLES:
            _fail(f"protocol approval role {role!r} is unknown")
        if role in approvals:
            _fail(f"duplicate protocol approval role: {role}")
        _string(approval.get("reviewerId"), f"protocol approval {role} reviewerId")
        status = approval.get("status")
        if status not in {"approved", "pending", "rejected"}:
            _fail(f"protocol approval {role} status is unknown")
        approvals[role] = status

    required_slices: dict[str, dict[str, Any]] = {}
    for index, raw_slice in enumerate(
        _list(protocol.get("requiredSlices"), "protocol requiredSlices")
    ):
        slice_definition = _object(raw_slice, f"protocol requiredSlices[{index}]")
        slice_id = _string(slice_definition.get("sliceId"), "required sliceId")
        if slice_id in required_slices:
            _fail(f"duplicate required slice: {slice_id}")
        for dimension in _SLICE_DIMENSIONS:
            _string(slice_definition.get(dimension), f"required slice {slice_id} {dimension}")
        required_slices[slice_id] = slice_definition

    thresholds: list[tuple[str, str, float, str]] = []
    seen_thresholds: set[tuple[str, str]] = set()
    for index, raw_threshold in enumerate(
        _list(protocol.get("thresholds"), "protocol thresholds")
    ):
        threshold = _object(raw_threshold, f"protocol thresholds[{index}]")
        metric = _string(threshold.get("metric"), "threshold metric")
        direction = threshold.get("direction")
        scope = threshold.get("scope")
        if direction not in {"min", "max"}:
            _fail(f"threshold {metric} direction must be min or max")
        if scope not in {"aggregate", "every-slice"}:
            _fail(f"threshold {metric} scope must be aggregate or every-slice")
        if (metric, scope) in seen_thresholds:
            _fail(f"duplicate threshold for {metric} at {scope}")
        seen_thresholds.add((metric, scope))
        thresholds.append((metric, direction, _number(threshold.get("value"), "threshold value"), scope))

    aggregate_metrics = _metrics(evidence.get("aggregateMetrics"), "aggregateMetrics")
    measured_slices: dict[str, dict[str, float]] = {}
    for index, raw_slice in enumerate(_list(evidence.get("slices"), "slices")):
        measured_slice = _object(raw_slice, f"slices[{index}]")
        slice_id = _string(measured_slice.get("sliceId"), "measured sliceId")
        if slice_id in measured_slices:
            _fail(f"duplicate measured slice: {slice_id}")
        if slice_id not in required_slices:
            _fail(f"unexpected measured slice: {slice_id}")
        _positive_integer(measured_slice.get("reciterCount"), f"slice {slice_id} reciterCount")
        _positive_integer(measured_slice.get("utteranceCount"), f"slice {slice_id} utteranceCount")
        measured_slices[slice_id] = _metrics(measured_slice.get("metrics"), f"slice {slice_id} metrics")
    missing_slices = sorted(set(required_slices) - set(measured_slices))
    if missing_slices:
        _fail(f"missing required slice: {', '.join(missing_slices)}")

    resources = _object(evidence.get("resources"), "resources")
    _number(resources.get("realTimeFactorP95"), "resources realTimeFactorP95", positive=True)
    _positive_integer(resources.get("peakRssBytes"), "resources peakRssBytes")
    _positive_integer(resources.get("imageBytes"), "resources imageBytes")

    reason_codes: list[str] = []
    if evidence_kind != "measured-held-out":
        reason_codes.append("declared-fixture-ineligible")
    if candidate["licenseReviewStatus"] != "approved":
        reason_codes.append("candidate-license-review-pending")
    if candidate["executionStatus"] != "runnable":
        reason_codes.append("candidate-not-runnable")
    if candidate["benchmarkEligibility"] != "candidate":
        reason_codes.append("research-only-candidate")
    if consent_status != "approved":
        reason_codes.append("dataset-consent-not-approved")
    if approval_status != "approved":
        reason_codes.append("protocol-not-approved")
    for role in sorted(_APPROVAL_ROLES):
        if approvals.get(role) != "approved":
            reason_codes.append(f"protocol-{role}-approval-missing")

    for metric, direction, threshold, scope in thresholds:
        if scope == "aggregate":
            if metric not in aggregate_metrics:
                _fail(f"aggregateMetrics is missing threshold metric {metric}")
            values = [aggregate_metrics[metric]]
        else:
            missing_metric = sorted(
                slice_id for slice_id, metrics in measured_slices.items() if metric not in metrics
            )
            if missing_metric:
                _fail(f"slice metrics are missing threshold metric {metric}: {', '.join(missing_metric)}")
            values = [metrics[metric] for metrics in measured_slices.values()]
        passed = all(value >= threshold for value in values) if direction == "min" else all(
            value <= threshold for value in values
        )
        if not passed:
            reason_codes.append(f"threshold-not-met:{metric}:{scope}")

    unique_reasons = sorted(set(reason_codes))
    return {
        "schemaVersion": 1,
        "candidateId": candidate_id,
        "candidateBound": True,
        "eligibleForReview": not unique_reasons,
        "reasonCodes": unique_reasons,
        "requiredSliceCount": len(required_slices),
        "measuredSliceCount": len(measured_slices),
    }


def _read_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", required=True)
    parser.add_argument("--evidence")
    args = parser.parse_args(argv)
    try:
        registry = load_candidate_registry(args.registry)
        if args.evidence:
            result = assess_candidate_evidence(_read_json(args.evidence), registry)
        else:
            result = {
                "schemaVersion": 1,
                "valid": True,
                "candidateCount": len(registry["candidates"]),
                "selectionStatus": registry["selection"]["status"],
            }
    except (CandidateEvidenceError, OSError, json.JSONDecodeError) as exc:
        print(f"candidate evidence invalid: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
