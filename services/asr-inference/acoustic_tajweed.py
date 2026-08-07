"""Private, shadow-only reference-aware acoustic observation worker.

This module deliberately produces no learner finding and no calibrated confidence. It binds raw
Muaalem observations to an immutable candidate and to server-derived word spans. The public API
must retain only counts/status in an audit event until separate calibration and review gates exist.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import sys
from dataclasses import fields, is_dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from calibration_registry import load_calibrator_registry


_SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
_COMMIT = re.compile(r"^[a-f0-9]{40}$")
_DEFAULT_MANIFEST = Path(__file__).with_name("acoustic-candidates.json")
_DEFAULT_CALIBRATOR_REGISTRY = Path(__file__).with_name("calibrator-registry.json")


class AcousticRefusal(ValueError):
    """A stable refusal reason safe to record without audio or canonical text."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _profile_digest(profile: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        profile,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def load_shadow_candidate(
    manifest_path: str | Path = _DEFAULT_MANIFEST,
    *,
    calibrator_registry_path: str | Path = _DEFAULT_CALIBRATOR_REGISTRY,
) -> dict[str, Any]:
    try:
        manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("invalid acoustic candidate manifest") from error

    if manifest.get("schemaVersion") != 1:
        raise ValueError("invalid acoustic candidate manifest schema")
    candidates = manifest.get("candidates")
    active_id = manifest.get("activeCandidateId")
    if not isinstance(candidates, list) or not isinstance(active_id, str):
        raise ValueError("invalid acoustic candidate manifest selection")
    matches = [candidate for candidate in candidates if candidate.get("id") == active_id]
    if len(matches) != 1:
        raise ValueError("acoustic candidate selection must resolve exactly once")

    candidate = matches[0]
    model = candidate.get("model")
    implementation = candidate.get("implementation")
    qps = candidate.get("qps")
    limits = candidate.get("limits")
    if not all(isinstance(value, dict) for value in (model, implementation, qps, limits)):
        raise ValueError("acoustic candidate manifest is incomplete")
    if candidate.get("status") != "shadow-only" or candidate.get("releaseEligible") is not False:
        raise ValueError("uncalibrated acoustic candidate must remain shadow-only")
    calibrator_registry = load_calibrator_registry(calibrator_registry_path)
    if calibrator_registry["activeCalibratorId"] is not None:
        raise ValueError("shadow candidate cannot activate a calibrator")
    if not _COMMIT.fullmatch(str(model.get("revision", ""))):
        raise ValueError("acoustic model revision must be an immutable commit")
    if not _COMMIT.fullmatch(str(implementation.get("commit", ""))):
        raise ValueError("acoustic implementation revision must be an immutable commit")
    if not _COMMIT.fullmatch(str(qps.get("commit", ""))):
        raise ValueError("QPS implementation revision must be an immutable commit")
    if not _SHA256.fullmatch(str(model.get("artifactSha256", ""))):
        raise ValueError("acoustic artifact digest must be sha256")
    if not isinstance(model.get("artifactSizeBytes"), int) or model["artifactSizeBytes"] <= 0:
        raise ValueError("acoustic artifact size must be positive")
    model_files = model.get("files")
    if not isinstance(model_files, list) or not model_files:
        raise ValueError("acoustic model files must be pinned")
    pinned_files: dict[str, dict[str, Any]] = {}
    for model_file in model_files:
        if not isinstance(model_file, dict):
            raise ValueError("acoustic model file entry must be an object")
        file_path = model_file.get("path")
        if (
            not isinstance(file_path, str)
            or not file_path
            or Path(file_path).name != file_path
            or file_path in pinned_files
        ):
            raise ValueError("acoustic model file path must be a unique filename")
        if not _SHA256.fullmatch(str(model_file.get("sha256", ""))):
            raise ValueError("acoustic model file digest must be sha256")
        if not isinstance(model_file.get("sizeBytes"), int) or model_file["sizeBytes"] <= 0:
            raise ValueError("acoustic model file size must be positive")
        pinned_files[file_path] = model_file
    artifact_file = pinned_files.get(str(model.get("artifact", "")))
    if (
        artifact_file is None
        or artifact_file["sha256"] != model["artifactSha256"]
        or artifact_file["sizeBytes"] != model["artifactSizeBytes"]
    ):
        raise ValueError("acoustic artifact pin must match the model file set")
    profile = qps.get("profile")
    if not isinstance(profile, dict) or qps.get("profileChecksum") != _profile_digest(profile):
        raise ValueError("QPS profile checksum mismatch")
    if qps.get("profileStatus") != "pending-scholar-approval":
        raise ValueError("shadow QPS profile must remain scholar-pending")
    if limits.get("sampleRate") != 16_000 or limits.get("maxWindowMs") != 15_000:
        raise ValueError("acoustic candidate limits must preserve the reviewed 16kHz/15s boundary")
    if not isinstance(limits.get("maxWords"), int) or limits["maxWords"] <= 0:
        raise ValueError("acoustic maxWords must be positive")
    return candidate


def validate_observation_request(
    value: Mapping[str, Any],
    max_window_ms: int,
    max_words: int,
) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise AcousticRefusal("invalid-observation-request")
    if value.get("sampleRate") != 16_000:
        raise AcousticRefusal("unsupported-sample-rate")
    duration_ms = value.get("durationMs")
    if (
        not isinstance(duration_ms, int)
        or isinstance(duration_ms, bool)
        or duration_ms <= 0
        or duration_ms > max_window_ms
    ):
        raise AcousticRefusal("window-duration-limit")
    audio_path = value.get("audioPath")
    reference_text = value.get("referenceText")
    if not isinstance(audio_path, str) or not audio_path or not isinstance(reference_text, str) or not reference_text:
        raise AcousticRefusal("invalid-observation-request")

    segments = value.get("segments")
    if not isinstance(segments, list) or not 1 <= len(segments) <= max_words:
        raise AcousticRefusal("invalid-server-derived-spans")
    validated_segments: list[dict[str, Any]] = []
    word_ids: set[str] = set()
    prior_end = 0
    for segment in segments:
        if not isinstance(segment, Mapping):
            raise AcousticRefusal("invalid-server-derived-spans")
        word_id = segment.get("wordId")
        canonical_text = segment.get("canonicalText")
        start_ms = segment.get("startMs")
        end_ms = segment.get("endMs")
        if (
            not isinstance(word_id, str)
            or not word_id
            or word_id in word_ids
            or not isinstance(canonical_text, str)
            or not canonical_text
            or not isinstance(start_ms, int)
            or isinstance(start_ms, bool)
            or not isinstance(end_ms, int)
            or isinstance(end_ms, bool)
            or start_ms < prior_end
            or end_ms <= start_ms
            or end_ms > duration_ms
        ):
            raise AcousticRefusal("invalid-server-derived-spans")
        word_ids.add(word_id)
        prior_end = end_ms
        validated_segments.append(
            {
                "wordId": word_id,
                "canonicalText": canonical_text,
                "startMs": start_ms,
                "endMs": end_ms,
            }
        )

    # Exact string equality is intentional. Never normalize canonical Qur'an bytes here.
    if reference_text != " ".join(segment["canonicalText"] for segment in validated_segments):
        raise AcousticRefusal("reference-mismatch")
    core_word_ids = value.get("coreWordIds")
    if (
        not isinstance(core_word_ids, list)
        or not core_word_ids
        or len(core_word_ids) != len(set(core_word_ids))
        or any(not isinstance(word_id, str) or word_id not in word_ids for word_id in core_word_ids)
    ):
        raise AcousticRefusal("reference-mismatch")

    return {
        "audioPath": audio_path,
        "sampleRate": 16_000,
        "durationMs": duration_ms,
        "referenceText": reference_text,
        "segments": validated_segments,
        "coreWordIds": list(core_word_ids),
    }


def build_qps_reference(
    canonical_text: str,
    candidate: Mapping[str, Any],
    *,
    phonetizer: Callable[..., Any] | None = None,
    profile_type: Callable[..., Any] | None = None,
) -> Any:
    if phonetizer is None or profile_type is None:
        from quran_transcript import MoshafAttributes, quran_phonetizer

        phonetizer = quran_phonetizer
        profile_type = MoshafAttributes
    profile = profile_type(**candidate["qps"]["profile"])
    # Directly transform the server-authoritative bytes. Never use upstream Aya/Tanzil lookup and
    # never call normalize()/normalize_aya() on this text or its QPS derivative.
    return phonetizer(canonical_text, profile, remove_spaces=True)


def verify_model_artifact(model_root: str | Path, candidate: Mapping[str, Any]) -> Path:
    root = Path(model_root)
    model = candidate["model"]
    if not root.is_dir() and len(model["files"]) != 1:
        raise AcousticRefusal("model-artifact-unavailable")
    for model_file in model["files"]:
        path = root / model_file["path"] if root.is_dir() else root
        try:
            stat = path.stat()
        except OSError as error:
            raise AcousticRefusal("model-artifact-unavailable") from error
        if stat.st_size != model_file["sizeBytes"]:
            raise AcousticRefusal("model-artifact-mismatch")
        digest = hashlib.sha256()
        try:
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError as error:
            raise AcousticRefusal("model-artifact-unavailable") from error
        if "sha256:" + digest.hexdigest() != model_file["sha256"]:
            raise AcousticRefusal("model-artifact-mismatch")
    return root / model["artifact"] if root.is_dir() else root


def select_model_dtype(torch_module: Any, device: str, configured: str | None) -> Any:
    """Choose a finite CPU default while preserving upstream bfloat16 on accelerators."""

    dtype_name = configured or ("float32" if device == "cpu" else "bfloat16")
    if dtype_name not in ("float32", "bfloat16"):
        raise AcousticRefusal("invalid-acoustic-runtime-configuration")
    return getattr(torch_module, dtype_name)


def _to_float_list(value: Any) -> list[float]:
    if hasattr(value, "detach"):
        value = value.detach().cpu().tolist()
    elif hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, list):
        raise AcousticRefusal("invalid-model-output")
    flattened = [float(item) for item in value]
    if any(not math.isfinite(item) or item < 0.0 or item > 1.0 for item in flattened):
        raise AcousticRefusal("invalid-model-output")
    return flattened


def _serialize_sifat(value: Any) -> list[dict[str, Any]]:
    """Serialize categorical sifat while quarantining the upstream decoder's score field.

    Muaalem v3.2's mismatch branch assigns aligned class ids to ``Unit.probs`` instead of the
    aligned softmax values. The public ``SingleUnit.prob`` field can therefore contain values such
    as 2.0. Preserve the model's categorical shadow observation, but never expose that ambiguous
    value as a probability or confidence.
    """

    serialized: list[dict[str, Any]] = []
    for item in value:
        if not is_dataclass(item):
            raise AcousticRefusal("invalid-model-output")
        record: dict[str, Any] = {"phonemesGroup": str(getattr(item, "phonemes_group", ""))}
        for field in fields(item):
            if field.name == "phonemes_group":
                continue
            unit = getattr(item, field.name)
            if unit is None:
                record[field.name] = None
                continue
            decoder_value = float(getattr(unit, "prob"))
            label = getattr(unit, "text")
            label_index = getattr(unit, "idx")
            if (
                not math.isfinite(decoder_value)
                or not isinstance(label, str)
                or not label
                or isinstance(label_index, bool)
                or not isinstance(label_index, int)
                or label_index < 0
            ):
                raise AcousticRefusal("invalid-model-output")
            record[field.name] = {
                "label": label,
                "labelIndex": label_index,
                "scoreStatus": "withheld-upstream-decoder-bug",
            }
        serialized.append(record)
    return serialized


class AcousticWorkerClient:
    """Serialized JSONL client for a bounded, restartable acoustic child process."""

    def __init__(
        self,
        *,
        command: list[str] | None = None,
        timeout_seconds: float = 45.0,
        response_limit_bytes: int = 8 * 1024 * 1024,
    ):
        self.command = command or [sys.executable, str(Path(__file__)), "--worker"]
        if not self.command or timeout_seconds <= 0 or response_limit_bytes <= 0:
            raise ValueError("invalid acoustic worker client limits")
        self.timeout_seconds = timeout_seconds
        self.response_limit_bytes = response_limit_bytes
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def _start(self) -> None:
        if self.running:
            return
        await self._stop()
        self._process = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=self.response_limit_bytes,
        )

    async def _stop(self) -> None:
        process, self._process = self._process, None
        if process is None or process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=1.0)
        except TimeoutError:
            process.kill()
            await process.wait()

    async def observe(self, request: Mapping[str, Any]) -> dict[str, Any]:
        encoded = (json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )
        # A 15-second 16 kHz PCM WAV is below one MiB before base64. This larger ceiling permits
        # structured reference context while still bounding accidental or hostile internal input.
        if len(encoded) > 4 * 1024 * 1024:
            raise AcousticRefusal("acoustic-worker-request-limit")

        async with self._lock:
            for attempt in range(2):
                await self._start()
                process = self._process
                assert process is not None and process.stdin is not None and process.stdout is not None
                try:
                    process.stdin.write(encoded)
                    await process.stdin.drain()
                    line = await asyncio.wait_for(
                        process.stdout.readline(), timeout=self.timeout_seconds
                    )
                except TimeoutError as error:
                    await self._stop()
                    raise AcousticRefusal("acoustic-worker-timeout") from error
                except (BrokenPipeError, ConnectionError, ValueError):
                    await self._stop()
                    if attempt == 0:
                        continue
                    raise AcousticRefusal("acoustic-worker-unavailable")
                if not line:
                    await self._stop()
                    if attempt == 0:
                        continue
                    raise AcousticRefusal("acoustic-worker-unavailable")
                try:
                    response = json.loads(line)
                except json.JSONDecodeError as error:
                    await self._stop()
                    raise AcousticRefusal("invalid-acoustic-worker-response") from error
                if not isinstance(response, dict):
                    await self._stop()
                    raise AcousticRefusal("invalid-acoustic-worker-response")
                return response
        raise AcousticRefusal("acoustic-worker-unavailable")

    async def close(self) -> None:
        async with self._lock:
            await self._stop()


class AcousticEngine:
    """Lazy exact-artifact engine; one instance lives inside the restartable child process."""

    def __init__(
        self,
        candidate: Mapping[str, Any],
        model_root: str | Path,
        *,
        model_factory: Callable[[Path, Mapping[str, Any]], Any] | None = None,
        phonetizer: Callable[..., Any] | None = None,
        profile_type: Callable[..., Any] | None = None,
        audio_loader: Callable[[str], tuple[Any, int]] | None = None,
    ):
        self.candidate = candidate
        self.model_root = Path(model_root)
        self.model_factory = model_factory
        self.phonetizer = phonetizer
        self.profile_type = profile_type
        self.audio_loader = audio_loader
        self._model = None

    def _load_model(self):
        verify_model_artifact(self.model_root, self.candidate)
        if self._model is None:
            if self.model_factory is not None:
                self._model = self.model_factory(self.model_root, self.candidate)
            else:
                from quran_muaalem import Muaalem
                import torch

                device = os.environ.get("ACOUSTIC_DEVICE", "cpu")
                dtype = select_model_dtype(
                    torch,
                    device,
                    os.environ.get("ACOUSTIC_DTYPE"),
                )
                self._model = Muaalem(
                    model_name_or_path=str(self.model_root),
                    device=device,
                    dtype=dtype,
                )
        return self._model

    def observe(self, raw: Mapping[str, Any]) -> dict[str, Any]:
        limits = self.candidate["limits"]
        request = validate_observation_request(raw, limits["maxWindowMs"], limits["maxWords"])
        try:
            if self.audio_loader is not None:
                wave, sample_rate = self.audio_loader(request["audioPath"])
            else:
                import soundfile as sf

                wave, sample_rate = sf.read(
                    request["audioPath"], dtype="float32", always_2d=False
                )
        except Exception as error:
            raise AcousticRefusal("invalid-audio") from error
        if sample_rate != 16_000 or getattr(wave, "ndim", 0) != 1 or len(wave) == 0:
            raise AcousticRefusal("invalid-audio")
        measured_duration = round(len(wave) * 1000 / sample_rate)
        if abs(measured_duration - request["durationMs"]) > 2:
            raise AcousticRefusal("audio-duration-mismatch")
        reference = build_qps_reference(
            request["referenceText"],
            self.candidate,
            phonetizer=self.phonetizer,
            profile_type=self.profile_type,
        )
        output = self._load_model()([wave], [reference], sampling_rate=sample_rate)
        if not isinstance(output, list) or len(output) != 1:
            raise AcousticRefusal("invalid-model-output")
        result = output[0]
        phonemes = getattr(result, "phonemes", None)
        predicted = getattr(phonemes, "text", None)
        if not isinstance(predicted, str):
            raise AcousticRefusal("invalid-model-output")
        probabilities = _to_float_list(getattr(phonemes, "probs", None))
        observation = {
            "analysisBasis": "acoustic",
            "calibrationStatus": "uncalibrated",
            "coreWordIds": request["coreWordIds"],
            "referenceDigest": "sha256:"
            + hashlib.sha256(request["referenceText"].encode("utf-8")).hexdigest(),
            "predictedPhonemes": predicted,
            "phonemeRawProbabilities": probabilities,
            "sifat": _serialize_sifat(getattr(result, "sifat", None)),
        }
        return {"status": "observed", "observations": [observation], "refusalReason": None}


def worker_main() -> int:
    candidate = load_shadow_candidate()
    model_root = os.environ.get("ACOUSTIC_MODEL_PATH")
    engine = AcousticEngine(candidate, model_root) if model_root else None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if engine is None:
                raise AcousticRefusal("model-artifact-unavailable")
            response = engine.observe(request)
        except AcousticRefusal as error:
            response = {"status": "refused", "observations": [], "refusalReason": error.reason}
        except Exception:
            # Never echo exception text: model libraries can include temporary audio/model paths.
            response = {
                "status": "unavailable",
                "observations": [],
                "refusalReason": "acoustic-worker-unavailable",
            }
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__" and "--worker" in sys.argv:
    raise SystemExit(worker_main())
