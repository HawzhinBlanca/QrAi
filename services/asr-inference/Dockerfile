FROM python:3.11-slim-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y curl ffmpeg && rm -rf /var/lib/apt/lists/*
COPY services/asr-inference/pyproject.toml ./
RUN pip install --no-cache-dir fastapi uvicorn openai-whisper torchaudio soundfile
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
COPY --chown=appuser:appuser services/asr-inference/server.py ./
EXPOSE 8091
CMD ["python", "server.py"]
