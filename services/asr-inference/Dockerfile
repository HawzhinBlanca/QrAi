FROM python:3.11-slim-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y curl ffmpeg && rm -rf /var/lib/apt/lists/*
COPY services/asr-inference/pyproject.toml ./
RUN pip install --no-cache-dir fastapi uvicorn openai-whisper torchaudio soundfile
# Pre-download the Whisper model during build so it's cached in the image layer.
# This eliminates cold-start delays when the container first handles a transcription.
RUN python -c "import whisper; whisper.load_model('base')"
COPY services/asr-inference/server.py ./
EXPOSE 8091
CMD ["python", "server.py"]
