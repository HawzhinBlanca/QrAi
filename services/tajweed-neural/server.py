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

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from model_loader import NeuralTajweedModel, MODEL_ID

app = FastAPI(title="Quran AI Neural Tajweed (experimental)")

_model: NeuralTajweedModel | None = None


def get_model() -> NeuralTajweedModel:
    global _model
    if _model is None:
        _model = NeuralTajweedModel()
    return _model


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
        "status": "ok",
        "service": "tajweed-neural",
        "model": MODEL_ID,
        "loaded": _model is not None,
        "experimental": True,
    }


@app.post("/v1/analyze-tajweed-neural", response_model=AnalyzeResponse)
def analyze_tajweed_neural(req: AnalyzeRequest):
    if not req.audioBase64:
        raise HTTPException(status_code=400, detail="audioBase64 is required")
    start = time.time()
    audio_bytes = base64.b64decode(req.audioBase64)
    suffix = f".{req.audioFormat}"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    try:
        result = get_model().analyze(tmp_path)
        return AnalyzeResponse(
            modelId=result["modelId"],
            experimental=True,
            reviewGate="requires human review before learner display",
            levels=result["levels"],
            latencyMs=max(1, int((time.time() - start) * 1000)),
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Neural tajweed analysis failed: {e}")
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("TAJWEED_NEURAL_HOST", "127.0.0.1")
    port = int(os.environ.get("TAJWEED_NEURAL_PORT", "8093"))
    # Eagerly load so the first request isn't a cold start.
    print(f"[tajweed-neural] loading {MODEL_ID} ...", flush=True)
    get_model()
    print(f"[tajweed-neural] ready on http://{host}:{port}", flush=True)
    uvicorn.run(app, host=host, port=port)
