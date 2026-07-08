import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRealtimeAudioUrl,
  createBrowserAudioChunk,
  isMicCaptureSupported,
  parseGatewayAudioAck,
  startGatewayAudioUpload,
  mapMicCaptureError,
  summarizeLiveCapture,
} from "./liveRecitation";

const SESSION_ID = "session-test-1";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  public binaryType: BinaryType = "blob";
  public readyState = FakeWebSocket.OPEN;
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public sent: unknown[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: unknown) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("live recitation audio helpers", () => {
  it("detects whether browser mic capture can run", () => {
    const FakeMediaRecorder = class {
      static isTypeSupported() {
        return true;
      }
    } as unknown as typeof MediaRecorder;

    expect(isMicCaptureSupported({})).toBe(false);
    expect(
      isMicCaptureSupported({
        mediaDevices: { getUserMedia: async () => ({}) as MediaStream },
        MediaRecorder: FakeMediaRecorder,
      }),
    ).toBe(true);
  });

  it("creates stable audio chunk envelopes for gateway upload", () => {
    const blob = new Blob(["audio-bytes"], { type: "audio/webm" });

    const chunk = createBrowserAudioChunk({
      sessionId: "session-1",
      sequence: 2,
      blob,
      startedAtMs: Date.parse("2026-06-24T00:00:00.000Z"),
      emittedAtMs: Date.parse("2026-06-24T00:00:02.360Z"),
      chunkDurationMs: 480,
      sampleRate: 16000,
    });

    expect(chunk).toMatchObject({
      id: "session-1-chunk-0002",
      sessionId: "session-1",
      sequence: 2,
      startMs: 960,
      endMs: 2360,
      sampleRate: 16000,
      sizeBytes: 11,
      mimeType: "audio/webm",
      emittedAt: "2026-06-24T00:00:02.360Z",
    });
  });

  it("maps permission failures into learner-safe mic states", () => {
    expect(mapMicCaptureError(new DOMException("denied", "NotAllowedError"))).toBe("denied");
    expect(mapMicCaptureError(new Error("device missing"))).toBe("error");
  });

  it("summarizes live capture telemetry from real chunks", () => {
    const blob = new Blob(["audio"], { type: "audio/webm" });
    const chunk = createBrowserAudioChunk({
      sessionId: SESSION_ID,
      sequence: 0,
      blob,
      startedAtMs: 0,
      emittedAtMs: 500,
      chunkDurationMs: 500,
      sampleRate: 16000,
    });

    // No live per-word alignment stream yet, so telemetry reflects captured chunks only.
    expect(summarizeLiveCapture([chunk], [])).toEqual({
      chunkCount: 1,
      totalBytes: 5,
      latestLatencyMs: 0,
      alignedWordCount: 0,
    });
  });

  it("builds the realtime gateway audio URL from the configured base URL", () => {
    expect(buildRealtimeAudioUrl("ws://127.0.0.1:8081/", "session/kri 1")).toBe(
      "ws://127.0.0.1:8081/v1/recitation-sessions/session%2Fkri%201/audio",
    );
  });

  it("parses only valid gateway acknowledgements", () => {
    expect(
      parseGatewayAudioAck(
        JSON.stringify({
          kind: "audio.ack",
          session_id: "session-1",
          chunk_id: "chunk-1",
          sequence: 0,
          accepted: true,
          message: "accepted",
        }),
      ),
    ).toMatchObject({ accepted: true, chunk_id: "chunk-1" });
    expect(parseGatewayAudioAck(JSON.stringify({ kind: "wrong" }))).toBeNull();
    expect(parseGatewayAudioAck("not json")).toBeNull();
  });

  it("returns an unavailable gateway uploader when WebSocket is missing", () => {
    const statuses: string[] = [];
    const errors: string[] = [];

    const uploader = startGatewayAudioUpload(
      {
        url: "ws://gateway",
        onStatusChange: (status) => statuses.push(status),
        onAck: () => undefined,
        onError: (message) => errors.push(message),
      },
      {},
    );

    expect(uploader).toBeNull();
    expect(statuses).toEqual(["unavailable"]);
    expect(errors[0]).toContain("not supported");
  });

  it("sends audio blobs only after the gateway websocket is open", () => {
    FakeWebSocket.instances = [];
    const statuses: string[] = [];
    const acks: unknown[] = [];
    const uploader = startGatewayAudioUpload(
      {
        url: "ws://gateway/audio",
        onStatusChange: (status) => statuses.push(status),
        onAck: (ack) => acks.push(ack),
        onError: () => undefined,
      },
      { WebSocket: FakeWebSocket as unknown as typeof WebSocket },
    );
    const socket = FakeWebSocket.instances[0];
    const chunk = createBrowserAudioChunk({
      sessionId: SESSION_ID,
      sequence: 0,
      blob: new Blob(["audio"], { type: "audio/webm" }),
      startedAtMs: 0,
      emittedAtMs: 480,
      chunkDurationMs: 480,
      sampleRate: 16000,
    });

    socket.onopen?.();
    expect(uploader?.sendChunk(chunk)).toBe(true);
    socket.onmessage?.({
      data: JSON.stringify({
        kind: "audio.ack",
        session_id: SESSION_ID,
        chunk_id: chunk.id,
        sequence: 0,
        accepted: true,
        message: "accepted",
      }),
    } as MessageEvent<string>);

    expect(socket.url).toBe("ws://gateway/audio");
    expect(socket.sent).toEqual([chunk.blob]);
    expect(statuses).toEqual(["connecting", "connected"]);
    expect(acks).toHaveLength(1);
  });

  describe("reconnect", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      FakeWebSocket.instances = [];
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("reopens a new socket with backoff after a mid-session drop, then resumes sending", () => {
      const statuses: string[] = [];
      const uploader = startGatewayAudioUpload(
        {
          url: "ws://gateway/audio",
          onStatusChange: (status) => statuses.push(status),
          onAck: () => undefined,
          onError: () => undefined,
        },
        { WebSocket: FakeWebSocket as unknown as typeof WebSocket },
      );

      const firstSocket = FakeWebSocket.instances[0];
      firstSocket.onopen?.();
      expect(statuses).toEqual(["connecting", "connected"]);

      firstSocket.readyState = 3;
      firstSocket.onclose?.();
      expect(statuses).toEqual(["connecting", "connected", "reconnecting"]);
      expect(FakeWebSocket.instances).toHaveLength(1);

      vi.advanceTimersByTime(500);
      expect(FakeWebSocket.instances).toHaveLength(2);
      const secondSocket = FakeWebSocket.instances[1];
      expect(secondSocket.url).toBe("ws://gateway/audio");

      secondSocket.onopen?.();
      expect(statuses).toEqual(["connecting", "connected", "reconnecting", "connected"]);

      const chunk = createBrowserAudioChunk({
        sessionId: SESSION_ID,
        sequence: 0,
        blob: new Blob(["audio"], { type: "audio/webm" }),
        startedAtMs: 0,
        emittedAtMs: 480,
        chunkDurationMs: 480,
        sampleRate: 16000,
      });
      expect(uploader?.sendChunk(chunk)).toBe(true);
      expect(secondSocket.sent).toEqual([chunk.blob]);
    });

    it("settles on error and stops retrying once attempts are exhausted", () => {
      const statuses: string[] = [];
      const errors: string[] = [];
      startGatewayAudioUpload(
        {
          url: "ws://gateway/audio",
          onStatusChange: (status) => statuses.push(status),
          onAck: () => undefined,
          onError: (message) => errors.push(message),
          maxReconnectAttempts: 2,
          baseReconnectDelayMs: 100,
        },
        { WebSocket: FakeWebSocket as unknown as typeof WebSocket },
      );

      // maxReconnectAttempts=2 allows 2 reconnect sockets beyond the initial one (indices 1, 2)
      // before the 3rd failure (on index 2) exhausts the budget.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const socket = FakeWebSocket.instances[attempt];
        socket.readyState = 3;
        socket.onclose?.();
        vi.advanceTimersByTime(10_000);
      }

      expect(FakeWebSocket.instances).toHaveLength(3);
      FakeWebSocket.instances[2].readyState = 3;
      FakeWebSocket.instances[2].onclose?.();

      expect(statuses.at(-1)).toBe("error");
      expect(errors.at(-1)).toContain("not reaching the server");

      vi.advanceTimersByTime(10_000);
      expect(FakeWebSocket.instances).toHaveLength(3);
    });

    it("cancels a pending reconnect timer when the uploader is closed deliberately", () => {
      const uploader = startGatewayAudioUpload(
        {
          url: "ws://gateway/audio",
          onStatusChange: () => undefined,
          onAck: () => undefined,
          onError: () => undefined,
        },
        { WebSocket: FakeWebSocket as unknown as typeof WebSocket },
      );

      const firstSocket = FakeWebSocket.instances[0];
      firstSocket.readyState = 3;
      firstSocket.onclose?.();
      expect(FakeWebSocket.instances).toHaveLength(1);

      uploader?.close();
      vi.advanceTimersByTime(10_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  });
});
