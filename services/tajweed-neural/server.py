"""
Neural Tajweed service — EXPERIMENTAL, human-review-gated.

Serves the obadx/muaalem-model-v3 (Wav2Vec2BertForMultilevelCTC) neural tajweed model in a
DEDICATED venv, fully isolated from the tarteel Whisper ASR (asr-inference, Python 3.9).
Given recitation audio it returns the model's per-phoneme tajweed "sifat" attributes
(hams/jahr, tafkhim/tarqiq, shidda/rakhawa, qalqala, ghunnah, madd, ...).

This output is EXPERIMENTAL: it is model prediction, not a scholar ruling. It flows through
the platform's existing human-review gate (teacher/scholar) before any learner sees it, and
is off by default — the learner path keeps using the reviewed rule-based tajweed until a
scholar validates this model on the pilot data.

Run (isolated venv):
  services/tajweed-neural/.venv312/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8093
  # or: services/tajweed-neural/.venv312/bin/python server.py
"""

import base64
import os
import tempfile
import time

from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from model_loader import NeuralTajweedModel, MODEL_ID

app = FastAPI(title="Quran AI Neural Tajweed (experimental)")

# API-key gate (mirrors asr-inference / ml-inference). This experimental service must never be
# reachable directly by the browser; a caller fronts it with the key server-side. Health stays open.
TAJWEED_NEURAL_API_KEY = os.environ.get("TAJWEED_NEURAL_API_KEY", "smoke-tajweed-neural-api-key")


def require_neural_key(x_neural_api_key: Optional[str] = Header(default=None)) -> None:
    if x_neural_api_key != TAJWEED_NEURAL_API_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")

# Whitelist of accepted audio container formats (mirrors the asr-inference service). The
# client-controlled audioFormat becomes a tempfile suffix; without this a value with a NUL byte
# ("wav\0") or path traversal ("../../x") makes tempfile.NamedTemporaryFile raise an unhandled 500.
ALLOWED_AUDIO_FORMATS = {"webm", "wav", "mp3", "m4a", "ogg", "flac"}


def safe_audio_suffix(audio_format: str) -> str:
    fmt = (audio_format or "").strip().lower()
    if fmt not in ALLOWED_AUDIO_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported audioFormat {audio_format!r}; allowed: {sorted(ALLOWED_AUDIO_FORMATS)}",
        )
    return f".{fmt}"


# ~20M base64 chars ≈ 15 MB of audio — matches the asr-inference cap so a single request cannot force
# an unbounded decode into memory + a large temp file.
MAX_AUDIO_B64_CHARS = 20_000_000


def decode_audio_b64(b64: str) -> bytes:
    """Validate and decode a base64 audio payload. Every failure is a client error (4xx) — empty,
    oversized, malformed, or empty-when-decoded must not fall through to a 500. Mirrors asr-inference."""
    if not b64 or not b64.strip():
        raise HTTPException(status_code=400, detail="audioBase64 is required")
    if len(b64) > MAX_AUDIO_B64_CHARS:
        raise HTTPException(status_code=413, detail="audioBase64 is too large")
    try:
        audio_bytes = base64.b64decode(b64, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base64 audio: {exc}")
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="audioBase64 decoded to empty audio")
    return audio_bytes


_model: NeuralTajweedModel | None = None
_model_load_error: str | None = None


def get_model() -> NeuralTajweedModel:
    """Lazily load the model. On failure, remember the error and re-raise; callers decide how to
    surface it (startup logs + degrades, requests return 503). A later call retries, so the service
    self-heals once the model becomes reachable."""
    global _model, _model_load_error
    if _model is None:
        try:
            _model = NeuralTajweedModel()
            _model_load_error = None
        except Exception as e:  # noqa: BLE001
            _model_load_error = str(e)
            raise
    return _model


def require_loaded_model() -> NeuralTajweedModel:
    """Return the model, or raise a clean 503 if it cannot be loaded — a 503 (unavailable) reads
    honestly as 'model not ready', vs a 500 that looks like a bug in request handling."""
    try:
        return get_model()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"neural tajweed model unavailable (load failed): {e}")


class AnalyzeRequest(BaseModel):
    audioBase64: str
    audioFormat: str = "wav"


class AnalyzeResponse(BaseModel):
    modelId: str
    experimental: bool
    reviewGate: str
    levels: dict
    latencyMs: int


@app.get("/health")
def health():
    return {
        "status": "ok" if _model_load_error is None else "degraded",
        "service": "tajweed-neural",
        "model": MODEL_ID,
        "loaded": _model is not None,
        "loadError": _model_load_error,
        "experimental": True,
    }


@app.post(
    "/v1/analyze-tajweed-neural",
    response_model=AnalyzeResponse,
    dependencies=[Depends(require_neural_key)],
)
def analyze_tajweed_neural(req: AnalyzeRequest):
    if not req.audioBase64:
        raise HTTPException(status_code=400, detail="audioBase64 is required")
    # Acquire the model before touching the request body: an unloaded model is a 503, not a 500.
    model = require_loaded_model()
    start = time.time()
    # Validate + decode the audio payload (empty / oversized / malformed / empty-decoded → 4xx).
    audio_bytes = decode_audio_b64(req.audioBase64)
    suffix = safe_audio_suffix(req.audioFormat)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    try:
        result = model.analyze(tmp_path)
        return AnalyzeResponse(
            modelId=result["modelId"],
            experimental=True,
            reviewGate="requires human review before learner display",
            levels=result["levels"],
            latencyMs=max(1, int((time.time() - start) * 1000)),
        )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Neural tajweed analysis failed: {e}")
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("TAJWEED_NEURAL_HOST", "127.0.0.1")
    port = int(os.environ.get("TAJWEED_NEURAL_PORT", "8093"))
    # Eagerly load so the first request isn't a cold start — but a load failure (Hub unreachable,
    # bad MODEL_ID / TAJWEED_NEURAL_MODEL) must NOT crash the process before it binds the port.
    # Degrade gracefully: log and start anyway. /health then reports loaded=false + the error, and
    # requests return a clean 503 (require_loaded_model), retrying the load until it succeeds.
    print(f"[tajweed-neural] loading {MODEL_ID} ...", flush=True)
    try:
        get_model()
        print(f"[tajweed-neural] ready on http://{host}:{port}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(
            f"[tajweed-neural] model load FAILED ({e}); starting DEGRADED — "
            f"/health loaded=false, requests return 503 until the model loads",
            flush=True,
        )
    uvicorn.run(app, host=host, port=port)
