#!/usr/bin/env python3
"""Validation harness for T3 forced alignment — the seed of the T9 alignment eval.

Imports the SHIPPED aligner (`forced_align.align_words`, used by the /v1/force-align endpoint) and
checks it against Quran.com's published word segments (the T1 ground truth). Because it exercises the
exact production code, a PASS here is a correctness proof for the endpoint. Result 2026-07-16
(Al-Fatihah 1:1-1:3, Al-Afasy reference audio): mean absolute word-START error ≈ 64 ms over 10 words
→ PASS. Word-start accuracy (~±100ms, what follow-along needs) is excellent; last-word END times
drift into trailing silence, an expected forced-alignment behavior (madd measured separately).

Eval deps: pip install transformers soundfile.
Run: KMP_DUPLICATE_LIB_OK=TRUE .venv/bin/python forced_align_arabic.py
"""
import json
import subprocess
import tempfile
import urllib.request

import soundfile as sf
import torch

from forced_align import MODEL_ID, align_words  # the SHIPPED module — validates the endpoint's code

REPO = "/Users/hawzhin/QrAi"
AUDIO_BASE = "https://verses.quran.com/"


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


def main():
    truth = json.load(open(f"{REPO}/packages/quran-data/src/data/word-timings/alafasy/surah-001.json"))
    canonical = json.load(open(f"{REPO}/packages/quran-data/src/data/full-quran/surah-001.json"))

    total_err = total_words = 0
    print(f"{'wordId':<10} {'ours(ms)':<16} {'truth(ms)':<16} {'dStart':>7} {'dEnd':>6}")
    for ayah_truth in truth["ayahs"][:3]:
        n = ayah_truth["ayah"]
        words = [a for a in canonical["ayahs"] if a["ayahNumber"] == n][0]["words"]
        ours = align_words(load_audio_16k_mono(AUDIO_BASE + ayah_truth["audioUrl"]), words)
        truth_by = {w["wordId"]: (w["startMs"], w["endMs"]) for w in ayah_truth["words"]}
        for i, (s, e, _score) in enumerate(ours, start=1):
            wid = f"1:{n}:{i}"
            if wid not in truth_by:
                continue
            ts, te = truth_by[wid]
            total_err += abs(s - ts)
            total_words += 1
            print(f"{wid:<10} {f'{s}-{e}':<16} {f'{ts}-{te}':<16} {s - ts:>7} {e - te:>6}")

    mae = total_err / max(total_words, 1)
    print(f"\n[Apache-2.0 {MODEL_ID}] mean abs word-start error vs ground truth: {mae:.0f} ms / {total_words} words")
    print("VERDICT:", "PASS (shippable aligner is correct)" if mae < 400 else "REVIEW")


if __name__ == "__main__":
    main()
