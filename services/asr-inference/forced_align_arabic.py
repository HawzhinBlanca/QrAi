#!/usr/bin/env python3
"""Production-path forced alignment for T3 — Apache-2.0 Arabic CTC model, no romanization.

Same alignment math as forced_align_poc.py, but with `jonatasgrosman/wav2vec2-large-xlsr-53-arabic`
(license: apache-2.0 — SHIPPABLE, unlike MMS_FA's CC-BY-NC). The model's vocab is Arabic letters, so
we align on the diacritic-stripped canonical text directly (its vocab has no harakat). Validated the
same way: word-start error vs Quran.com's ground-truth segments.

Eval deps: pip install transformers soundfile (torch/torchaudio already present).
Run: KMP_DUPLICATE_LIB_OK=TRUE .venv/bin/python forced_align_arabic.py
"""
import json
import re
import subprocess
import tempfile
import urllib.request

import soundfile as sf
import torch
import torchaudio.functional as F
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

REPO = "/Users/hawzhin/QrAi"
AUDIO_BASE = "https://verses.quran.com/"
MODEL_ID = "jonatasgrosman/wav2vec2-large-xlsr-53-arabic"

# Arabic combining marks (harakat/tanwin/tatweel/quranic annotation) absent from the model vocab.
DIACRITICS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ﻿]")


def strip_diacritics(s: str) -> str:
    s = DIACRITICS.sub("", s)
    return s.replace("ٱ", "ا")  # alef-wasla -> alef


def load_audio_16k_mono(url: str) -> torch.Tensor:
    raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "qrai"}), timeout=30).read()
    with tempfile.NamedTemporaryFile(suffix=".mp3") as mp3, tempfile.NamedTemporaryFile(suffix=".wav") as wav:
        mp3.write(raw)
        mp3.flush()
        subprocess.run(["ffmpeg", "-y", "-i", mp3.name, "-ar", "16000", "-ac", "1", "-f", "wav", wav.name],
                       check=True, capture_output=True)
        data, sr = sf.read(wav.name, dtype="float32")
    assert sr == 16000
    return torch.from_numpy(data).unsqueeze(0)


_MODEL = None
_VOCAB = None


def _model():
    global _MODEL, _VOCAB
    if _MODEL is None:
        proc = Wav2Vec2Processor.from_pretrained(MODEL_ID)
        _MODEL = Wav2Vec2ForCTC.from_pretrained(MODEL_ID).eval()
        _VOCAB = proc.tokenizer.get_vocab()
    return _MODEL, _VOCAB


def align_words(waveform: torch.Tensor, arabic_words: list[str]) -> list[tuple[int, int]]:
    model, vocab = _model()
    blank = vocab["<pad>"]

    tokens: list[int] = []
    spans_per_word: list[tuple[int, int]] = []
    for w in arabic_words:
        start = len(tokens)
        for ch in strip_diacritics(w):
            if ch in vocab:
                tokens.append(vocab[ch])
        end = len(tokens)
        if end == start:  # nothing alignable — occupy one <unk> slot so the word still gets a span
            tokens.append(vocab.get("<unk>", blank))
            end = len(tokens)
        spans_per_word.append((start, end))

    with torch.inference_mode():
        logits = model(waveform).logits  # [1, T, V]
    emission = torch.log_softmax(logits, dim=-1)
    targets = torch.tensor([tokens], dtype=torch.int32)
    aligned, scores = F.forced_align(emission, targets, blank=blank)
    token_spans = F.merge_tokens(aligned[0], scores[0])

    ratio = waveform.size(1) / emission.size(1) / 16000.0
    out = []
    for (a, b) in spans_per_word:
        spans = token_spans[a:b]
        out.append((int(spans[0].start * ratio * 1000), int(spans[-1].end * ratio * 1000)))
    return out


def main():
    truth = json.load(open(f"{REPO}/packages/quran-data/src/data/word-timings/alafasy/surah-001.json"))
    canonical = json.load(open(f"{REPO}/packages/quran-data/src/data/full-quran/surah-001.json"))

    total_err = total_words = 0
    print(f"{'wordId':<10} {'ours(ms)':<16} {'truth(ms)':<16} {'Δstart':>7} {'Δend':>6}")
    for ayah_truth in truth["ayahs"][:3]:
        n = ayah_truth["ayah"]
        words = [a for a in canonical["ayahs"] if a["ayahNumber"] == n][0]["words"]
        ours = align_words(load_audio_16k_mono(AUDIO_BASE + ayah_truth["audioUrl"]), words)
        truth_by = {w["wordId"]: (w["startMs"], w["endMs"]) for w in ayah_truth["words"]}
        for i, (s, e) in enumerate(ours, start=1):
            wid = f"1:{n}:{i}"
            if wid not in truth_by:
                continue
            ts, te = truth_by[wid]
            total_err += abs(s - ts)
            total_words += 1
            print(f"{wid:<10} {f'{s}-{e}':<16} {f'{ts}-{te}':<16} {s-ts:>7} {e-te:>6}")

    mae = total_err / max(total_words, 1)
    print(f"\n[Apache-2.0 {MODEL_ID}] mean abs word-start error vs ground truth: {mae:.0f} ms / {total_words} words")
    print("VERDICT:", "PASS (shippable aligner is correct)" if mae < 400 else "REVIEW")


if __name__ == "__main__":
    main()
