"""
Quran AI ASR Inference Service

Real acoustic speech recognition using OpenAI Whisper.
Accepts audio bytes → returns recognized Arabic text + word-level timestamps.

This is NOT a text-processing demo. Whisper processes actual audio waveforms
through a neural transformer model trained on 680K hours of multilingual audio.
Arabic is one of Whisper's supported languages, and it produces word-level
timestamps via cross-attention alignment.

Endpoints:
  GET  /health                — service health + model info
  POST /v1/transcribe         — transcribe audio bytes → text + word timestamps
  POST /v1/force-align        — force align audio + canonical text → word timestamps
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
from typing import Optional

import torch
import torchaudio
import torchaudio.functional as F
import soundfile as sf
import numpy as np
import whisper
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from audio_guards import MAX_AUDIO_SECONDS, enforce_max_duration

# API-key gate. The browser must NOT reach this service directly — it is fronted by the platform-api
# /v1/asr/* proxy, which holds ASR_API_KEY server-side (like ML_API_KEY for ml-inference). ml-inference
# also sends the key on its server-to-server transcribe call. Health stays open. In dev/CI the default
# key is used on both sides; in production ASR_API_KEY is set (platform-api boot-refuses a weak value).
ASR_API_KEY = os.environ.get("ASR_API_KEY", "smoke-asr-api-key")


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

# Cap the number of word-timestamp entries a single /v1/analyze-tajweed request can carry. Each
# entry drives real signal processing (pitch detection, an STFT, energy computations) on this,
# "the compute-heaviest service in the fleet" per the rate-limiter comment below — the per-IP
# rate limit counts requests, not work-per-request, so an unbounded `words` array lets one request
# pin the process for as long as the caller likes. 2000 is generous headroom over any real
# recitation session (the longest surah, Al-Baqarah, is ~6000 words split across many sessions;
# a single practice request realistically carries well under a few hundred).
MAX_TAJWEED_WORDS = 2000


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


def _load_model() -> None:
    """Load the ASR model into the module globals. Never raises — a failure is recorded in
    _load_error so the service degrades (503) instead of failing to start."""
    global asr_pipe, model, DEVICE_STR, _load_error
    try:
        if _USE_HF:
            from transformers import pipeline as hf_pipeline

            DEVICE_STR = (
                "mps"
                if torch.backends.mps.is_available()
                else ("cuda" if torch.cuda.is_available() else "cpu")
            )
            logger.info("Loading HF Quran ASR model: %s on %s", ASR_MODEL, DEVICE_STR)
            asr_pipe = hf_pipeline(
                "automatic-speech-recognition", model=ASR_MODEL, device=DEVICE_STR
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


_load_model()

app = FastAPI(title="Quran AI ASR Inference", version="0.1.0")

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
    """503 until the ASR model is loaded, so a degraded start returns a clean error, not a 500."""
    if asr_pipe is None and model is None:
        raise HTTPException(
            status_code=503,
            detail=f"ASR model not loaded: {_load_error or 'still loading'}",
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


class TranscribeResponse(BaseModel):
    text: str
    language: str
    duration: float  # seconds
    words: list[WordSegment]
    modelVersion: str
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
    latencyMs: int


class TajweedAnalysisRequest(BaseModel):
    audioBase64: str
    audioFormat: str = "webm"
    words: list[dict]  # [{word, start, end}] from force alignment


class TajweedWordFinding(BaseModel):
    word: str
    start: float
    end: float
    rule: str
    severity: str  # "practice" | "warning" | "critical"
    explanation: str
    confidence: float


class TajweedAnalysisResponse(BaseModel):
    findings: list[TajweedWordFinding]
    modelVersion: str
    latencyMs: int


# === Endpoints ===

@app.get("/health")
async def health():
    loaded = asr_pipe is not None or model is not None
    return {
        # Liveness stays true (the process is up and serving); `loaded` is the readiness signal.
        "ok": True,
        "service": "quran-ai-asr-inference",
        "model": MODEL_NAME,
        "device": DEVICE_STR,
        "loaded": loaded,
        "loadError": _load_error,
        "supportedLanguages": ["ar", "en", "tr", "ur", "id", "ms", "fr", "de"],
    }


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
            # HF Quran ASR — this checkpoint is fine-tuned for Arabic Quran, so a plain
            # call returns diacritized Quran text. (Word-level timing comes from the
            # separate /v1/force-align pass; this 2022 fine-tune lacks timestamp config.)
            # Run off the event loop: this is real, potentially multi-second CPU-bound
            # inference, and running it inline would block every other concurrent request to
            # this process, including /health, for the full duration.
            hf = await asyncio.to_thread(asr_pipe, tmp_path)
            return TranscribeResponse(
                text=(hf.get("text") or "").strip(),
                language=req.language,
                duration=0.0,
                words=[],
                modelVersion=MODEL_NAME,
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

        return TranscribeResponse(
            text=result.get("text", "").strip(),
            language=result.get("language", req.language),
            duration=round(result.get("segments", [{}])[-1].get("end", 0.0), 3) if result.get("segments") else 0.0,
            words=words,
            modelVersion=f"whisper-{MODEL_NAME}",
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
            from forced_align import align_words

            spans = align_words(waveform, words)
            return spans, len(data) / sr

        spans, duration = await asyncio.to_thread(_run)

        aligned_words = [
            AlignedWord(word=words[i], start=round(s / 1000, 3), end=round(e / 1000, 3), score=sc)
            for i, (s, e, sc) in enumerate(spans)
        ]
        return ForceAlignResponse(
            words=aligned_words,
            duration=round(duration, 3),
            modelVersion=f"ctc-forced-align:{os.environ.get('FORCE_ALIGN_MODEL', 'wav2vec2-xlsr-53-arabic')}",
            latencyMs=max(1, int((time.time() - start) * 1000)),
        )
    except HTTPException:
        raise
    except ValueError:
        # align_words raises ValueError when the transcript needs more CTC tokens than the audio has
        # emission frames (transcript longer than the audio supports) — a client input problem, 400.
        raise HTTPException(status_code=400, detail="transcript is longer than the audio supports")
    except Exception:
        logger.exception("force alignment failed")
        raise HTTPException(status_code=500, detail="force alignment failed")
    finally:
        for p in (in_path, wav_path):
            try:
                os.unlink(p)
            except OSError:
                pass


def _analyze_tajweed_words_sync(tmp_path: str, words: list[dict]) -> list["TajweedWordFinding"]:
    """The actual CPU-bound signal processing for /v1/analyze-tajweed (audio load, then per-word
    pitch detection / STFT / RMS energy). Run via asyncio.to_thread from the async handler below --
    this is real, potentially multi-second CPU work (autocorrelation + FFT per word), and running it
    directly on the asyncio event loop would block every other concurrent request to this process,
    including /health, for the full duration."""
    # Load audio with soundfile (real waveform processing)
    audio_data, sample_rate = sf.read(tmp_path, dtype="float32")
    # Convert to mono if stereo
    if len(audio_data.shape) > 1:
        audio_data = audio_data.mean(axis=1)
    waveform = torch.from_numpy(audio_data).unsqueeze(0)  # [1, samples]

    findings = []

    for word_info in words:
        word_text = word_info.get("word", "")
        word_start = float(word_info.get("start", 0.0))
        word_end = float(word_info.get("end", 0.0))

        if word_end <= word_start:
            continue

        # Extract word segment from audio
        start_sample = int(word_start * sample_rate)
        end_sample = int(word_end * sample_rate)
        word_segment = waveform[0, start_sample:end_sample]

        if word_segment.shape[0] < 100:
            continue  # too short to analyze

        # === Real audio feature extraction ===

        # 1. Duration check (madd should be ~2 vowel lengths)
        word_duration = word_end - word_start

        # 2. Pitch (F0) using autocorrelation
        if word_segment.shape[0] > 512:
            # Compute F0 using torchaudio's functional
            try:
                f0 = F.detect_pitch_frequency(
                    word_segment.unsqueeze(0),
                    sample_rate=sample_rate,
                    frame_time=0.01,
                    freq_low=80,
                    freq_high=400,
                )
                f0_mean = float(f0[f0 > 0].mean()) if (f0 > 0).any() else 0.0
                f0_std = float(f0[f0 > 0].std()) if (f0 > 0).any() else 0.0
            except Exception:
                f0_mean = 0.0
                f0_std = 0.0
        else:
            f0_mean = 0.0
            f0_std = 0.0

        # 3. Energy (RMS)
        try:
            energy = float(torch.sqrt(torch.mean(word_segment ** 2)))
        except Exception:
            energy = 0.0

        # 4. Spectral centroid (brightness indicator)
        if word_segment.shape[0] > 256:
            try:
                window = torch.hann_window(512)
                spec = torch.stft(word_segment, n_fft=512, hop_length=256, window=window, return_complex=True)
                magnitudes = spec.abs()
                freqs = torch.fft.fftfreq(512, 1.0 / sample_rate)[:256]
                if magnitudes.shape[1] > 0:
                    centroid = float((freqs.unsqueeze(1) * magnitudes[:256]).sum() / max(magnitudes[:256].sum(), 1e-8))
                else:
                    centroid = 0.0
            except Exception:
                centroid = 0.0
        else:
            centroid = 0.0

        # === Tajweed rule detection from audio features ===

        # Check for madd letters (ا و ي) — duration should be elongated
        madd_letters = ["ا", "و", "ي", "ى"]
        has_madd = any(letter in word_text for letter in madd_letters)

        if has_madd and word_duration > 0.4:
            # Madd detected: word is elongated
            severity = "practice"
            confidence = min(0.95, 0.6 + word_duration * 0.5)
            findings.append(TajweedWordFinding(
                word=word_text,
                start=word_start,
                end=word_end,
                rule="madd-tabii",
                severity=severity,
                explanation=f"Natural elongation detected. Duration: {word_duration:.2f}s, F0: {f0_mean:.0f}Hz. Hold for two counts.",
                confidence=round(confidence, 3),
            ))

        # Check for ghunnah (nasalization) — high F0 variance + energy on a SILENT noon/meem.
        # Ghunnah applies to noon/meem-sakin, tanween, or a mushaddad (doubled) noon/meem — NOT a
        # voweled (moving) noon/meem. Gating on a bare "ن"/"م" in any context flagged words like
        # نُور (noon + damma), telling the learner to nasalize a moving noon that carries no
        # ghunnah — a false tajweed instruction. Mirror the reference text rules in
        # ml-inference/tajweed.js (noon-sakin / word-final noon / tanween) and extend to
        # meem-sakin and shadda'd noon/meem. The patterns assume the canonical
        # consonant+shadda+vowel diacritic ordering used by packages/quran-data.
        has_ghunnah = (
            re.search("[نم][ّْ]", word_text) is not None  # noon/meem + sukoon or shadda
            or re.search("[ًٌٍ]", word_text) is not None       # tanween
            or re.search("ن$", word_text) is not None                    # word-final noon (sakin at waqf)
        )

        if has_ghunnah and f0_std > 10:
            severity = "practice"
            confidence = min(0.92, 0.55 + f0_std * 0.01)
            findings.append(TajweedWordFinding(
                word=word_text,
                start=word_start,
                end=word_end,
                rule="ghunnah",
                severity=severity,
                explanation=f"Nasalization detected. F0 variance: {f0_std:.1f}Hz, Energy: {energy:.4f}. Hold nasal sound for two counts.",
                confidence=round(confidence, 3),
            ))

        # Check for qalqalah (echo) — sharp energy burst on ق ط ب ج د
        qalqalah_letters = ["ق", "ط", "ب", "ج", "د"]
        has_qalqalah = any(letter in word_text for letter in qalqalah_letters)

        if has_qalqalah and energy > 0.05:
            # Check for sharp energy change (bounce)
            if word_segment.shape[0] > 100:
                mid = word_segment.shape[0] // 2
                first_half_energy = float(torch.sqrt(torch.mean(word_segment[:mid] ** 2)))
                second_half_energy = float(torch.sqrt(torch.mean(word_segment[mid:] ** 2)))
                if abs(second_half_energy - first_half_energy) > 0.02:
                    severity = "practice"
                    confidence = min(0.90, 0.5 + energy * 2)
                    findings.append(TajweedWordFinding(
                        word=word_text,
                        start=word_start,
                        end=word_end,
                        rule="qalqalah",
                        severity=severity,
                        explanation=f"Echo bounce detected. Energy: {energy:.4f}, Centroid: {centroid:.0f}Hz. Pronounce with slight bounce.",
                        confidence=round(confidence, 3),
                    ))

        # Check for tafkhim (heavy) — low spectral centroid on خ ص ض ط ظ ق
        tafkhim_letters = ["خ", "ص", "ض", "ط", "ظ", "ق"]
        has_tafkhim = any(letter in word_text for letter in tafkhim_letters)

        if has_tafkhim and centroid > 0 and centroid < 2000:
            severity = "practice"
            confidence = min(0.88, 0.5 + (2000 - centroid) * 0.0002)
            findings.append(TajweedWordFinding(
                word=word_text,
                start=word_start,
                end=word_end,
                rule="tafkhim",
                severity=severity,
                explanation=f"Heavy pronunciation. Spectral centroid: {centroid:.0f}Hz (low = heavy). Raise back of tongue.",
                confidence=round(confidence, 3),
            ))

    return findings


@app.post(
    "/v1/analyze-tajweed",
    response_model=TajweedAnalysisResponse,
    dependencies=[Depends(require_rate_limit), Depends(require_asr_key), Depends(require_loaded_model)],
)
async def analyze_tajweed(req: TajweedAnalysisRequest):
    """
    Analyze audio for tajweed features using real signal processing.
    Extracts per-word audio segments using force alignment timestamps,
    then measures duration, pitch (F0), and energy to detect tajweed issues.
    """
    start = time.time()

    if not req.audioBase64:
        raise HTTPException(status_code=400, detail="audioBase64 is required")
    if not req.words:
        raise HTTPException(status_code=400, detail="words (with timestamps) are required")
    if len(req.words) > MAX_TAJWEED_WORDS:
        raise HTTPException(status_code=413, detail=f"words exceeds the {MAX_TAJWEED_WORDS}-entry limit")

    audio_bytes = decode_audio_b64(req.audioBase64)
    suffix = safe_audio_suffix(req.audioFormat)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        findings = await asyncio.to_thread(_analyze_tajweed_words_sync, tmp_path, req.words)
        latency_ms = max(1, int((time.time() - start) * 1000))
        return TajweedAnalysisResponse(
            findings=findings,
            modelVersion=f"audio-tajweed-v0.1",
            latencyMs=latency_ms,
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("tajweed analysis failed")
        raise HTTPException(status_code=500, detail="tajweed analysis failed")
    finally:
        os.unlink(tmp_path)


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
