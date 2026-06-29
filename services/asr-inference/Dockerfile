FROM python:3.11-slim-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y curl ffmpeg && rm -rf /var/lib/apt/lists/*
COPY services/asr-inference/pyproject.toml ./
RUN pip install --no-cache-dir fastapi uvicorn openai-whisper torchaudio soundfile
COPY services/asr-inference/server.py ./
EXPOSE 8091
CMD ["python", "server.py"]
