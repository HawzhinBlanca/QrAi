"""Model-free tests for audio_guards — runnable with a plain interpreter (no torch/whisper/model).

    python test_audio_guards.py
"""
import os
import subprocess
import tempfile

from fastapi import HTTPException

import audio_guards
from audio_guards import MAX_AUDIO_SECONDS, enforce_max_duration, probe_duration_seconds


def _make_wav(seconds: float, path: str) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
         "-ar", "16000", "-ac", "1", path],
        check=True, capture_output=True,
    )


def test_probe_reads_real_duration():
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "t.wav")
        _make_wav(2.0, wav)
        dur = probe_duration_seconds(wav)
        assert 1.8 <= dur <= 2.2, dur


def test_probe_unknown_returns_zero():
    with tempfile.TemporaryDirectory() as d:
        txt = os.path.join(d, "not-audio.txt")
        with open(txt, "w") as f:
            f.write("this is not audio")
        assert probe_duration_seconds(txt) == 0.0
        assert probe_duration_seconds(os.path.join(d, "does-not-exist")) == 0.0


def test_enforce_rejects_over_cap(monkeypatch_value):
    # Duration just over the cap -> 413.
    audio_guards.probe_duration_seconds = lambda _p: MAX_AUDIO_SECONDS + 1
    try:
        enforce_max_duration("ignored")
        raise AssertionError("expected HTTPException")
    except HTTPException as e:
        assert e.status_code == 413
    finally:
        audio_guards.probe_duration_seconds = monkeypatch_value


def test_enforce_allows_within_cap_and_unknown(monkeypatch_value):
    for d in (1.0, MAX_AUDIO_SECONDS, 0.0):  # within cap, exactly cap, and unknown all pass
        audio_guards.probe_duration_seconds = lambda _p, _d=d: _d
        try:
            enforce_max_duration("ignored")  # must not raise
        finally:
            audio_guards.probe_duration_seconds = monkeypatch_value


if __name__ == "__main__":
    _orig = probe_duration_seconds
    test_probe_reads_real_duration()
    test_probe_unknown_returns_zero()
    test_enforce_rejects_over_cap(_orig)
    test_enforce_allows_within_cap_and_unknown(_orig)
    print("audio_guards: all checks passed")
