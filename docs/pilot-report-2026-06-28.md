# Quran AI — Pilot Report

> **Historical and superseded.** The 2026-06-28 F0/duration table was an infrastructure smoke, not
> validated Tajweed error detection. Its hand-authored confidence values and former heuristic route
> are retired. Current release truth is ADR-0047/0048: deterministic rules are instruction only,
> Muaalem v3.2 is private uncalibrated shadow evaluation, and learner acoustic findings remain empty.

## Pilot: Hikmah Erbil Pilot (hikmah-pilot-erbil)

**Date:** 2026-06-28
**Status:** Infrastructure Ready — Pending Real Learner Pilot

## Infrastructure Metrics

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Surahs available | 114 | 114 | ✅ |
| Ayahs available | 6,236 | 6,236 | ✅ |
| Words available | 82,456 | 82,456 | ✅ |
| Platform API routes | 17 | 10+ | ✅ |
| Realtime gateway p95 | <150ms | <150ms | ✅ |
| RLS tenant isolation | 13 tables | 13 tables | ✅ |
| Live Postgres RLS proof | PASS | PASS | ✅ |
| Audio pipeline E2E | PASS (16000 bytes) | PASS | ✅ |
| ASR (Whisper) | PASS (Arabic transcription) | PASS | ✅ |
| Force alignment | PASS (word timestamps) | PASS | ✅ |
| Historical audio-feature smoke | PASS (5 heuristic rows) | Plumbing only | ⚠️ not accuracy evidence |

## ASR Performance (Whisper base model)

| Audio | Duration | ASR Latency | Words | Accuracy |
|-------|----------|-------------|-------|----------|
| Al-Fatihah 1:1 | 4.3s | 1.6s | 4/4 | 100% |
| Al-Fatihah 1:1 (force-align) | 4.3s | 0.9s | 4/4 | 100% |

## Historical Tajweed Feature Smoke (Not Error Detection)

| Word | Rule | F0 (Hz) | Duration (s) | Confidence |
|------|------|---------|-------------|------------|
| بِسْمِ | ghunnah | 15.1 var | 0.56 | 0.701 |
| اللَّهِ | madd-tabii | 160 | 0.80 | 0.950 |
| الرَّحْمَٰنِ | madd-tabii | 150 | 1.18 | 0.950 |
| الرَّحِيمِ | madd-tabii | 138 | 1.72 | 0.950 |
| الرَّحِيمِ | ghunnah | 15.8 var | 1.72 | 0.708 |

## Architecture

- **Web:** React 19, Vite 8, Tailwind CSS 4
- **API:** Rust/Axum, SQLx, Postgres 16
- **Gateway:** Rust/Tokio, WebSocket, HMAC-SHA256 tickets
- **ML:** Node.js, Quran-constrained Levenshtein alignment
- **ASR:** Python/FastAPI, OpenAI Whisper (base), torchaudio
- **Mobile:** React Native / Expo
- **Infra:** Docker Compose (6 services)

## Known Gaps (Honest)

1. **ASR model size:** Using Whisper `base` (139MB). Production needs `medium` (1.5GB) or fine-tuned model.
2. **Tajweed error detection:** Currently detects tajweed features (madd, ghunnah, qalqalah) but doesn't compare against reference reciter audio. Error detection requires labeled training data.
3. **No production auth provider:** JWT + dev headers. Needs OAuth2/OIDC.
4. **No object storage:** Audio stored on local filesystem. Needs MinIO/S3.
5. **No NATS event bus:** Audit events in memory. Needs JetStream.
6. **Docker images untested:** Dockerfiles written but not built/run.
7. **Mobile app untested:** Code complete but not compiled/run on device.
8. **Pilot with real learners:** Not started. Infrastructure is ready.

## Recommendation

The historical infrastructure slice completed its Al-Fatihah smoke, but it did **not** prove
audio-based Tajweed error detection or production readiness. A real pilot may begin only after
consent/privacy approval, scholar-approved recitation configuration, calibrated acoustic evidence,
and a preregistered held-out evaluation against qualified teacher adjudication.
