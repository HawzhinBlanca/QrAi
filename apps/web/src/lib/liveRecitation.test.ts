import { describe, expect, it } from "vitest";
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

/** Let the uploader's async ticket fetch settle before asserting on the socket it opens. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Simulate the SERVER dropping the connection: a real close flips readyState BEFORE onclose fires.
 * Firing onclose alone would leave readyState OPEN, so sendChunk would still "send" into a dead
 * socket instead of buffering — i.e. it wouldn't test the outage at all.
 */
function drop(socket: FakeWebSocket) {
  socket.readyState = 3; // CLOSED
  socket.onclose?.();
}

function makeChunk(sequence: number) {
  return createBrowserAudioChunk({
    sessionId: SESSION_ID,
    sequence,
    blob: new Blob([`audio-${sequence}`], { type: "audio/webm" }),
    startedAtMs: sequence * 480,
    emittedAtMs: (sequence + 1) * 480,
    chunkDurationMs: 480,
    sampleRate: 16000,
  });
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
        getUrl: async () => "ws://gateway",
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

  it("sends audio blobs only after the gateway websocket is open", async () => {
    FakeWebSocket.instances = [];
    const statuses: string[] = [];
    const acks: unknown[] = [];
    const uploader = startGatewayAudioUpload(
      {
        getUrl: async () => "ws://gateway/audio?ticket=t1",
        onStatusChange: (status) => statuses.push(status),
        onAck: (ack) => acks.push(ack),
        onError: () => undefined,
      },
      { WebSocket: FakeWebSocket as unknown as typeof WebSocket },
    );
    await flush(); // the ticket fetch is async, so the socket appears a microtask later
    const socket = FakeWebSocket.instances[0];
    const chunk = makeChunk(0);

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

    expect(socket.url).toBe("ws://gateway/audio?ticket=t1");
    expect(socket.sent).toEqual([chunk.blob]);
    expect(statuses).toEqual(["connecting", "connected"]);
    expect(acks).toHaveLength(1);
  });

  it("reports a connection error without consuming a retry (onclose owns the backoff)", async () => {
    FakeWebSocket.instances = [];
    const statuses: string[] = [];
    const errors: string[] = [];
    startGatewayAudioUpload(
      {
        getUrl: async () => "ws://gateway/audio?ticket=t1",
        onStatusChange: (status) => statuses.push(status),
        onAck: () => undefined,
        onError: (message) => errors.push(message),
      },
      { WebSocket: FakeWebSocket as unknown as typeof WebSocket },
    );
    await flush();
    FakeWebSocket.instances[0].onerror?.();

    // onerror is always followed by onclose; retrying in both would double-count attempts and halve
    // the effective backoff, so onerror only reports.
    expect(errors).toContain("Realtime gateway connection failed.");
    expect(statuses).toEqual(["connecting"]);
  });

  it("closes cleanly (no reconnect) when the caller closes", async () => {
    FakeWebSocket.instances = [];
    const statuses: string[] = [];
    const uploader = startGatewayAudioUpload(
      {
        getUrl: async () => "ws://gateway/audio?ticket=t1",
        onStatusChange: (status) => statuses.push(status),
        onAck: () => undefined,
        onError: () => undefined,
      },
      { WebSocket: FakeWebSocket as unknown as typeof WebSocket },
    );
    await flush();
    FakeWebSocket.instances[0].onopen?.();
    uploader?.close();
    await flush();

    expect(statuses).toContain("closed");
    expect(statuses).not.toContain("reconnecting");
    expect(FakeWebSocket.instances).toHaveLength(1); // never reconnected
  });
});

// --- T13: reconnect + buffering ---------------------------------------------

/** Controlled backoff: capture scheduled callbacks so a test fires them deterministically. */
function reconnectEnv() {
  const timers: Array<() => void> = [];
  return {
    timers,
    fireBackoff: () => {
      const fn = timers.shift();
      if (!fn) throw new Error("no backoff scheduled");
      fn();
    },
    env: {
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return 1;
      },
      random: () => 1, // top of the jitter window -> deterministic delays
    },
  };
}

describe("gateway upload reconnect (T13)", () => {
  it("reconnects after an unexpected drop, fetching a FRESH ticket (tickets are single-use)", async () => {
    FakeWebSocket.instances = [];
    const statuses: string[] = [];
    let issued = 0;
    const { fireBackoff, env } = reconnectEnv();

    startGatewayAudioUpload(
      {
        getUrl: async () => `ws://gateway/audio?ticket=t${++issued}`,
        onStatusChange: (s) => statuses.push(s),
        onAck: () => undefined,
        onError: () => undefined,
      },
      env,
    );
    await flush();
    FakeWebSocket.instances[0].onopen?.();

    // Wi-Fi blip: the gateway drops us.
    drop(FakeWebSocket.instances[0]);
    expect(statuses).toContain("reconnecting");

    fireBackoff();
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(2);
    // Replaying ticket t1 would be rejected as a replay; the reconnect must mint t2.
    expect(FakeWebSocket.instances[1].url).toBe("ws://gateway/audio?ticket=t2");
    FakeWebSocket.instances[1].onopen?.();
    expect(statuses[statuses.length - 1]).toBe("connected");
  });

  it("buffers audio while disconnected and flushes it on reconnect (oldest-first)", async () => {
    FakeWebSocket.instances = [];
    let issued = 0;
    const { fireBackoff, env } = reconnectEnv();
    const uploader = startGatewayAudioUpload(
      {
        getUrl: async () => `ws://gateway/audio?ticket=t${++issued}`,
        onStatusChange: () => undefined,
        onAck: () => undefined,
        onError: () => undefined,
      },
      env,
    );
    await flush();
    FakeWebSocket.instances[0].onopen?.();
    drop(FakeWebSocket.instances[0]);

    // The learner keeps reciting through the outage — this audio must not be lost.
    const a = makeChunk(1);
    const b = makeChunk(2);
    expect(uploader?.sendChunk(a)).toBe(false); // buffered, not sent
    expect(uploader?.sendChunk(b)).toBe(false);

    fireBackoff();
    await flush();
    FakeWebSocket.instances[1].onopen?.();

    expect(FakeWebSocket.instances[1].sent).toEqual([a.blob, b.blob]);
  });

  it("degrades to batch after the retry budget is exhausted, instead of retrying forever", async () => {
    FakeWebSocket.instances = [];
    const statuses: string[] = [];
    const errors: string[] = [];
    const { fireBackoff, env } = reconnectEnv();
    startGatewayAudioUpload(
      {
        getUrl: async () => "ws://gateway/audio?ticket=t",
        onStatusChange: (s) => statuses.push(s),
        onAck: () => undefined,
        onError: (m) => errors.push(m),
        policy: { baseDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 },
      },
      env,
    );
    await flush();

    // Every attempt fails immediately.
    drop(FakeWebSocket.instances[0]); // attempt 1 scheduled
    fireBackoff();
    await flush();
    drop(FakeWebSocket.instances[1]); // attempt 2 scheduled
    fireBackoff();
    await flush();
    drop(FakeWebSocket.instances[2]); // attempt 3 > maxAttempts -> give up

    expect(statuses[statuses.length - 1]).toBe("degraded");
    expect(errors.some((e) => e.includes("without live feedback"))).toBe(true);
  });

  it("bounds the buffer during a long outage and reports every dropped chunk", async () => {
    FakeWebSocket.instances = [];
    const drops: number[] = [];
    const { env } = reconnectEnv();
    const uploader = startGatewayAudioUpload(
      {
        getUrl: async () => "ws://gateway/audio?ticket=t",
        onStatusChange: () => undefined,
        onAck: () => undefined,
        onError: () => undefined,
        onBufferDrop: (total) => drops.push(total),
        maxBufferedChunks: 3,
      },
      env,
    );
    await flush();
    FakeWebSocket.instances[0].onopen?.();
    drop(FakeWebSocket.instances[0]); // long outage begins

    for (let i = 0; i < 10; i++) uploader?.sendChunk(makeChunk(i));

    // 10 chunks into a 3-slot buffer -> 7 dropped, memory bounded, and the learner is told.
    expect(drops[drops.length - 1]).toBe(7);
  });
});
