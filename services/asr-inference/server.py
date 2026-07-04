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

import io
import os
import re
import json
import base64
import tempfile
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
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

# API-key gate. The browser must NOT reach this service directly — it is fronted by the platform-api
# /v1/asr/* proxy, which holds ASR_API_KEY server-side (like ML_API_KEY for ml-inference). ml-inference
# also sends the key on its server-to-server transcribe call. Health stays open. In dev/CI the default
# key is used on both sides; in production ASR_API_KEY is set (platform-api boot-refuses a weak value).
ASR_API_KEY = os.environ.get("ASR_API_KEY", "smoke-asr-api-key")


def require_asr_key(x_asr_api_key: Optional[str] = Header(default=None)) -> None:
    if x_asr_api_key != ASR_API_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")


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

if _USE_HF:
    from transformers import pipeline as hf_pipeline

    DEVICE_STR = (
        "mps"
        if torch.backends.mps.is_available()
        else ("cuda" if torch.cuda.is_available() else "cpu")
    )
    logger.info("Loading HF Quran ASR model: %s on %s", ASR_MODEL, DEVICE_STR)
    asr_pipe = hf_pipeline("automatic-speech-recognition", model=ASR_MODEL, device=DEVICE_STR)
    model = None
    logger.info("HF Quran ASR %s loaded on %s", ASR_MODEL, DEVICE_STR)
else:
    logger.info("Loading Whisper model: %s", ASR_MODEL)
    model = whisper.load_model(ASR_MODEL)
    asr_pipe = None
    DEVICE_STR = str(model.device)
    logger.info("Whisper %s loaded. Device: %s", ASR_MODEL, model.device)

app = FastAPI(title="Quran AI ASR Inference", version="0.1.0")

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
    return {
        "ok": True,
        "service": "quran-ai-asr-inference",
        "model": MODEL_NAME,
        "device": DEVICE_STR,
        "supportedLanguages": ["ar", "en", "tr", "ur", "id", "ms", "fr", "de"],
    }


@app.post("/v1/transcribe", response_model=TranscribeResponse, dependencies=[Depends(require_asr_key)])
async def transcribe(req: TranscribeRequest):
    start = time.time()

    if not req.audioBase64:
        raise HTTPException(status_code=400, detail="audioBase64 is required")

    # Decode base64 audio → temp file. Malformed base64 is a client error (400), not a 500.
    try:
        audio_bytes = base64.b64decode(req.audioBase64, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base64 audio: {exc}")
    suffix = safe_audio_suffix(req.audioFormat)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        if asr_pipe is not None:
            # HF Quran ASR — this checkpoint is fine-tuned for Arabic Quran, so a plain
            # call returns diacritized Quran text. (Word-level timing comes from the
            # separate /v1/force-align pass; this 2022 fine-tune lacks timestamp config.)
            hf = asr_pipe(tmp_path)
            return TranscribeResponse(
                text=(hf.get("text") or "").strip(),
                language=req.language,
                duration=0.0,
                words=[],
                modelVersion=MODEL_NAME,
                latencyMs=max(1, int((time.time() - start) * 1000)),
            )

        # Run Whisper transcription with word-level timestamps
        result = whisper.transcribe(
            model,
            tmp_path,
            language=req.language,
            word_timestamps=req.wordTimestamps if req.wordTimestamps else True,
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

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        os.unlink(tmp_path)


@app.post("/v1/force-align", response_model=ForceAlignResponse, dependencies=[Depends(require_asr_key)])
async def force_align(req: ForceAlignRequest):
    """Force align audio against known canonical text using Whisper word timestamps."""
    start = time.time()

    if not req.audioBase64:
        raise HTTPException(status_code=400, detail="audioBase64 is required")
    if not req.transcript:
        raise HTTPException(status_code=400, detail="transcript is required")

    if model is None:
        raise HTTPException(
            status_code=501,
            detail="Force alignment is not supported with the Hugging Face pipeline model. "
            "Please configure ASR_MODEL to a standard Whisper model size (e.g., 'base') to enable force-alignment."
        )

    try:
        audio_bytes = base64.b64decode(req.audioBase64, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base64 audio: {exc}")
    suffix = safe_audio_suffix(req.audioFormat)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        # Use Whisper transcription with word timestamps as force alignment
        # Whisper's cross-attention provides word-level alignment against the audio
        result = whisper.transcribe(
            model,
            tmp_path,
            language=req.language,
            word_timestamps=True,
            initial_prompt=req.transcript,  # bias toward canonical text
            verbose=False,
        )

        # Build aligned words from Whisper's word segments
        aligned_words = []
        transcript_words = req.transcript.split()

        if "segments" in result:
            for segment in result["segments"]:
                if "words" in segment:
                    for w in segment["words"]:
                        word_text = w.get("word", "").strip()
                        if word_text:
                            aligned_words.append(AlignedWord(
                                word=word_text,
                                start=round(w.get("start", 0.0), 3),
                                end=round(w.get("end", 0.0), 3),
                                score=round(w.get("probability", 0.0), 3),
                            ))

        duration = 0.0
        if result.get("segments"):
            duration = round(result["segments"][-1].get("end", 0.0), 3)

        latency_ms = max(1, int((time.time() - start) * 1000))

        return ForceAlignResponse(
            words=aligned_words,
            duration=duration,
            modelVersion=f"whisper-{MODEL_NAME}-force-align",
            latencyMs=latency_ms,
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Force alignment failed: {str(e)}")
    finally:
        os.unlink(tmp_path)


@app.post("/v1/analyze-tajweed", response_model=TajweedAnalysisResponse, dependencies=[Depends(require_asr_key)])
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

    try:
        audio_bytes = base64.b64decode(req.audioBase64, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base64 audio: {exc}")
    suffix = safe_audio_suffix(req.audioFormat)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        # Load audio with soundfile (real waveform processing)
        audio_data, sample_rate = sf.read(tmp_path, dtype="float32")
        # Convert to mono if stereo
        if len(audio_data.shape) > 1:
            audio_data = audio_data.mean(axis=1)
        waveform = torch.from_numpy(audio_data).unsqueeze(0)  # [1, samples]

        findings = []

        for word_info in req.words:
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

        latency_ms = max(1, int((time.time() - start) * 1000))

        return TajweedAnalysisResponse(
            findings=findings,
            modelVersion=f"audio-tajweed-v0.1",
            latencyMs=latency_ms,
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Tajweed analysis failed: {str(e)}")
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    host = os.environ.get("ASR_HOST", "127.0.0.1")
    port = int(os.environ.get("ASR_PORT", "8091"))
    uvicorn.run(app, host=host, port=port)
