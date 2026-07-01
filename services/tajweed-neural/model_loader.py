"""
Loader for the neural tajweed model (obadx/muaalem-model-v3, Wav2Vec2BertForMultilevelCTC).

Runs in a DEDICATED venv (.venv312) with its own transformers/torch, completely isolated
from the Python 3.9 stack that asr-inference (tarteel Whisper) uses — so integrating this
cannot break the working ASR. The custom model class is vendored from the author's repo
(github.com/obadx/prepare-quran-dataset, MIT) under ./vendor and registered with the
transformers Auto* factories.

The model predicts, per phoneme, a set of tajweed "sifat" attributes (hams/jahr, tafkhim,
shidda, ghunnah, madd, qalqala, ...). Output is EXPERIMENTAL and must pass the platform's
human-review gate before it is ever shown to a learner.
"""

import os
import sys
import time

# Make ./vendor importable as a package (its modules use relative imports).
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import torch  # noqa: E402
import librosa  # noqa: E402
from transformers import AutoConfig, AutoModelForCTC, AutoFeatureExtractor  # noqa: E402

from vendor.configuration_multi_level_ctc import Wav2Vec2BertForMultilevelCTCConfig  # noqa: E402
from vendor.modeling_multi_level_ctc import Wav2Vec2BertForMultilevelCTC  # noqa: E402
from vendor.multi_level_tokenizer import MultiLevelTokenizer  # noqa: E402

MODEL_ID = os.environ.get("TAJWEED_NEURAL_MODEL", "obadx/muaalem-model-v3")

# Register the custom architecture so from_pretrained can resolve model_type "multi_level_ctc".
try:
    AutoConfig.register("multi_level_ctc", Wav2Vec2BertForMultilevelCTCConfig)
    AutoModelForCTC.register(Wav2Vec2BertForMultilevelCTCConfig, Wav2Vec2BertForMultilevelCTC)
except Exception:
    # Already registered (idempotent on re-import).
    pass


class NeuralTajweedModel:
    def __init__(self, model_id: str = MODEL_ID, device: str | None = None):
        self.model_id = model_id
        self.device = torch.device(
            device or ("mps" if torch.backends.mps.is_available() else "cpu")
        )
        # bf16 on MPS/CPU keeps the 605M model light; CTC argmax is robust to it.
        self.dtype = torch.float32
        self.model = Wav2Vec2BertForMultilevelCTC.from_pretrained(model_id)
        self.model.to(self.device, dtype=self.dtype)
        self.model.eval()
        self.processor = AutoFeatureExtractor.from_pretrained(model_id)
        self.tokenizer = MultiLevelTokenizer(model_id)

    @torch.inference_mode()
    def analyze(self, wav_path: str) -> dict:
        start = time.time()
        wave, _ = librosa.load(wav_path, sr=16000, mono=True)
        features = self.processor(wave, sampling_rate=16000, return_tensors="pt")
        features = {k: v.to(self.device, dtype=self.dtype) for k, v in features.items()}
        outs = self.model(**features, return_dict=False)[0]
        level_to_pred_ids = {k: torch.argmax(v, dim=-1) for k, v in outs.items()}
        decoded = self.tokenizer.decode(level_to_pred_ids, place_zeros_in_between=False)
        return {
            "modelId": self.model_id,
            "levels": {level: decoded[level] for level in decoded},
            "latencyMs": max(1, int((time.time() - start) * 1000)),
        }


if __name__ == "__main__":
    wav = sys.argv[1] if len(sys.argv) > 1 else None
    print(f"[loader] loading {MODEL_ID} ...", flush=True)
    m = NeuralTajweedModel()
    print(f"[loader] loaded on {m.device}. levels={m.tokenizer.levels}", flush=True)
    if wav:
        import json

        print(json.dumps(m.analyze(wav), ensure_ascii=False, indent=1))
