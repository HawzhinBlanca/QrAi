"""Word-level forced alignment for T3 — the module the /v1/force-align endpoint and the eval share.

Given a 16kHz mono waveform and the canonical Arabic words, returns per-word [start_ms, end_ms] via
torchaudio CTC forced alignment against an Apache-2.0 Arabic model (aligning on the diacritic-
stripped Arabic char sequence — the model's vocab is Arabic letters, so no romanization). Validated
by forced_align_arabic.py against Quran.com ground truth (~64ms word-start MAE).

The model loads lazily on first alignment (≈1.2GB), so importing this module — or running the ASR
service without ever calling /v1/force-align — costs nothing. Override the checkpoint with
FORCE_ALIGN_MODEL (must remain a permissively-licensed Arabic CTC model).
"""
import os
import re

import torch
import torchaudio.functional as F

MODEL_ID = os.environ.get("FORCE_ALIGN_MODEL", "jonatasgrosman/wav2vec2-large-xlsr-53-arabic")

# Arabic combining marks (harakat/tanwin/tatweel/quranic annotation) absent from the model vocab.
_DIACRITICS = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ﻿]")

_model = None
_vocab = None


def _load():
    global _model, _vocab
    if _model is None:
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

        proc = Wav2Vec2Processor.from_pretrained(MODEL_ID)
        _model = Wav2Vec2ForCTC.from_pretrained(MODEL_ID).eval()
        _vocab = proc.tokenizer.get_vocab()
    return _model, _vocab


def _strip_diacritics(s: str) -> str:
    return _DIACRITICS.sub("", s).replace("ٱ", "ا")  # alef-wasla -> alef


def align_words(waveform: torch.Tensor, arabic_words: list[str]) -> list[tuple[int, int, float]]:
    """Return (start_ms, end_ms, score) per input word; score is the mean alignment probability of
    that word's characters. `waveform` is [1, samples] at 16kHz."""
    model, vocab = _load()
    blank = vocab["<pad>"]

    tokens: list[int] = []
    spans_per_word: list[tuple[int, int]] = []
    for w in arabic_words:
        start = len(tokens)
        for ch in _strip_diacritics(w):
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
        score = sum(s.score for s in spans) / len(spans)
        out.append((int(spans[0].start * ratio * 1000), int(spans[-1].end * ratio * 1000), round(float(score), 3)))
    return out
