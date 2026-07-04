/**
 * Server-side ASR using the trained Quran model in the asr-inference service
 * (tarteel-ai/whisper-base-ar-quran). This is the REAL recitation path: capture microphone audio,
 * decode + resample to 16 kHz mono WAV in the browser (universally decodable by the model), and POST
 * it to the platform API's ASR proxy (`/v1/asr/transcribe`).
 *
 * The browser talks to the platform API, NOT the ASR service directly: the ASR service now requires
 * an API key that must stay server-side, so the platform API authenticates the actor and forwards
 * the audio with the key. Preferred over the browser Web Speech API (generic ar-SA recognition)
 * because the fine-tuned checkpoint returns diacritized Quran text. Falls back to Web Speech
 * (lib/asr.ts) when a microphone/MediaRecorder is unavailable or the service is down.
 */

import type { AsrStatus } from "./asr";

const PLATFORM_API_BASE = import.meta.env.VITE_PLATFORM_API_URL || "http://127.0.0.1:8080";

/** Actor identity forwarded to the platform API so the ASR proxy can authenticate the caller. */
export interface AsrAuth {
  tenantId: string;
  userId: string;
  authToken?: string;
}

function asrAuthHeaders(auth?: AsrAuth): Record<string, string> {
  if (auth?.authToken) return { authorization: `Bearer ${auth.authToken}` };
  if (auth) return { "x-tenant-id": auth.tenantId, "x-user-id": auth.userId, "x-user-role": "learner" };
  return {};
}

export interface ServerAsrResult {
  transcript: string;
  confidence: number;
  /** The exact audio the learner recorded — kept so they can play it back. */
  audioBlob: Blob;
  /** Set when transcription failed (e.g. ASR service down). The recording is still playable. */
  error?: string;
}

export interface StartServerAsrOptions {
  language?: string;
  /** Actor identity so the platform-api ASR proxy can authenticate the transcription request. */
  auth?: AsrAuth;
  onStatusChange: (status: AsrStatus) => void;
  onError: (message: string) => void;
}

export interface ServerAsrController {
  /** Stop recording, transcribe via the Quran model, and resolve the transcript. */
  stopAndTranscribe: () => Promise<ServerAsrResult>;
  getStatus: () => AsrStatus;
}

export function isServerAsrSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined"
  );
}

export function isAudioRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

function pickRecorderMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "";
}

export async function startServerAsr(options: StartServerAsrOptions): Promise<ServerAsrController | null> {
  if (!isServerAsrSupported()) {
    options.onStatusChange("unsupported");
    return null;
  }

  return startRecordedAudio(options, async (recorded) => {
    const wav = await decodeToWav16kMono(recorded);
    const transcript = await transcribeWav(wav, options.language ?? "ar", options.auth);
    return { transcript, confidence: 0.9 };
  });
}

export async function startLocalAudioRecording(
  options: StartServerAsrOptions,
): Promise<ServerAsrController | null> {
  if (!isAudioRecordingSupported()) {
    options.onStatusChange("unsupported");
    return null;
  }

  return startRecordedAudio(options, async () => ({
    transcript: "",
    confidence: 0,
    error: "external-asr-consent-required",
  }));
}

async function startRecordedAudio(
  options: StartServerAsrOptions,
  processRecording: (recorded: Blob) => Promise<Omit<ServerAsrResult, "audioBlob">>,
): Promise<ServerAsrController | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    options.onStatusChange("error");
    options.onError("Microphone permission denied.");
    return null;
  }

  const mimeType = pickRecorderMime();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  });
  recorder.start();
  let status: AsrStatus = "listening";
  options.onStatusChange("listening");

  return {
    getStatus: () => status,
    stopAndTranscribe: async () => {
      status = "stopped";
      options.onStatusChange("stopped");
      const recorded: Blob = await new Promise((resolve) => {
        recorder.addEventListener(
          "stop",
          () => resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" })),
          { once: true },
        );
        recorder.stop();
      });
      stream.getTracks().forEach((track) => track.stop());

      // Always keep the recording playable, even if the ASR service is unreachable.
      try {
        const result = await processRecording(recorded);
        return { ...result, audioBlob: recorded };
      } catch (error) {
        return {
          transcript: "",
          confidence: 0,
          audioBlob: recorded,
          error: error instanceof Error ? error.message : "transcription failed",
        };
      }
    },
  };
}

/** Decode any recorded audio blob and re-encode as 16 kHz mono 16-bit PCM WAV. */
export async function decodeToWav16kMono(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await decodeCtx.close();
  }

  const targetRate = 16000;
  const frameCount = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, frameCount, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), targetRate);
}

/** Encode mono float32 PCM samples as a 16-bit WAV blob. Pure — unit-testable. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function transcribeWav(wav: Blob, language: string, auth?: AsrAuth): Promise<string> {
  const audioBase64 = await blobToBase64(wav);
  const response = await fetch(`${PLATFORM_API_BASE}/v1/asr/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json", ...asrAuthHeaders(auth) },
    body: JSON.stringify({ audioBase64, audioFormat: "wav", language, wordTimestamps: true }),
  });
  if (!response.ok) {
    throw new Error(`ASR service ${response.status}`);
  }
  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}
