// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }

  public ondataavailable: ((event: BlobEvent) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onstop: (() => void) | null = null;
  public state: RecordingState = "inactive";

  constructor() {
    FakeMediaRecorder.instances.push(this);
  }

  static instances: FakeMediaRecorder[] = [];

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.onstop?.();
  }

  emitChunk(blob: Blob) {
    this.ondataavailable?.({ data: blob } as BlobEvent);
  }
}

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

describe("Quran AI app smoke", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    FakeMediaRecorder.instances = [];
    FakeWebSocket.instances = [];

    // Pre-seed auth so the app renders past the login screen
    localStorage.setItem("quran-ai-auth", JSON.stringify({
      userId: "learner-1",
      tenantId: "hikmah-pilot-erbil",
      role: "learner",
      displayName: "Test Learner",
      token: "test-jwt-token",
    }));

    Object.defineProperty(window.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem("quran-ai-auth");
    document.body.innerHTML = "";
  });

  it("renders learner home first and advances through the calm practice flow", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    expect(document.body.textContent).toContain("Learner Home");
    expect(document.body.textContent).toContain("Today's mission");
    expect(document.body.textContent).toContain("Start Practice");
    expect(document.body.textContent).not.toContain("Quran AI intelligence platform");

    const startPracticeButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Start Practice"),
    );

    await act(async () => {
      startPracticeButton?.click();
    });

    expect(document.body.textContent).toContain("Practice");
    expect(document.body.textContent).toContain("Listen");
    expect(document.body.textContent).toContain("Learner view keeps model and gateway details hidden");
    expect(document.body.textContent).toContain("Surah Al-Fatihah");

    const nextButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Next step"),
    );

    await act(async () => {
      nextButton?.click();
      nextButton?.click();
      nextButton?.click();
    });

    expect(document.body.textContent).toContain("Low-confidence guidance");
    expect(document.body.textContent).toContain("Send to teacher");

    const sendToTeacherButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Send to teacher"),
    );

    await act(async () => {
      sendToTeacherButton?.click();
    });

    expect(document.body.textContent).toContain("Sent to teacher");

    await act(async () => {
      nextButton?.click();
      nextButton?.click();
    });

    expect(document.body.textContent).toContain("Practice complete");
  });

  it("keeps the internal command app available and advances the live recitation smoke path", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
    });

    const internalCommandButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Internal Command"),
    );

    await act(async () => {
      internalCommandButton?.click();
    });

    const startButton = document.querySelector<HTMLButtonElement>(".capture-button");
    expect(document.body.textContent).toContain("Quran AI intelligence platform");
    expect(startButton?.textContent).toContain("Start live recitation");

    await act(async () => {
      startButton?.click();
    });
    await act(async () => {});
    await act(async () => {
      FakeWebSocket.instances[0].onopen?.();
    });

    expect(document.body.textContent).toContain("Stop live recitation");
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("/v1/recitation-sessions/session-kri-00031/audio");

    await act(async () => {
      FakeMediaRecorder.instances[0].emitChunk(new Blob(["audio"], { type: "audio/webm" }));
    });
    await act(async () => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          kind: "audio.ack",
          session_id: "session-kri-00031",
          chunk_id: "session-kri-00031-chunk-0000",
          sequence: 0,
          accepted: true,
          message: "accepted",
        }),
      } as MessageEvent<string>);
    });

    expect(document.body.textContent).toContain("1 chunks");
    expect(document.body.textContent).toContain("1 aligned words");
    expect(document.body.textContent).toContain("1 accepted acks");
  });
});
