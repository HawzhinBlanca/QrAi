import type { WordAlignment } from "../types/platform";

export type MicCaptureStatus = "idle" | "requesting-permission" | "recording" | "stopped" | "denied" | "unsupported" | "error";

export interface BrowserAudioChunk {
  id: string;
  sessionId: string;
  sequence: number;
  startMs: number;
  endMs: number;
  sampleRate: 16000 | 24000 | 48000;
  sizeBytes: number;
  mimeType: string;
  emittedAt: string;
  blob?: Blob;
}

export interface LiveAlignmentEvent {
  id: string;
  chunkId: string;
  eventSubject: "recitation.alignment.partial";
  latencyMs: number;
  alignments: WordAlignment[];
}

export type GatewayUploadStatus = "idle" | "connecting" | "connected" | "unavailable" | "error" | "closed";

export interface GatewayAudioAck {
  kind: "audio.ack";
  session_id: string;
  chunk_id: string;
  sequence: number;
  accepted: boolean;
  message: string;
}

export interface GatewayUploader {
  sendChunk: (chunk: BrowserAudioChunk) => boolean;
  close: () => void;
}

export interface GatewayUploadEnvironment {
  WebSocket?: typeof WebSocket;
}

export interface StartGatewayUploadOptions {
  url: string;
  onStatusChange: (status: GatewayUploadStatus) => void;
  onAck: (ack: GatewayAudioAck) => void;
  onError: (message: string) => void;
}

export interface MicCaptureController {
  stop: () => void;
  stream: MediaStream;
}

export interface BrowserMicEnvironment {
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  MediaRecorder?: typeof MediaRecorder;
  now?: () => number;
}

export interface StartMicCaptureOptions {
  sessionId: string;
  sampleRate: 16000 | 24000 | 48000;
  chunkDurationMs: number;
  onChunk: (chunk: BrowserAudioChunk) => void;
  onStatusChange: (status: MicCaptureStatus) => void;
  onError: (message: string) => void;
}

export function getBrowserMicEnvironment(): BrowserMicEnvironment {
  return {
    mediaDevices: typeof navigator === "undefined" ? undefined : navigator.mediaDevices,
    MediaRecorder: typeof MediaRecorder === "undefined" ? undefined : MediaRecorder,
    now: () => Date.now(),
  };
}

export function getGatewayUploadEnvironment(): GatewayUploadEnvironment {
  return {
    WebSocket: typeof WebSocket === "undefined" ? undefined : WebSocket,
  };
}

export function isMicCaptureSupported(environment: BrowserMicEnvironment): boolean {
  return Boolean(environment.mediaDevices?.getUserMedia && environment.MediaRecorder);
}

export function isGatewayUploadSupported(environment: GatewayUploadEnvironment): boolean {
  return Boolean(environment.WebSocket);
}

export function buildRealtimeAudioUrl(baseUrl: string, sessionId: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  return `${normalizedBase}/v1/recitation-sessions/${encodeURIComponent(sessionId)}/audio`;
}

export function getConfiguredRealtimeAudioUrl(sessionId: string): string {
  const defaultWsUrl = import.meta.env.DEV
    ? "ws://127.0.0.1:8081"
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
  const baseUrl = import.meta.env.VITE_REALTIME_GATEWAY_URL || defaultWsUrl;
  return buildRealtimeAudioUrl(baseUrl, sessionId);
}

export function parseGatewayAudioAck(payload: string): GatewayAudioAck | null {
  try {
    const parsed = JSON.parse(payload) as Partial<GatewayAudioAck>;
    if (
      parsed.kind !== "audio.ack" ||
      typeof parsed.session_id !== "string" ||
      typeof parsed.chunk_id !== "string" ||
      typeof parsed.sequence !== "number" ||
      typeof parsed.accepted !== "boolean" ||
      typeof parsed.message !== "string"
    ) {
      return null;
    }

    return parsed as GatewayAudioAck;
  } catch {
    return null;
  }
}

export function startGatewayAudioUpload(
  options: StartGatewayUploadOptions,
  environment: GatewayUploadEnvironment = getGatewayUploadEnvironment(),
): GatewayUploader | null {
  if (!isGatewayUploadSupported(environment)) {
    options.onStatusChange("unavailable");
    options.onError("Realtime gateway upload is not supported in this browser.");
    return null;
  }

  options.onStatusChange("connecting");
  const socket = new environment.WebSocket!(options.url);

  socket.binaryType = "arraybuffer";
  socket.onopen = () => options.onStatusChange("connected");
  socket.onclose = () => options.onStatusChange("closed");
  socket.onerror = () => {
    options.onStatusChange("error");
    options.onError("Realtime gateway connection failed.");
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") {
      return;
    }

    const ack = parseGatewayAudioAck(event.data);
    if (ack) {
      options.onAck(ack);
    }
  };

  return {
    sendChunk: (chunk) => {
      if (socket.readyState !== environment.WebSocket!.OPEN || !chunk.blob) {
        return false;
      }

      socket.send(chunk.blob);
      return true;
    },
    close: () => socket.close(),
  };
}

export function mapMicCaptureError(error: unknown): MicCaptureStatus {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "denied";
  }

  return "error";
}

export function createBrowserAudioChunk(input: {
  sessionId: string;
  sequence: number;
  blob: Blob;
  startedAtMs: number;
  emittedAtMs: number;
  chunkDurationMs: number;
  sampleRate: 16000 | 24000 | 48000;
}): BrowserAudioChunk {
  const startMs = input.sequence * input.chunkDurationMs;
  const endMs = Math.max(startMs + 1, Math.round(input.emittedAtMs - input.startedAtMs));

  return {
    id: `${input.sessionId}-chunk-${String(input.sequence).padStart(4, "0")}`,
    sessionId: input.sessionId,
    sequence: input.sequence,
    startMs,
    endMs,
    sampleRate: input.sampleRate,
    sizeBytes: input.blob.size,
    mimeType: input.blob.type || "audio/webm",
    emittedAt: new Date(input.emittedAtMs).toISOString(),
    blob: input.blob,
  };
}

export async function startBrowserMicCapture(
  options: StartMicCaptureOptions,
  environment: BrowserMicEnvironment = getBrowserMicEnvironment(),
): Promise<MicCaptureController | null> {
  if (!isMicCaptureSupported(environment)) {
    options.onStatusChange("unsupported");
    options.onError("Microphone capture is not supported in this browser.");
    return null;
  }

  options.onStatusChange("requesting-permission");

  try {
    const stream = await environment.mediaDevices!.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: options.sampleRate,
      },
      video: false,
    });
    const recorder = new environment.MediaRecorder!(stream, { mimeType: getPreferredMimeType(environment.MediaRecorder!) });
    const startedAtMs = environment.now?.() ?? Date.now();
    let sequence = 0;

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) {
        return;
      }

      const emittedAtMs = environment.now?.() ?? Date.now();
      options.onChunk(
        createBrowserAudioChunk({
          sessionId: options.sessionId,
          sequence,
          blob: event.data,
          startedAtMs,
          emittedAtMs,
          chunkDurationMs: options.chunkDurationMs,
          sampleRate: options.sampleRate,
        }),
      );
      sequence += 1;
    };

    recorder.onerror = () => {
      options.onStatusChange("error");
      options.onError("Microphone recorder failed while streaming audio.");
    };

    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      options.onStatusChange("stopped");
    };

    recorder.start(options.chunkDurationMs);
    options.onStatusChange("recording");

    return {
      stream,
      stop: () => {
        if (recorder.state !== "inactive") {
          recorder.stop();
        } else {
          stream.getTracks().forEach((track) => track.stop());
          options.onStatusChange("stopped");
        }
      },
    };
  } catch (error) {
    const status = mapMicCaptureError(error);
    options.onStatusChange(status);
    options.onError(status === "denied" ? "Microphone permission was denied." : "Could not start microphone capture.");
    return null;
  }
}

export function summarizeLiveCapture(chunks: BrowserAudioChunk[], alignmentEvents: LiveAlignmentEvent[]) {
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0);
  const latestEvent = alignmentEvents.at(-1);

  return {
    chunkCount: chunks.length,
    totalBytes,
    latestLatencyMs: latestEvent?.latencyMs ?? 0,
    alignedWordCount: latestEvent?.alignments.length ?? 0,
  };
}

function getPreferredMimeType(mediaRecorder: typeof MediaRecorder): string {
  if (mediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    return "audio/webm;codecs=opus";
  }

  if (mediaRecorder.isTypeSupported("audio/mp4")) {
    return "audio/mp4";
  }

  return "";
}
