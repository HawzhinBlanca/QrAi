import type { WordAlignment } from "../types/platform";

import {
  DEFAULT_RECONNECT_POLICY,
  planReconnect,
  pushBoundedDropOldest,
  type ReconnectPolicy,
} from "./reconnect";

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

export type GatewayUploadStatus =
  | "idle"
  | "connecting"
  | "connected"
  /** Dropped; waiting out a jittered backoff before re-ticketing and retrying. Audio is buffered. */
  | "reconnecting"
  | "unavailable"
  | "error"
  | "closed"
  /** Gave up reconnecting — the caller should finalize this recitation as a batch upload. */
  | "degraded";

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
  /** Injected so reconnect backoff is deterministic (and instant) under test. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  random?: () => number;
}

export interface StartGatewayUploadOptions {
  /**
   * Mints a FRESH ticketed `ws://…?ticket=…` URL. Called for the first connect AND for every
   * reconnect: gateway tickets are single-use, so replaying the original URL is rejected as a
   * replay. This is a factory, not a string, for exactly that reason.
   */
  getUrl: () => Promise<string>;
  onStatusChange: (status: GatewayUploadStatus) => void;
  onAck: (ack: GatewayAudioAck) => void;
  onError: (message: string) => void;
  /** Running total of chunks dropped from the bounded buffer, so the UI can say so honestly. */
  onBufferDrop?: (totalDropped: number) => void;
  policy?: ReconnectPolicy;
  /** Chunks held while disconnected. Each is ~480 ms, so 125 ≈ 60 s of audio. */
  maxBufferedChunks?: number;
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
  const baseUrl = import.meta.env.VITE_REALTIME_GATEWAY_URL || "ws://127.0.0.1:8081";
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

  const WS = environment.WebSocket!;
  const schedule = environment.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const random = environment.random ?? Math.random;
  const policy = options.policy ?? DEFAULT_RECONNECT_POLICY;
  const maxBuffered = options.maxBufferedChunks ?? 125;

  let socket: WebSocket | null = null;
  let closedByCaller = false;
  let attempt = 0;
  let totalDropped = 0;
  const buffered: BrowserAudioChunk[] = [];

  /** Drain everything captured during the outage, oldest-first, once we're live again. */
  const flush = () => {
    while (buffered.length > 0 && socket?.readyState === WS.OPEN) {
      const chunk = buffered.shift();
      if (chunk?.blob) socket.send(chunk.blob);
    }
  };

  const retry = () => {
    attempt += 1;
    const decision = planReconnect(attempt, policy, random);
    if (decision.action === "give-up") {
      // Honest degrade: stop pretending a live session exists. The caller finalizes as batch.
      options.onStatusChange("degraded");
      options.onError("Live connection lost. Finishing this recitation without live feedback.");
      return;
    }
    options.onStatusChange("reconnecting");
    schedule(() => {
      if (!closedByCaller) void open();
    }, decision.delayMs);
  };

  const open = async () => {
    options.onStatusChange(attempt === 0 ? "connecting" : "reconnecting");
    let url: string;
    try {
      url = await options.getUrl(); // fresh single-use ticket, every attempt
    } catch {
      options.onError("Could not obtain a realtime ticket.");
      retry();
      return;
    }
    if (closedByCaller) return;

    const next = new WS(url);
    socket = next;
    next.binaryType = "arraybuffer";
    next.onopen = () => {
      attempt = 0; // a healthy connection resets the backoff ladder
      options.onStatusChange("connected");
      flush();
    };
    next.onclose = () => {
      if (closedByCaller) {
        options.onStatusChange("closed");
        return;
      }
      // Unexpected drop (Wi-Fi blip, gateway restart, rejected ticket): back off and re-ticket.
      retry();
    };
    next.onerror = () => {
      // Report, but don't retry here — onclose always follows and owns the backoff, so retrying in
      // both would double-count attempts and halve the effective backoff.
      options.onError("Realtime gateway connection failed.");
    };
    next.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      const ack = parseGatewayAudioAck(event.data);
      if (ack) {
        options.onAck(ack);
      }
    };
  };

  void open();

  return {
    sendChunk: (chunk) => {
      if (socket?.readyState === WS.OPEN && chunk.blob) {
        socket.send(chunk.blob);
        return true;
      }
      // Disconnected, or the first ticket is still in flight: buffer instead of dropping the
      // learner's recitation on the floor (the old code silently discarded it).
      const dropped = pushBoundedDropOldest(buffered, chunk, maxBuffered);
      if (dropped > 0) {
        totalDropped += dropped;
        options.onBufferDrop?.(totalDropped);
      }
      return false;
    },
    close: () => {
      closedByCaller = true;
      socket?.close();
      options.onStatusChange("closed");
    },
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
