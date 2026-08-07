"""
Quran AI ASR Inference Service

Real acoustic speech recognition using OpenAI Whisper.
Accepts audio bytes → returns recognized Arabic text + word-level timestamps.

This is NOT a text-processing demo. Whisper processes actual audio waveforms
through a neural transformer model trained on 680K hours of multilingual audio.
Arabic is one of Whisper's supported languages, and it produces word-level
timestamps via cross-attention alignment.

Endpoints:
  GET  /health                — process-only liveness
  GET  /ready                 — loaded model + digest + known-audio readiness
  POST /v1/transcribe         — transcribe audio bytes → text + word timestamps
  POST /v1/force-align        — force align audio + canonical text → word timestamps
  POST /v1/acoustic-tajweed:observe — private shadow-only reference-aware observations
"""

import asyncio
import io
import os
import re
import json
import base64
import subprocess
import tempfile
import threading
import time
import logging
from contextlib import asynccontextmanager
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Literal, Optional, Union

import torch
import torchaudio
import soundfile as sf
import numpy as np
import whisper
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from audio_guards import MAX_AUDIO_SECONDS, enforce_max_duration, probe_duration_seconds
from acoustic_tajweed import (
    AcousticRefusal,
    AcousticWorkerClient,
    load_shadow_candidate,
)
from candidate_evidence import (
    load_candidate_registry,
    resolve_runtime_candidate,
    verify_artifact_file,
)
from model_attribution import (
    build_acoustic_attribution,
    build_asr_attribution,
    build_forced_aligner_attribution,
    require_immutable_hf_revision,
)
from readiness import AsrReadinessController, known_audio_wav_bytes

# API-key gate. The browser must NOT reach this service directly — it is fronted by the platform-api
# /v1/asr/* proxy, which holds ASR_API_KEY server-side (like ML_API_KEY for ml-inference). ml-inference
# also sends the key on its server-to-server transcribe call. Health stays open. In dev/CI the default
# key is used on both sides; in production ASR_API_KEY is set (platform-api boot-refuses a weak value).
ASR_API_KEY = os.environ.get("ASR_API_KEY", "smoke-asr-api-key")

ACOUSTIC_SHADOW_ENABLED = os.environ.get("ACOUSTIC_SHADOW_ENABLED", "").strip().lower() in (
    "1",
    "true",
)
ACOUSTIC_CANDIDATE = load_shadow_candidate()
ACOUSTIC_WORKER_TIMEOUT_SECONDS = float(
    os.environ.get("ACOUSTIC_WORKER_TIMEOUT_SECONDS", "45")
)
if ACOUSTIC_WORKER_TIMEOUT_SECONDS <= 0:
    raise RuntimeError("ACOUSTIC_WORKER_TIMEOUT_SECONDS must be positive")
acoustic_worker = AcousticWorkerClient(timeout_seconds=ACOUSTIC_WORKER_TIMEOUT_SECONDS)


def require_asr_key(x_asr_api_key: Optional[str] = Header(default=None)) -> None:
    if x_asr_api_key != ASR_API_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")


# === Rate limiter (sliding window, per-IP) ===
# This is the compute-heaviest service in the fleet (real Whisper inference) and, until now, the
# only backend service with NO self-protection at all — platform-api, the realtime gateway, and
# ml-inference all already have an equivalent per-IP limiter. Not reachable by an external client
# today (fronted by the platform-api /v1/asr proxy, itself rate-limited, and bound to 127.0.0.1),
# but defence-in-depth for anyone with direct network access to this service and a valid
# ASR_API_KEY (a compromised sibling container, a future architecture change).
RATE_LIMIT_WINDOW_SECONDS = 60.0
RATE_LIMIT_MAX = 100
_rate_limit_state: dict[str, list[float]] = {}
# `require_rate_limit` is a SYNC dependency, and FastAPI runs sync dependencies in a threadpool —
# true parallel OS threads, not just cooperative async interleaving. Without this lock, concurrent
# requests race on the read-check-write of `_rate_limit_state` (the same lost-update class as an
# unlocked check-then-increment counter): verified empirically that 130 concurrent requests all
# passed the "check" step before any committed their "write", so far more than RATE_LIMIT_MAX got
# through. A plain threading.Lock (not asyncio.Lock, which only guards the event loop, not threads)
# serializes the whole check-and-update per call.
_rate_limit_lock = threading.Lock()
# Only trust X-Forwarded-For when explicitly opted in for a deployment behind a real reverse proxy
# that OVERWRITES the header — trusting it unconditionally lets a direct client bypass the whole
# limiter by varying the header per request (this exact bug was found and fixed in ml-inference's
# rate limiter; applying the lesson here from the start). Matches platform-api's naming/posture.
TRUST_PROXY_HEADERS = os.environ.get("TRUST_PROXY_HEADERS", "").strip().lower() in ("1", "true")


def require_rate_limit(request: Request) -> None:
    if TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-forwarded-for")
        client_ip = forwarded.split(",")[0].strip() if forwarded else None
    else:
        client_ip = None
    if not client_ip:
        client_ip = request.client.host if request.client else "unknown"

    now = time.time()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    with _rate_limit_lock:
        timestamps = [t for t in _rate_limit_state.get(client_ip, []) if t > cutoff]
        if len(timestamps) >= RATE_LIMIT_MAX:
            raise HTTPException(status_code=429, detail="Too many requests. Please try again later.")
        timestamps.append(now)
        _rate_limit_state[client_ip] = timestamps

        # Opportunistic cleanup: once the tracked-IP count grows large, sweep out any key whose
        # entries are now entirely stale. Bounds memory without a background task/thread — this
        # service handles far lower request volume than ml-inference, so an occasional O(n) sweep
        # triggered by dict growth is cheap relative to a real transcription request.
        if len(_rate_limit_state) > 10_000:
            stale = [ip for ip, ts in _rate_limit_state.items() if not any(t > cutoff for t in ts)]
            for ip in stale:
                del _rate_limit_state[ip]


# Whitelist of accepted audio container formats. The client-controlled audioFormat is turned into a
# tempfile suffix; without this guard a value with a NUL byte ("wav\0") or path traversal ("../../x")
# makes tempfile.NamedTemporaryFile raise an UNHANDLED 500 (the call sits outside the endpoint's
# try/except). Validating up front turns bad input into a clean 400.
ALLOWED_AUDIO_FORMATS = {"webm", "wav", "mp3", "m4a", "ogg", "flac"}


def safe_audio_suffix(audio_format: str) -> str:
    fmt = (audio_format or "").strip().lower()
    if fmt not in ALLOWED_AUDIO_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported audioFormat {audio_format!r}; allowed: {sorted(ALLOWED_AUDIO_FORMATS)}",
        )
    return f".{fmt}"


# Cap the base64 payload so a single request cannot force an unbounded decode into memory + a
# large temp file on disk. ~20M base64 chars ≈ 15 MB of decoded audio — ample for a recitation
# clip; the platform-api /v1/asr proxy additionally caps the request body at 16 MB for browser
# traffic, so this is defence-in-depth for any direct (server-side) caller.
MAX_AUDIO_B64_CHARS = 20_000_000

def decode_audio_b64(b64: str) -> bytes:
    """Validate and decode a base64 audio payload. Every failure is a client error (4xx) — an empty,
    oversized, malformed, or empty-when-decoded payload must never fall through to a 500."""
    if not b64 or not b64.strip():
        raise HTTPException(status_code=400, detail="audioBase64 is required")
    if len(b64) > MAX_AUDIO_B64_CHARS:
        raise HTTPException(status_code=413, detail="audioBase64 is too large")
    try:
        audio_bytes = base64.b64decode(b64, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base64 audio: {exc}")
    if not audio_bytes:
        # e.g. "==" — valid base64 that decodes to zero bytes; downstream would 500 on empty audio.
        raise HTTPException(status_code=400, detail="audioBase64 decoded to empty audio")
    return audio_bytes

# === Structured JSON Logger ===
class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname.lower(),
            "service": "asr-inference",
            "msg": record.getMessage(),
        }
        if record.exc_info and record.exc_info[1]:
            entry["error"] = str(record.exc_info[1])
        return json.dumps(entry)

_handler = logging.StreamHandler()
_handler.setFormatter(JsonFormatter())
logger = logging.getLogger("asr-inference")
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
logger.addHandler(_handler)
logger.propagate = False

# === Model Loading ===
# Default to the real Quran-fine-tuned ASR (diacritized Arabic) via HF transformers.
# If ASR_MODEL is a bare Whisper size (tiny/base/small/...), fall back to openai-whisper.
ASR_MODEL = os.environ.get("ASR_MODEL", "tarteel-ai/whisper-base-ar-quran")
ASR_MODEL_REVISION = os.environ.get("ASR_MODEL_REVISION")
ASR_CANDIDATE_ID = os.environ.get("ASR_CANDIDATE_ID")
MODEL_NAME = ASR_MODEL
_USE_HF = "/" in ASR_MODEL

# Model handles, populated by _load_model(). They stay None until a successful load. A load failure
# (bad ASR_MODEL, Hugging Face Hub unreachable, OOM) must NOT crash the process before it can serve:
# previously the model was loaded at import time with no guard, so any failure raised before
# `app = FastAPI(...)` and uvicorn never bound the port — there was no way to even reach /health to
# see why. Now the failure is captured in _load_error, the port still binds, /health reports the
# error, and requests return 503 (require_loaded_model) until a subsequent load succeeds.
asr_pipe = None
model = None
DEVICE_STR = "cpu"
_load_error: Optional[str] = None


def _resolve_current_asr() -> tuple[dict, dict]:
    attribution = build_asr_attribution(
        model_id=ASR_MODEL,
        model_urls=getattr(whisper, "_MODELS", {}),
        package_version=package_version("openai-whisper"),
        declared_digest=os.environ.get("ASR_MODEL_DIGEST"),
        model_revision=ASR_MODEL_REVISION,
        dataset_version=os.environ.get(
            "ASR_DATASET_VERSION", "upstream-training-data-undisclosed"
        ),
    )
    component = attribution["components"][0]
    candidate = resolve_runtime_candidate(
        load_candidate_registry(Path(__file__).with_name("model-candidates.json")),
        candidate_id=ASR_CANDIDATE_ID,
        runtime="huggingface-transformers" if _USE_HF else "openai-whisper",
        model_id=ASR_MODEL,
        revision=ASR_MODEL_REVISION,
        artifact_digest=component["artifactDigest"],
    )
    return attribution, candidate


def _load_model() -> None:
    """Load the selected model. The readiness worker catches failures and retries them."""
    global asr_pipe, model, DEVICE_STR, _load_error
    asr_pipe = None
    model = None
    DEVICE_STR = "cpu"
    _load_error = None
    try:
        # Refuse a missing, mutable, mismatched, or packaging-only registry candidate before model
        # download/allocation. The same binding is checked again when attribution is returned.
        _, candidate = _resolve_current_asr()
        if _USE_HF:
            from huggingface_hub import hf_hub_download
            from transformers import pipeline as hf_pipeline

            require_immutable_hf_revision(ASR_MODEL_REVISION)
            artifact_path = hf_hub_download(
                repo_id=ASR_MODEL,
                filename=candidate["artifactFile"],
                revision=ASR_MODEL_REVISION,
            )
            verify_artifact_file(artifact_path, candidate["artifactDigest"])
            DEVICE_STR = (
                "mps"
                if torch.backends.mps.is_available()
                else ("cuda" if torch.cuda.is_available() else "cpu")
            )
            logger.info("Loading HF Quran ASR model: %s on %s", ASR_MODEL, DEVICE_STR)
            asr_pipe = hf_pipeline(
                "automatic-speech-recognition",
                model=ASR_MODEL,
                revision=ASR_MODEL_REVISION,
                device=DEVICE_STR,
            )
            logger.info("HF Quran ASR %s loaded on %s", ASR_MODEL, DEVICE_STR)
        else:
            logger.info("Loading Whisper model: %s", ASR_MODEL)
            model = whisper.load_model(ASR_MODEL)
            DEVICE_STR = str(model.device)
            logger.info("Whisper %s loaded. Device: %s", ASR_MODEL, model.device)
        _load_error = None
    except Exception as exc:  # noqa: BLE001 — any load failure must degrade, not crash startup
        _load_error = f"{type(exc).__name__}: {exc}"
        logger.error(
            "ASR model %s failed to load; serving DEGRADED (requests will 503): %s",
            ASR_MODEL,
            _load_error,
        )
        raise


@asynccontextmanager
async def lifespan(_app: FastAPI):
    readiness_controller.start()
    try:
        yield
    finally:
        await acoustic_worker.close()
        readiness_controller.stop()


app = FastAPI(title="Quran AI ASR Inference", version="0.1.0", lifespan=lifespan)

# MAX_AUDIO_B64_CHARS only rejects an oversized audioBase64 field AFTER FastAPI/Starlette has
# already read the full request body off the socket and parsed it into a JSON object in memory --
# so an oversized request still pays the full read+parse cost (and holds that memory) before the
# existing check ever runs. This middleware rejects early using the Content-Length header, before
# Starlette reads the body at all. ~26M bytes gives headroom over MAX_AUDIO_B64_CHARS (20M chars,
# which is already almost entirely the request body for this endpoint) plus JSON/field overhead.
MAX_REQUEST_BODY_BYTES = 26_000_000


@app.middleware("http")
async def limit_request_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            too_large = int(content_length) > MAX_REQUEST_BODY_BYTES
        except ValueError:
            too_large = False
        if too_large:
            return JSONResponse(status_code=413, content={"detail": "request body too large"})
    return await call_next(request)


def require_loaded_model() -> None:
    """Use the same fail-closed state as `/ready`; loaded-but-unproved is not serviceable."""
    snapshot = readiness_controller.snapshot()
    if not snapshot.ready:
        raise HTTPException(
            status_code=503,
            detail=f"ASR model not ready: {snapshot.reason or 'unavailable'}",
        )

# === Models ===

class TranscribeRequest(BaseModel):
    audioBase64: str
    audioFormat: str = "webm"  # webm, wav, mp3, m4a
    language: str = "ar"  # Arabic by default
    wordTimestamps: bool = True


class WordSegment(BaseModel):
    word: str
    start: float  # seconds
    end: float    # seconds
    probability: float


class ActiveModelComponentAttribution(BaseModel):
    component: Literal["asr", "forced-aligner", "quran-aligner", "acoustic-scorer", "calibrator"]
    status: Literal["active"]
    implementationId: str
    artifactDigest: str
    datasetVersion: str
    analysisBasis: Literal["acoustic", "quran-constrained", "text-rule"]
    calibratorId: Optional[str]


class UnavailableModelComponentAttribution(BaseModel):
    component: Literal["asr", "forced-aligner", "quran-aligner", "acoustic-scorer", "calibrator"]
    status: Literal["unavailable"]
    reason: str


class ModelAttribution(BaseModel):
    schemaVersion: Literal[1]
    primaryComponent: Literal["asr", "forced-aligner", "quran-aligner", "acoustic-scorer", "calibrator"]
    components: list[Union[ActiveModelComponentAttribution, UnavailableModelComponentAttribution]]


class TranscribeResponse(BaseModel):
    text: str
    language: str
    duration: float  # seconds
    words: list[WordSegment]
    modelVersion: str
    modelAttribution: ModelAttribution
    latencyMs: int


class ForceAlignRequest(BaseModel):
    audioBase64: str
    audioFormat: str = "webm"
    transcript: str  # canonical text to align against
    language: str = "ar"


class AlignedWord(BaseModel):
    word: str
    start: float
    end: float
    score: float


class ForceAlignResponse(BaseModel):
    words: list[AlignedWord]
    duration: float
    modelVersion: str
    modelAttribution: ModelAttribution
    latencyMs: int


class AcousticWordSegment(BaseModel):
    wordId: str = Field(min_length=1)
    canonicalText: str = Field(min_length=1)
    startMs: int = Field(ge=0)
    endMs: int = Field(gt=0)


class AcousticObservationRequest(BaseModel):
    audioBase64: str = Field(min_length=1, max_length=MAX_AUDIO_B64_CHARS)
    audioFormat: Literal["wav"] = "wav"
    sampleRate: Literal[16000]
    durationMs: int = Field(gt=0, le=15_000)
    referenceText: str = Field(min_length=1)
    segments: list[AcousticWordSegment] = Field(min_length=1, max_length=256)
    coreWordIds: list[str] = Field(min_length=1, max_length=256)


class AcousticObservationResponse(BaseModel):
    status: Literal["observed", "refused", "unavailable"]
    observations: list[dict]
    refusalReason: Optional[str] = None
    candidateId: str
    qpsProfileId: str
    qpsProfileChecksum: str
    modelVersion: Optional[str] = None
    modelAttribution: Optional[ModelAttribution] = None
    latencyMs: int


def current_asr_attribution() -> dict:
    try:
        attribution, _ = _resolve_current_asr()
        return attribution
    except ValueError:
        logger.exception("ASR model attribution is unresolved")
        raise HTTPException(status_code=503, detail="ASR model attribution is unresolved")


def current_forced_aligner_attribution(model_id: str) -> dict:
    try:
        return build_forced_aligner_attribution(
            model_id,
            declared_digest=os.environ.get("FORCE_ALIGN_MODEL_DIGEST"),
            dataset_version=os.environ.get(
                "FORCE_ALIGN_DATASET_VERSION", "upstream-training-data-undisclosed"
            ),
        )
    except ValueError:
        logger.exception("forced-aligner model attribution is unresolved")
        raise HTTPException(status_code=503, detail="forced-aligner model attribution is unresolved")


def _load_and_resolve_asr_digest() -> str:
    _load_model()
    attribution = current_asr_attribution()
    return attribution["components"][0]["artifactDigest"]


def _probe_loaded_asr_model() -> None:
    """Exercise the selected inference path with the declared synthetic zero-signal fixture."""
    audio = known_audio_wav_bytes()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio)
        probe_path = tmp.name
    try:
        if _USE_HF:
            if asr_pipe is None:
                raise RuntimeError("HF ASR pipeline is unavailable")
            result = asr_pipe(probe_path)
        else:
            if model is None:
                raise RuntimeError("Whisper ASR model is unavailable")
            result = model.transcribe(
                probe_path,
                language="ar",
                word_timestamps=False,
                fp16=False,
            )
        if not isinstance(result, dict) or not isinstance(result.get("text"), str):
            raise RuntimeError("known-audio probe returned an invalid result shape")
    except Exception:
        logger.exception("ASR known-audio readiness probe failed")
        raise
    finally:
        os.unlink(probe_path)


def _positive_env_seconds(name: str, default: str) -> float:
    try:
        value = float(os.environ.get(name, default))
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a positive number") from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive number")
    return value


readiness_controller = AsrReadinessController(
    model_id=ASR_MODEL,
    expected_digest=os.environ.get("ASR_MODEL_DIGEST"),
    load_and_resolve=_load_and_resolve_asr_digest,
    probe=_probe_loaded_asr_model,
    probe_timeout_seconds=_positive_env_seconds("ASR_READINESS_PROBE_TIMEOUT_SECONDS", "60"),
    retry_seconds=_positive_env_seconds("ASR_READINESS_RETRY_SECONDS", "10"),
)


# === Endpoints ===

@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "quran-ai-asr-inference",
    }


@app.get("/ready")
async def ready():
    snapshot = readiness_controller.snapshot()
    content = {
        "ready": snapshot.ready,
        "service": "quran-ai-asr-inference",
        "model": snapshot.model_id,
        "reason": snapshot.reason,
        "attempt": snapshot.attempt,
    }
    if snapshot.artifact_digest is not None:
        content["artifactDigest"] = snapshot.artifact_digest
    if snapshot.probe_duration_ms is not None:
        content["probeDurationMs"] = snapshot.probe_duration_ms
    return JSONResponse(status_code=200 if snapshot.ready else 503, content=content)


@app.post(
    "/v1/transcribe",
    response_model=TranscribeResponse,
    dependencies=[Depends(require_rate_limit), Depends(require_asr_key), Depends(require_loaded_model)],
)
async def transcribe(req: TranscribeRequest):
    start = time.time()

    if not req.audioBase64:
        raise HTTPException(status_code=400, detail="audioBase64 is required")

    # Decode base64 audio → temp file. Malformed base64 is a client error (400), not a 500.
    audio_bytes = decode_audio_b64(req.audioBase64)
    suffix = safe_audio_suffix(req.audioFormat)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        # Reject over-long audio before running the (CPU-bound, potentially multi-minute) model.
        enforce_max_duration(tmp_path)
        if asr_pipe is not None:
            # The REAL container duration, not 0.0.
            #
            # This branch used to report `duration=0.0` for every request, which is a measurement the
            # service never took presented as one it did: a caller reading it gets "this recitation
            # is zero seconds long" for audio that plainly is not. ffprobe already ran inside
            # enforce_max_duration above, so this costs one more metadata read and no decode.
            #
            # probe_duration_seconds returns 0.0 when the container will not say (streamed input, no
            # ffprobe). That is the same value it always returned here, so this can only ever improve
            # the answer — and 0.0 now means "unknown", which is the truth, instead of "zero".
            hf_duration = round(probe_duration_seconds(tmp_path), 3)
            # HF Quran ASR — this checkpoint is fine-tuned for Arabic Quran, so a plain
            # call returns diacritized Quran text. (Word-level timing comes from the
            # separate /v1/force-align pass; this 2022 fine-tune lacks timestamp config.)
            # Run off the event loop: this is real, potentially multi-second CPU-bound
            # inference, and running it inline would block every other concurrent request to
            # this process, including /health, for the full duration.
            hf = await asyncio.to_thread(asr_pipe, tmp_path)
            attribution = current_asr_attribution()
            return TranscribeResponse(
                text=(hf.get("text") or "").strip(),
                language=req.language,
                duration=hf_duration,
                # Genuinely empty: this checkpoint has no timestamp config, so it emits no word
                # segments and per-word timing comes from /v1/force-align instead. Callers must not
                # read this as "nothing was recognised" — the recitation is in `text`, and
                # ml-inference's recognizedWordsFrom() is what knows to look there.
                words=[],
                modelVersion=attribution["components"][0]["implementationId"],
                modelAttribution=attribution,
                latencyMs=max(1, int((time.time() - start) * 1000)),
            )

        # Run Whisper transcription with word-level timestamps, off the event loop (see comment above).
        result = await asyncio.to_thread(
            whisper.transcribe,
            model,
            tmp_path,
            language=req.language,
            word_timestamps=req.wordTimestamps,
            verbose=False,
        )

        words = []
        if "segments" in result:
            for segment in result["segments"]:
                if "words" in segment:
                    for w in segment["words"]:
                        words.append(WordSegment(
                            word=w.get("word", "").strip(),
                            start=round(w.get("start", 0.0), 3),
                            end=round(w.get("end", 0.0), 3),
                            probability=round(w.get("probability", 0.0), 3),
                        ))

        latency_ms = max(1, int((time.time() - start) * 1000))

        attribution = current_asr_attribution()
        return TranscribeResponse(
            text=result.get("text", "").strip(),
            language=result.get("language", req.language),
            duration=round(result.get("segments", [{}])[-1].get("end", 0.0), 3) if result.get("segments") else 0.0,
            words=words,
            modelVersion=attribution["components"][0]["implementationId"],
            modelAttribution=attribution,
            latencyMs=latency_ms,
        )

    except HTTPException:
        raise
    except Exception:
        # Log the real error server-side; return a generic message so internal detail (tensor
        # shapes, ffmpeg command lines, temp paths) never crosses the trust boundary.
        logger.exception("transcription failed")
        raise HTTPException(status_code=500, detail="transcription failed")
    finally:
        os.unlink(tmp_path)


@app.post(
    "/v1/force-align",
    response_model=ForceAlignResponse,
    dependencies=[Depends(require_rate_limit), Depends(require_asr_key)],
)
async def force_align(req: ForceAlignRequest):
    """TRUE CTC forced alignment (T3): aligns the audio to `req.transcript`'s words and returns a
    per-word [start, end] in seconds + a confidence. Unlike the old Whisper-`initial_prompt` version
    (which only biased decoding and did NOT guarantee word correspondence), this uses
    `torchaudio.functional.forced_align` against an Apache-2.0 Arabic CTC model on the diacritic-
    stripped canonical characters — so word i of the response IS word i of the transcript. Validated
    to ~64ms word-start MAE vs Quran.com ground truth (see forced_align_arabic.py). The alignment
    model is separate from the ASR model and loads lazily on first call.
    """
    start = time.time()

    if not req.audioBase64:
        raise HTTPException(status_code=400, detail="audioBase64 is required")
    if not req.transcript:
        raise HTTPException(status_code=400, detail="transcript is required")

    words = req.transcript.split()
    if not words:
        raise HTTPException(status_code=400, detail="transcript has no words")

    audio_bytes = decode_audio_b64(req.audioBase64)
    suffix = safe_audio_suffix(req.audioFormat)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp_in:
        tmp_in.write(audio_bytes)
        in_path = tmp_in.name
    wav_path = in_path + ".16k.wav"

    try:
        # Reject over-long audio up front (metadata probe, no decode) so a decompression bomb never
        # reaches the single full-waveform CTC forward pass below.
        enforce_max_duration(in_path)

        # Decode/resample to 16kHz mono via ffmpeg (the aligner model's expected input), then align
        # off the event loop — CTC inference is CPU-bound and would otherwise block /health etc.
        def _run() -> tuple[list, float]:
            subprocess.run(
                # `-t` bounds the decode to just past the duration cap: even when the container
                # duration was unknown (ffprobe returned 0, so enforce_max_duration let it through),
                # ffmpeg cannot expand an arbitrarily long input into an unbounded waveform.
                ["ffmpeg", "-y", "-i", in_path, "-ar", "16000", "-ac", "1",
                 "-t", str(int(MAX_AUDIO_SECONDS) + 1), "-f", "wav", wav_path],
                check=True, capture_output=True,
            )
            data, sr = sf.read(wav_path, dtype="float32")
            # Backstop for the unknown-duration case: if the (now decode-bounded) audio is still over
            # the cap, the original was too long — reject rather than align a silently truncated clip.
            if len(data) / sr > MAX_AUDIO_SECONDS:
                raise HTTPException(status_code=413, detail=f"audio too long; max {int(MAX_AUDIO_SECONDS)}s")
            waveform = torch.from_numpy(data).unsqueeze(0)
            from forced_align import MODEL_ID, align_words

            spans = align_words(waveform, words)
            return spans, len(data) / sr, MODEL_ID

        spans, duration, model_id = await asyncio.to_thread(_run)

        aligned_words = [
            AlignedWord(word=words[i], start=round(s / 1000, 3), end=round(e / 1000, 3), score=sc)
            for i, (s, e, sc) in enumerate(spans)
        ]
        attribution = current_forced_aligner_attribution(model_id)
        return ForceAlignResponse(
            words=aligned_words,
            duration=round(duration, 3),
            modelVersion=attribution["components"][0]["implementationId"],
            modelAttribution=attribution,
            latencyMs=max(1, int((time.time() - start) * 1000)),
        )
    except HTTPException:
        raise
    except ValueError:
        # align_words raises ValueError when the transcript needs more CTC tokens than the audio has
        # emission frames (transcript longer than the audio supports) — a client input problem, 400.
        raise HTTPException(status_code=400, detail="transcript is longer than the audio supports")
    except ImportError:
        # 501, not 500. `forced_align._load` imports `transformers` lazily and the shipped image
        # deliberately does not install it (see Dockerfile) — so in that deployment this endpoint
        # CANNOT work, ever. A 500 says "the server broke, a retry may help" and sends an operator
        # looking for a fault; 501 says the capability is absent from this build, which is a
        # decision someone made and can reverse.
        logger.warning(
            "force alignment unavailable: the alignment model's dependencies are not installed "
            "in this image (see services/asr-inference/Dockerfile)"
        )
        raise HTTPException(
            status_code=501,
            detail="force alignment is not available in this deployment",
        )
    except Exception:
        logger.exception("force alignment failed")
        raise HTTPException(status_code=500, detail="force alignment failed")
    finally:
        for p in (in_path, wav_path):
            try:
                os.unlink(p)
            except OSError:
                pass


def _contains_confidence_claim(value) -> bool:
    if isinstance(value, list):
        return any(_contains_confidence_claim(item) for item in value)
    if not isinstance(value, dict):
        return False
    return "confidence" in value or any(
        _contains_confidence_claim(item) for item in value.values()
    )


def _acoustic_response(
    *,
    status: Literal["observed", "refused", "unavailable"],
    started_at: float,
    observations: list[dict] | None = None,
    refusal_reason: str | None = None,
) -> AcousticObservationResponse:
    model_attribution = None
    model_version = None
    if status == "observed":
        model_attribution = build_acoustic_attribution(ACOUSTIC_CANDIDATE)
        model_version = model_attribution["components"][0]["implementationId"]
    return AcousticObservationResponse(
        status=status,
        observations=observations or [],
        refusalReason=refusal_reason,
        candidateId=ACOUSTIC_CANDIDATE["id"],
        qpsProfileId=ACOUSTIC_CANDIDATE["qps"]["profileId"],
        qpsProfileChecksum=ACOUSTIC_CANDIDATE["qps"]["profileChecksum"],
        modelVersion=model_version,
        modelAttribution=model_attribution,
        latencyMs=max(1, int((time.time() - started_at) * 1000)),
    )


@app.post(
    "/v1/acoustic-tajweed:observe",
    response_model=AcousticObservationResponse,
    dependencies=[Depends(require_rate_limit), Depends(require_asr_key)],
)
async def observe_acoustic_tajweed(req: AcousticObservationRequest):
    """Run the exact pinned model in a restartable child and return shadow-only observations."""
    started_at = time.time()
    if not ACOUSTIC_SHADOW_ENABLED:
        return _acoustic_response(
            status="unavailable",
            started_at=started_at,
            refusal_reason="acoustic-shadow-disabled",
        )

    audio_bytes = decode_audio_b64(req.audioBase64)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        measured_duration = probe_duration_seconds(tmp_path)
        if measured_duration <= 0 or measured_duration > 15.0:
            return _acoustic_response(
                status="refused",
                started_at=started_at,
                refusal_reason="window-duration-limit",
            )
        request = req.model_dump()
        request.pop("audioBase64", None)
        request.pop("audioFormat", None)
        request["audioPath"] = tmp_path
        worker_response = await acoustic_worker.observe(request)
        status = worker_response.get("status")
        observations = worker_response.get("observations")
        refusal_reason = worker_response.get("refusalReason")
        if status == "observed":
            if (
                not isinstance(observations, list)
                or not observations
                or _contains_confidence_claim(observations)
            ):
                raise AcousticRefusal("invalid-acoustic-worker-response")
            return _acoustic_response(
                status="observed",
                started_at=started_at,
                observations=observations,
            )
        if (
            status not in ("refused", "unavailable")
            or observations != []
            or not isinstance(refusal_reason, str)
            or not refusal_reason
        ):
            raise AcousticRefusal("invalid-acoustic-worker-response")
        return _acoustic_response(
            status=status,
            started_at=started_at,
            refusal_reason=refusal_reason,
        )
    except AcousticRefusal as error:
        return _acoustic_response(
            status="refused",
            started_at=started_at,
            refusal_reason=error.reason,
        )
    except Exception:
        # Model exceptions may include local artifact/audio paths. Keep the external response stable.
        logger.error("acoustic shadow worker failed")
        return _acoustic_response(
            status="unavailable",
            started_at=started_at,
            refusal_reason="acoustic-worker-unavailable",
        )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    host = os.environ.get("ASR_HOST", "127.0.0.1")
    port = int(os.environ.get("ASR_PORT", "8091"))
    # uvicorn's OWN default (proxy_headers=True, forwarded_allow_ips="127.0.0.1") silently rewrites
    # request.client to whatever X-Forwarded-For claims whenever the connecting peer is loopback —
    # BEFORE require_rate_limit's TRUST_PROXY_HEADERS gate ever runs. That made the application-level
    # gate a no-op: verified empirically that 130 concurrent requests, each with a different spoofed
    # X-Forwarded-For, ALL passed the rate limiter even with TRUST_PROXY_HEADERS unset, because
    # request.client.host had already been substituted at the ASGI layer. Disabling uvicorn's own
    # proxy-header trust makes request.client.host always the genuine raw TCP peer, so this
    # application's own TRUST_PROXY_HEADERS check is the sole, correct authority (matching how the
    # Rust/Node services in this fleet already work — neither has an equivalent lower-layer override).
    uvicorn.run(app, host=host, port=port, proxy_headers=False)
