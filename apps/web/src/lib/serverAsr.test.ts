import { afterEach, describe, expect, it, vi } from "vitest";
import { blobToBase64, encodeWav, transcribeWav, startLocalAudioRecording } from "./serverAsr";

describe("server ASR (trained Quran model path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("releases the mic and returns null if MediaRecorder construction throws after getUserMedia", async () => {
    // getUserMedia succeeds and opens a mic stream; then `new MediaRecorder(...)` throws (unsupported
    // mime / InvalidStateError). The stream's tracks MUST be stopped so the mic doesn't stay hot, and
    // the call must resolve to null (not reject with an unhandled rejection).
    const trackStop = vi.fn();
    const stream = { getTracks: () => [{ stop: trackStop }] };
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    const ThrowingRecorder = function () {
      throw new Error("MediaRecorder not supported");
    } as unknown as typeof MediaRecorder;
    (ThrowingRecorder as unknown as { isTypeSupported: () => boolean }).isTypeSupported = () => false;
    vi.stubGlobal("MediaRecorder", ThrowingRecorder);

    const onError = vi.fn();
    const controller = await startLocalAudioRecording({ onStatusChange: () => {}, onError });

    expect(controller).toBeNull();
    expect(trackStop).toHaveBeenCalledOnce(); // mic released, not left hot
    expect(onError).toHaveBeenCalledOnce();
  });

  it("encodes mono float samples as a valid 16-bit PCM WAV", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = encodeWav(samples, 16000);
    const view = new DataView(await wav.arrayBuffer());
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(view.buffer, offset, length));

    expect(wav.type).toBe("audio/wav");
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(samples.length * 2); // data size
    expect(wav.size).toBe(44 + samples.length * 2);
    // Full-scale samples clamp to the 16-bit range.
    expect(view.getInt16(44 + 3 * 2, true)).toBe(0x7fff);
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-0x8000);
  });

  it("base64-encodes binary audio without corruption", async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const b64 = await blobToBase64(new Blob([bytes]));
    expect(b64).toBe(btoa(String.fromCharCode(0, 1, 2, 253, 254, 255)));
  });

  it("POSTs WAV audio to the platform-api ASR proxy with actor auth and returns the model text", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.audioFormat).toBe("wav");
      expect(typeof body.audioBase64).toBe("string");
      expect(body.audioBase64.length).toBeGreaterThan(0);
      expect(body.language).toBe("ar");
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: "  الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ  " }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const text = await transcribeWav(encodeWav(new Float32Array([0.1, 0.2]), 16000), "ar", {
      tenantId: "hikmah-pilot-erbil",
      userId: "learner-1",
      authToken: "tok-123",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    // The browser hits the platform-api proxy, NOT the ASR service directly.
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/asr/transcribe");
    // A Bearer token is forwarded so the proxy can authenticate the caller.
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-123");
    expect(text).toBe("الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ");
  });

  it("throws when the ASR service is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response),
    );
    await expect(transcribeWav(encodeWav(new Float32Array([0]), 16000), "ar")).rejects.toThrow("503");
  });
});
