import hashlib
import json
from pathlib import Path

import pytest

from model_attribution import (
    MODEL_COMPONENTS,
    build_acoustic_attribution,
    build_asr_attribution,
    build_forced_aligner_attribution,
    validate_model_attribution,
)
from candidate_evidence import (
    ARTIFACT_DIGEST_BASES,
    load_candidate_registry,
    resolve_runtime_candidate,
    verify_artifact_file,
)


def sha(char: str) -> str:
    return "sha256:" + char * 64


def test_component_vocabulary_is_closed_and_complete():
    assert MODEL_COMPONENTS == (
        "asr",
        "forced-aligner",
        "quran-aligner",
        "acoustic-scorer",
        "calibrator",
    )


def test_openai_whisper_digest_comes_from_the_verified_checkpoint_url():
    attribution = build_asr_attribution(
        model_id="base",
        model_urls={"base": f"https://models.invalid/{'a' * 64}/base.pt"},
        package_version="20240930",
    )
    component = attribution["components"][0]
    assert component["implementationId"] == "openai-whisper:base@20240930"
    assert component["artifactDigest"] == sha("a")
    assert component["datasetVersion"] == "upstream-training-data-undisclosed"
    assert attribution["primaryComponent"] == "asr"
    validate_model_attribution(
        attribution,
        expected_digests={"asr": sha("a")},
        legacy_model_version="openai-whisper:base@20240930",
    )


def test_external_model_alias_without_a_real_digest_is_refused():
    with pytest.raises(ValueError, match="ASR_MODEL_DIGEST"):
        build_asr_attribution(
            model_id="provider/quran-model",
            model_urls={},
            package_version="20240930",
            model_revision="b" * 40,
        )

    with pytest.raises(ValueError, match="ASR_MODEL_REVISION"):
        build_asr_attribution(
            model_id="provider/quran-model",
            model_urls={},
            package_version="20240930",
            declared_digest=sha("b"),
        )

    for mutable_revision in ("main", "latest", "release", "b" * 39):
        with pytest.raises(ValueError, match="ASR_MODEL_REVISION"):
            build_asr_attribution(
                model_id="provider/quran-model",
                model_urls={},
                package_version="20240930",
                declared_digest=sha("b"),
                model_revision=mutable_revision,
            )

    with pytest.raises(ValueError, match="artifact digest mismatch.*asr"):
        validate_model_attribution(
            build_asr_attribution(
                model_id="provider/quran-model",
                model_urls={},
                package_version="20240930",
                declared_digest=sha("b"),
                model_revision="c" * 40,
            ),
            expected_digests={"asr": sha("c")},
        )


def test_hugging_face_attribution_binds_the_full_commit_revision():
    revision = "c" * 40
    attribution = build_asr_attribution(
        model_id="provider/quran-model",
        model_urls={},
        package_version="20240930",
        declared_digest=sha("b"),
        model_revision=revision,
    )
    assert attribution["components"][0]["implementationId"] == (
        f"huggingface-transformers-pipeline:provider/quran-model@{revision}"
    )


def test_runtime_candidate_must_match_the_checked_in_registry(tmp_path):
    registry = load_candidate_registry(Path(__file__).with_name("model-candidates.json"))
    candidate = resolve_runtime_candidate(
        registry,
        candidate_id="openai-whisper-base",
        runtime="openai-whisper",
        model_id="base",
        revision=None,
        artifact_digest="sha256:ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e",
    )
    assert candidate["id"] == "openai-whisper-base"

    with pytest.raises(ValueError, match="ASR_CANDIDATE_ID is required"):
        resolve_runtime_candidate(
            registry,
            candidate_id=None,
            runtime="openai-whisper",
            model_id="base",
            revision=None,
            artifact_digest=candidate["artifactDigest"],
        )

    mutable = json.loads(json.dumps(registry))
    mutable["candidates"][0]["artifactDigest"] = sha("f")
    path = tmp_path / "mismatch.json"
    path.write_text(json.dumps(mutable), encoding="utf-8")
    with pytest.raises(ValueError, match="runtime artifactDigest does not match registry"):
        resolve_runtime_candidate(
            load_candidate_registry(path),
            candidate_id="openai-whisper-base",
            runtime="openai-whisper",
            model_id="base",
            revision=None,
            artifact_digest=candidate["artifactDigest"],
        )


def test_downloaded_artifact_bytes_must_match_the_registry_digest(tmp_path):
    artifact = tmp_path / "weights.bin"
    artifact.write_bytes(b"declared artifact fixture")
    digest = "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
    assert verify_artifact_file(artifact, digest) == digest

    with pytest.raises(ValueError, match="downloaded artifact digest mismatch"):
        verify_artifact_file(artifact, sha("0"))

def test_forced_aligner_requires_a_declared_artifact_digest():
    with pytest.raises(ValueError, match="FORCE_ALIGN_MODEL_DIGEST"):
        build_forced_aligner_attribution("provider/ctc-arabic")

    attribution = build_forced_aligner_attribution(
        "provider/ctc-arabic", declared_digest=sha("d")
    )
    assert attribution["components"][0]["component"] == "forced-aligner"
    assert attribution["components"][0]["artifactDigest"] == sha("d")


def test_acoustic_scorer_binds_the_selected_model_and_names_the_missing_calibrator():
    candidate = {
        "model": {
            "repository": "obadx/muaalem-model-v3_2",
            "revision": "01a1ef9fbe40d144ef845101e89ff924aed3fef5",
            "artifactSha256": "sha256:" + "6" * 64,
            "trainingDataset": "upstream-training-data-undisclosed",
        }
    }
    attribution = build_acoustic_attribution(candidate)
    assert attribution["primaryComponent"] == "acoustic-scorer"
    assert attribution["components"][0] == {
        "component": "acoustic-scorer",
        "status": "active",
        "implementationId": (
            "quran-muaalem:obadx/muaalem-model-v3_2"
            "@01a1ef9fbe40d144ef845101e89ff924aed3fef5"
        ),
        "artifactDigest": "sha256:" + "6" * 64,
        "datasetVersion": "upstream-training-data-undisclosed",
        "analysisBasis": "acoustic",
        "calibratorId": None,
    }
    assert attribution["components"][0]["implementationId"] != (
        "qrai-audio-tajweed-heuristics@0.1"
    )
    assert attribution["components"][1] == {
        "component": "calibrator",
        "status": "unavailable",
        "reason": "no held-out calibration artifact has been approved",
    }
    validate_model_attribution(attribution)


def test_artifact_digest_basis_vocabulary_is_closed(tmp_path):
    """`artifactDigestBasis` states HOW a digest was established, so it must be a closed vocabulary.

    Every other provenance-and-status field in the registry is checked against a fixed set —
    `runtime` against `_RUNTIMES`, `licenseReviewStatus` against approved/pending/rejected,
    `executionStatus` likewise. This one was validated only by `_string`, a TYPE check. That is worse
    than no check: `candidate_evidence.py` visibly validates the field, so it reads as guarded, while
    accepting any string at all.

    Measured before this test existed: rewriting a candidate's basis from
    "verified-upstream-download-url" to "verified-measured-benchmark" — a claim that the digest was
    confirmed by a benchmark this project has never run, and whose corpus W1.5 records as missing —
    left every release-evidence, claim-authority, candidate-evidence and attribution suite green.

    That is the fabricated-evaluation-claim shape the whole of QA-7 exists to prevent. A reviewer
    reading the registry takes this field as a statement of fact about verification, so the strings
    it may contain must be the ones the project actually knows how to establish.
    """
    registry = load_candidate_registry(Path(__file__).with_name("model-candidates.json"))

    # The declared vocabulary must actually cover what is checked in, or the guard would reject the
    # repository's own registry.
    for candidate in registry["candidates"]:
        assert candidate["artifactDigestBasis"] in ARTIFACT_DIGEST_BASES, (
            f"{candidate['id']} uses an undeclared basis {candidate['artifactDigestBasis']!r}"
        )

    for invented in (
        "verified-measured-benchmark",  # a benchmark that has never been run
        "scholar-approved",             # an approval this file cannot witness
        "trusted",                      # unfalsifiable
        "",                             # empty is not a provenance statement
    ):
        mutated = json.loads(json.dumps(registry))
        mutated["candidates"][0]["artifactDigestBasis"] = invented
        path = tmp_path / "invented-basis.json"
        path.write_text(json.dumps(mutated), encoding="utf-8")
        with pytest.raises(ValueError, match="artifactDigestBasis"):
            load_candidate_registry(path)
