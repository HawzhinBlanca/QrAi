FROM python:3.11-slim-bookworm AS runtime-base
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
EXPOSE 8091
CMD ["python", "server.py"]

# Copy every runtime module (not just server.py): server.py imports audio_guards at module load, and
# imports forced_align lazily for /v1/force-align — omitting either breaks boot or the endpoint. The
# test module is intentionally left out of the image.
FROM runtime-base AS runtime
COPY --chown=appuser:appuser services/asr-inference/server.py services/asr-inference/forced_align.py services/asr-inference/audio_guards.py services/asr-inference/model_attribution.py services/asr-inference/readiness.py services/asr-inference/candidate_evidence.py services/asr-inference/calibration_registry.py services/asr-inference/acoustic_tajweed.py services/asr-inference/model-candidates.json services/asr-inference/acoustic-candidates.json services/asr-inference/calibrator-registry.json ./

# Optional, deliberately large shadow-evaluation image. The normal Compose/runtime target does
# not include Muaalem or its 2.4 GB model. Every source/model byte below is bound to the reviewed
# acoustic candidate manifest; BuildKit refuses the build if a remote object changes.
FROM runtime-base AS acoustic-candidate
USER root
COPY services/asr-inference/requirements.acoustic.lock.txt ./
COPY services/asr-inference/ACOUSTIC_THIRD_PARTY_NOTICES.txt /opt/qrai/licenses/ACOUSTIC_THIRD_PARTY_NOTICES.txt
RUN pip install --no-cache-dir --no-deps -r requirements.acoustic.lock.txt \
    && mkdir -p /opt/qrai/muaalem-v3_2 \
    && chown appuser:appuser /opt/qrai/muaalem-v3_2
USER appuser
COPY --chown=appuser:appuser services/asr-inference/server.py services/asr-inference/forced_align.py services/asr-inference/audio_guards.py services/asr-inference/model_attribution.py services/asr-inference/readiness.py services/asr-inference/candidate_evidence.py services/asr-inference/calibration_registry.py services/asr-inference/acoustic_tajweed.py services/asr-inference/model-candidates.json services/asr-inference/acoustic-candidates.json services/asr-inference/calibrator-registry.json ./
ADD --chown=appuser:appuser --checksum=sha256:8ac65705686105b31937d2fa8c15f3d7143ead07fb46380ec28042aa4f25e2ee https://huggingface.co/obadx/muaalem-model-v3_2/resolve/01a1ef9fbe40d144ef845101e89ff924aed3fef5/added_tokens.json /opt/qrai/muaalem-v3_2/added_tokens.json
ADD --chown=appuser:appuser --checksum=sha256:2094c962ca4a167304d8a2c6d2ca429060cbb6c817de09904739ab088bbcf16f https://huggingface.co/obadx/muaalem-model-v3_2/resolve/01a1ef9fbe40d144ef845101e89ff924aed3fef5/config.json /opt/qrai/muaalem-v3_2/config.json
ADD --chown=appuser:appuser --checksum=sha256:6b6a2e85303d17ff0f3af5e1fc79ac83daecee409c756ddf27f0ced59393bb41 https://huggingface.co/obadx/muaalem-model-v3_2/resolve/01a1ef9fbe40d144ef845101e89ff924aed3fef5/model.safetensors /opt/qrai/muaalem-v3_2/model.safetensors
ADD --chown=appuser:appuser --checksum=sha256:8e6281aad64f97e40534135a59dcc5d33571efae376f2a25adf5551951897ab4 https://huggingface.co/obadx/muaalem-model-v3_2/resolve/01a1ef9fbe40d144ef845101e89ff924aed3fef5/preprocessor_config.json /opt/qrai/muaalem-v3_2/preprocessor_config.json
ADD --chown=appuser:appuser --checksum=sha256:e9f51460cefd9c0211c0f0f346682595d02936f05b2ebd409d9fc05c78e481d5 https://huggingface.co/obadx/muaalem-model-v3_2/resolve/01a1ef9fbe40d144ef845101e89ff924aed3fef5/special_tokens_map.json /opt/qrai/muaalem-v3_2/special_tokens_map.json
ADD --chown=appuser:appuser --checksum=sha256:c778e27e2430b6743c5501b7e045ed2928257e7ac430442c3772df6d7ec74e82 https://huggingface.co/obadx/muaalem-model-v3_2/resolve/01a1ef9fbe40d144ef845101e89ff924aed3fef5/tokenizer_config.json /opt/qrai/muaalem-v3_2/tokenizer_config.json
ADD --chown=appuser:appuser --checksum=sha256:dcbdac0162632df023002ca1cdd48e74f0f77a328d7f69503f9ff021afb19473 https://huggingface.co/obadx/muaalem-model-v3_2/resolve/01a1ef9fbe40d144ef845101e89ff924aed3fef5/vocab.json /opt/qrai/muaalem-v3_2/vocab.json
ENV ACOUSTIC_SHADOW_ENABLED=1 \
    ACOUSTIC_MODEL_PATH=/opt/qrai/muaalem-v3_2 \
    ACOUSTIC_DEVICE=cpu \
    ACOUSTIC_DTYPE=float32 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1
RUN python -c "from acoustic_tajweed import load_shadow_candidate, verify_model_artifact; import quran_muaalem, quran_transcript; verify_model_artifact('/opt/qrai/muaalem-v3_2', load_shadow_candidate())"

# Keep the ordinary ASR image as the Dockerfile default. Candidate builds must opt in explicitly:
# docker build --target acoustic-candidate -f services/asr-inference/Dockerfile .
FROM runtime AS default
