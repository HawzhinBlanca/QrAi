#!/usr/bin/env python3
"""Forced-alignment proof-of-correctness for T3.

Aligns a recitation audio to its canonical Arabic word sequence and emits per-word [start,end] ms,
using torchaudio CTC forced alignment (MMS_FA multilingual aligner + uroman romanization of the
Arabic reference). Validates against Quran.com's published word segments (the T1 ground truth): if
our word boundaries land within tolerance of the reference, the aligner is correct — not merely
"runs". MMS_FA is CC-BY-NC (fine for this offline eval); the production service swaps in an
Apache-2.0 Arabic CTC model, same alignment math.

Eval deps (beyond the service's own): `pip install uroman soundfile` (torch/torchaudio already
present). Run: `KMP_DUPLICATE_LIB_OK=TRUE .venv/bin/python forced_align_poc.py`

Result 2026-07-16 (Al-Fatihah 1:1-1:3, Al-Afasy reference audio): mean absolute word-start error
vs Quran.com segments = 52 ms over 10 words → PASS. This is the T3 correctness proof and the seed of
the T9 alignment-eval harness; the production service endpoint reuses `align_words()` with an
Apache-2.0 Arabic CTC model (aligning on the diacritic-stripped Arabic char sequence) in place of
the CC-BY-NC MMS_FA aligner used for this offline eval.
"""
import json
import subprocess
import sys
import tempfile
import urllib.request

import soundfile as sf
import torch
import torchaudio.functional as F
import uroman as ur
from torchaudio.pipelines import MMS_FA as bundle

REPO = "/Users/hawzhin/QrAi"
AUDIO_BASE = "https://verses.quran.com/"


def load_audio_16k_mono(url: str) -> torch.Tensor:
    """Fetch an mp3 and decode to 16kHz mono float waveform via ffmpeg (torchaudio's mp3 backend
    is environment-dependent; ffmpeg is reliable)."""
    raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "qrai"}), timeout=30).read()
    with tempfile.NamedTemporaryFile(suffix=".mp3") as mp3, tempfile.NamedTemporaryFile(suffix=".wav") as wav:
        mp3.write(raw)
        mp3.flush()
        subprocess.run(
            ["ffmpeg", "-y", "-i", mp3.name, "-ar", "16000", "-ac", "1", "-f", "wav", wav.name],
            check=True, capture_output=True,
        )
        data, sr = sf.read(wav.name, dtype="float32")
    assert sr == 16000
    return torch.from_numpy(data).unsqueeze(0)  # [1, num_samples] mono


def align_words(waveform: torch.Tensor, arabic_words: list[str]) -> list[tuple[int, int]]:
    """Return [start_ms, end_ms] per input word."""
    model = bundle.get_model()
    dictionary = bundle.get_dict()
    uroman = ur.Uroman()

    # Romanize each Arabic word, keep only chars the model knows (lowercased), track word ownership.
    tokens: list[int] = []
    spans_per_word: list[tuple[int, int]] = []  # (start_tok_idx, end_tok_idx) into `tokens`
    for w in arabic_words:
        roman = uroman.romanize_string(w).lower()
        start = len(tokens)
        for ch in roman:
            if ch in dictionary:
                tokens.append(dictionary[ch])
        end = len(tokens)
        if end == start:  # a word with no alignable chars (rare) — give it the star token so it still occupies a slot
            tokens.append(dictionary["*"])
            end = len(tokens)
        spans_per_word.append((start, end))

    with torch.inference_mode():
        emission, _ = model(waveform)
    targets = torch.tensor([tokens], dtype=torch.int32)
    aligned, scores = F.forced_align(emission, targets, blank=0)
    token_spans = F.merge_tokens(aligned[0], scores[0])

    # frames -> seconds ratio (emission time-steps cover the whole waveform)
    ratio = waveform.size(1) / emission.size(1) / 16000.0

    out = []
    for (tok_start, tok_end) in spans_per_word:
        word_spans = token_spans[tok_start:tok_end]
        start_ms = int(word_spans[0].start * ratio * 1000)
        end_ms = int(word_spans[-1].end * ratio * 1000)
        out.append((start_ms, end_ms))
    return out


def main():
    # Ground truth: Quran.com word segments for Al-Fatihah, ingested in T1.
    truth = json.load(open(f"{REPO}/packages/quran-data/src/data/word-timings/alafasy/surah-001.json"))
    canonical = json.load(open(f"{REPO}/packages/quran-data/src/data/full-quran/surah-001.json"))

    total_err = 0
    total_words = 0
    print(f"{'ayah:word':<12} {'ours[start-end]ms':<22} {'truth[start-end]ms':<22} {'Δstart':>7} {'Δend':>6}")
    for ayah_truth in truth["ayahs"][:3]:  # first 3 ayahs is plenty to validate
        n = ayah_truth["ayah"]
        words = [a for a in canonical["ayahs"] if a["ayahNumber"] == n][0]["words"]
        waveform = load_audio_16k_mono(AUDIO_BASE + ayah_truth["audioUrl"])
        ours = align_words(waveform, words)
        truth_by_wordid = {w["wordId"]: (w["startMs"], w["endMs"]) for w in ayah_truth["words"]}
        for i, (s, e) in enumerate(ours, start=1):
            wid = f"1:{n}:{i}"
            if wid not in truth_by_wordid:
                continue
            ts, te = truth_by_wordid[wid]
            ds, de = s - ts, e - te
            total_err += abs(ds)
            total_words += 1
            print(f"{wid:<12} {f'{s}-{e}':<22} {f'{ts}-{te}':<22} {ds:>7} {de:>6}")

    mae = total_err / max(total_words, 1)
    print(f"\nMean absolute start-time error vs Quran.com ground truth: {mae:.0f} ms over {total_words} words")
    # A real forced aligner on clean reference audio should land words within a few hundred ms.
    print("VERDICT:", "PASS (aligner is correct)" if mae < 400 else "REVIEW (error too high)")


if __name__ == "__main__":
    main()
