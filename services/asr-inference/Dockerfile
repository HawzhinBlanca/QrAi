FROM python:3.11-slim-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y curl ffmpeg && rm -rf /var/lib/apt/lists/*
COPY services/asr-inference/pyproject.toml services/asr-inference/requirements.lock.txt ./
# Install from the pinned lock file (37 packages, pip-audit clean) rather than the loose
# fastapi/uvicorn/openai-whisper/torchaudio/soundfile names — a bare `pip install <names>`
# with no version pins meant every image rebuild could silently resolve to different
# transitive dependency versions with no changelog awareness, unlike the Rust/Node services'
# Cargo.lock/pnpm-lock.yaml. See requirements.lock.txt's header for how to regenerate it.
RUN pip install --no-cache-dir -r requirements.lock.txt
# Run as a non-root user. Create it first, then pre-download the Whisper model AS that user so it is
# cached under the user's own home (~/.cache/whisper) and is readable at runtime — if we downloaded
# as root it would land in /root/.cache (0700) and the non-root runtime would re-download or fail.
# Transcription writes only to /tmp (world-writable), so no other chown is needed.
RUN useradd --system --uid 10001 --create-home appuser && chown appuser /app
USER appuser
# Pre-download the Whisper model during build so it's cached in the image layer (no cold-start).
# This warms the generic openai-whisper 'base' model — the model this image actually runs
# (ASR_MODEL=base is set in docker-compose.yml). `transformers` is deliberately NOT installed
# above, so the specialized HF model (tarteel-ai/whisper-base-ar-quran, server.py's own default)
# cannot load in this image; see the ASR_MODEL comment in docker-compose.yml for why, and what's
# needed to switch.
RUN python -c "import whisper; whisper.load_model('base')"
# Copy every runtime module (not just server.py): server.py imports audio_guards at module load, and
# imports forced_align lazily for /v1/force-align — omitting either breaks boot or the endpoint. The
# test module is intentionally left out of the image.
COPY --chown=appuser:appuser services/asr-inference/server.py services/asr-inference/forced_align.py services/asr-inference/audio_guards.py ./
EXPOSE 8091
CMD ["python", "server.py"]
