"""Fail-closed ASR readiness state, independent of model/runtime dependencies.

The controller owns one background worker. Model loading and the known-audio probe never run on
the ASGI event loop, and readiness requests only read a cached immutable snapshot. The synthetic
zero-signal WAV proves that the selected inference path executes; it is not evaluation audio and
its output must never be reported as transcription quality evidence.
"""

from __future__ import annotations

import io
import re
import threading
import time
import wave
from dataclasses import dataclass
from typing import Callable


_SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
_TERMINAL_REASONS = {
    "model-digest-missing",
    "model-digest-mismatch",
    "model-digest-unresolved",
}


def known_audio_wav_bytes() -> bytes:
    """Return the declared 100 ms, 16 kHz, mono PCM zero-signal readiness fixture."""
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(b"\x00" * 3_200)
    return output.getvalue()


@dataclass(frozen=True)
class ReadinessSnapshot:
    ready: bool
    phase: str
    reason: str | None
    model_id: str
    artifact_digest: str | None
    probe_duration_ms: int | None
    attempt: int


class AsrReadinessController:
    """Load, validate, and probe one selected ASR model without overlapping workers."""

    def __init__(
        self,
        *,
        model_id: str,
        expected_digest: str | None,
        load_and_resolve: Callable[[], str],
        probe: Callable[[], None],
        probe_timeout_seconds: float,
        retry_seconds: float,
    ) -> None:
        if probe_timeout_seconds <= 0:
            raise ValueError("probe_timeout_seconds must be positive")
        if retry_seconds <= 0:
            raise ValueError("retry_seconds must be positive")
        self._model_id = model_id
        self._expected_digest = expected_digest
        self._load_and_resolve = load_and_resolve
        self._probe = probe
        self._probe_timeout_seconds = probe_timeout_seconds
        self._retry_seconds = retry_seconds
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None
        self._snapshot = ReadinessSnapshot(
            ready=False,
            phase="idle",
            reason="model-not-started",
            model_id=model_id,
            artifact_digest=None,
            probe_duration_ms=None,
            attempt=0,
        )

    def snapshot(self) -> ReadinessSnapshot:
        with self._lock:
            return self._snapshot

    def start(self) -> bool:
        """Start the sole worker; return False when one is active or readiness is final."""
        with self._lock:
            if (
                self._snapshot.ready
                or self._snapshot.reason in _TERMINAL_REASONS
                or (self._worker is not None and self._worker.is_alive())
            ):
                return False
            self._stop.clear()
            self._worker = threading.Thread(
                target=self._run,
                name="asr-readiness",
                daemon=True,
            )
            self._worker.start()
            return True

    def stop(self, timeout_seconds: float = 1.0) -> None:
        self._stop.set()
        with self._lock:
            worker = self._worker
        if worker is not None and worker is not threading.current_thread():
            worker.join(max(0.0, timeout_seconds))

    def _publish(
        self,
        *,
        ready: bool,
        phase: str,
        reason: str | None,
        artifact_digest: str | None,
        probe_duration_ms: int | None,
        attempt: int,
    ) -> None:
        with self._lock:
            self._snapshot = ReadinessSnapshot(
                ready=ready,
                phase=phase,
                reason=reason,
                model_id=self._model_id,
                artifact_digest=artifact_digest,
                probe_duration_ms=probe_duration_ms,
                attempt=attempt,
            )

    def _fail(
        self,
        reason: str,
        *,
        artifact_digest: str | None,
        probe_duration_ms: int | None,
        attempt: int,
    ) -> bool:
        self._publish(
            ready=False,
            phase="failed",
            reason=reason,
            artifact_digest=artifact_digest,
            probe_duration_ms=probe_duration_ms,
            attempt=attempt,
        )
        return self._stop.wait(self._retry_seconds)

    def _run_probe(self, attempt: int, artifact_digest: str) -> str | None:
        errors: list[BaseException] = []

        def execute() -> None:
            try:
                self._probe()
            except BaseException as exc:  # noqa: BLE001 - fail closed for any probe failure
                errors.append(exc)

        self._publish(
            ready=False,
            phase="probing",
            reason="known-audio-probe-running",
            artifact_digest=artifact_digest,
            probe_duration_ms=None,
            attempt=attempt,
        )
        started = time.monotonic()
        probe_worker = threading.Thread(
            target=execute,
            name="asr-known-audio-probe",
            daemon=True,
        )
        probe_worker.start()
        probe_worker.join(self._probe_timeout_seconds)
        elapsed_ms = max(0, round((time.monotonic() - started) * 1_000))

        if probe_worker.is_alive():
            self._publish(
                ready=False,
                phase="failed",
                reason="known-audio-probe-timeout",
                artifact_digest=artifact_digest,
                probe_duration_ms=elapsed_ms,
                attempt=attempt,
            )
            # Do not launch a replacement while the timed-out inference still owns model resources.
            while probe_worker.is_alive() and not self._stop.wait(0.05):
                probe_worker.join(0.05)
            return "known-audio-probe-timeout"

        if errors:
            self._publish(
                ready=False,
                phase="failed",
                reason="known-audio-probe-failed",
                artifact_digest=artifact_digest,
                probe_duration_ms=elapsed_ms,
                attempt=attempt,
            )
            return "known-audio-probe-failed"

        self._publish(
            ready=True,
            phase="ready",
            reason=None,
            artifact_digest=artifact_digest,
            probe_duration_ms=elapsed_ms,
            attempt=attempt,
        )
        return None

    def _run(self) -> None:
        attempt = 0
        while not self._stop.is_set():
            attempt += 1
            self._publish(
                ready=False,
                phase="loading",
                reason="model-loading",
                artifact_digest=None,
                probe_duration_ms=None,
                attempt=attempt,
            )
            try:
                artifact_digest = self._load_and_resolve()
            except BaseException:  # noqa: BLE001 - model failures must degrade, never kill liveness
                if self._fail(
                    "model-load-failed",
                    artifact_digest=None,
                    probe_duration_ms=None,
                    attempt=attempt,
                ):
                    return
                continue

            if not isinstance(artifact_digest, str) or not _SHA256.fullmatch(artifact_digest):
                reason = "model-digest-unresolved"
            elif self._expected_digest is None or not _SHA256.fullmatch(self._expected_digest):
                reason = "model-digest-missing"
            elif artifact_digest != self._expected_digest:
                reason = "model-digest-mismatch"
            else:
                reason = None

            if reason is not None:
                self._publish(
                    ready=False,
                    phase="failed",
                    reason=reason,
                    artifact_digest=artifact_digest,
                    probe_duration_ms=None,
                    attempt=attempt,
                )
                return

            probe_failure = self._run_probe(attempt, artifact_digest)
            if probe_failure is None or self._stop.is_set():
                return
            if self._stop.wait(self._retry_seconds):
                return
