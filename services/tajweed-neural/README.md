# Neural Tajweed Service (experimental)

Serves the **obadx/muaalem-model-v3** neural tajweed model
(`Wav2Vec2BertForMultilevelCTC`, 605M params, arXiv:2509.00094) which predicts per-phoneme
tajweed *sifat* attributes (hams/jahr, tafkhīm/tarqīq, shidda/rakhāwa, qalqala, ghunnah,
madd, ṣafīr, itbāq, istitāla, tafashshī, tikrār) directly from recitation audio.

## Isolation & safety

- Runs in a **dedicated venv** (`.venv312`, Python 3.12, its own torch/transformers) that is
  completely separate from the Python 3.9 stack used by `asr-inference` (tarteel Whisper) —
  so this cannot break the working ASR.
- Output is **EXPERIMENTAL model prediction, not a scholar ruling**. It carries a
  `reviewGate` flag and must pass the platform's human-review gate before any learner sees
  it. The learner path keeps using the reviewed rule-based tajweed until a scholar validates
  this model on the pilot data.

## Setup & run

```bash
cd services/tajweed-neural
python3.12 -m venv .venv312
.venv312/bin/pip install -r requirements.txt          # or requirements.lock.txt for exact
.venv312/bin/python server.py                          # loads the model, serves on :8093
```

## Endpoints

- `GET /health` → `{status, model, loaded, experimental}`
- `POST /v1/analyze-tajweed-neural` `{audioBase64, audioFormat}` →
  `{modelId, experimental, reviewGate, levels, latencyMs}` where `levels` maps each sifat
  attribute to its decoded per-phoneme sequence.

Env: `TAJWEED_NEURAL_MODEL` (default `obadx/muaalem-model-v3`), `TAJWEED_NEURAL_PORT` (8093).

## Vendored code

`vendor/` contains the model class vendored (unmodified, MIT) from
github.com/obadx/prepare-quran-dataset so it loads under a standard transformers release.
See `vendor/NOTICE.md`.

## Next step (not yet done)

Pronunciation-error detection: compare the model's predicted sifat against the reference
phonetization (`quran_transcript.quran_phonetizer`) of the canonical ayah, align, and emit
`{rule, severity, explanation}` findings. Requires scholar validation before it drives
learner-facing feedback.
