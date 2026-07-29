"""Model-free audio input guards for the ASR service.

Deliberately imports NOTHING from torch / whisper / transformers, so it is unit-testable with a
plain interpreter (see test_audio_guards.py) and importing it never loads a model. Keeps the DoS /
duration checks in one place used by every audio endpoint.
"""
import subprocess

from fastapi import HTTPException

# Max accepted audio duration (seconds). The base64 size cap (MAX_AUDIO_B64_CHARS) only bounds the
# COMPRESSED payload — a small, highly-compressed clip (e.g. ~12 kbps Opus in 15 MB) can decode to
# HOURS of PCM. force-align then runs a single CTC forward pass over the ENTIRE waveform, so an
# unbounded duration is an out-of-memory / worker-thread-pin denial of service that the per-request
# rate limiter (which counts requests, not work) does not stop. A recitation practice clip is
# seconds-to-a-minute; 120s is generous headroom.
MAX_AUDIO_SECONDS = 120.0


def probe_duration_seconds(path: str) -> float:
    """Container duration in seconds via ffprobe — reads stream/format metadata only, WITHOUT a full
    decode, so it is cheap and safe to run before the expensive decode/inference. Returns 0.0 when
    the duration cannot be determined (unknown/streamed container, ffprobe missing); callers treat
    0.0 as "unknown, don't reject here" and rely on the decode-time backstop instead.
    """
    try:
        out = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return 0.0


def enforce_max_duration(path: str) -> None:
    """Reject audio longer than MAX_AUDIO_SECONDS with 413 BEFORE any decode/inference. A duration of
    0.0 (unknown) is allowed through — the force-align path additionally bounds ffmpeg decoding with
    `-t` so an unknown-duration bomb still cannot expand without limit."""
    duration = probe_duration_seconds(path)
    if duration > MAX_AUDIO_SECONDS:
        raise HTTPException(
            status_code=413,
            detail=f"audio too long ({duration:.0f}s); max {int(MAX_AUDIO_SECONDS)}s",
        )
