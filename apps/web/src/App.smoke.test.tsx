// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

// Extends EventTarget so both consumer styles this codebase uses are supported: property
// assignment (`recorder.ondataavailable = ...`, used by the live WS recitation path) and
// addEventListener (used by lib/serverAsr.ts's record-then-transcribe path).
class FakeMediaRecorder extends EventTarget {
  static isTypeSupported() {
    return true;
  }

  public ondataavailable: ((event: BlobEvent) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onstop: (() => void) | null = null;
  public state: RecordingState = "inactive";
  public mimeType = "audio/webm";

  constructor() {
    super();
    FakeMediaRecorder.instances.push(this);
  }

  static instances: FakeMediaRecorder[] = [];

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.onstop?.();
    this.dispatchEvent(new Event("stop"));
  }

  emitChunk(blob: Blob) {
    const event = { data: blob } as BlobEvent;
    this.ondataavailable?.(event);
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: blob }));
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
    // Hermetic: this smoke test asserts the no-backend fallbacks, so make every fetch fail
    // fast regardless of whether the local services happen to be running (Node 22 ships a
    // real global fetch that would otherwise hit them and make the test non-deterministic).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no backend in smoke test")));
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
    expect(document.body.textContent).toContain("Practice surah"); // surah picker present
    expect(document.body.textContent).toContain("Start Practice");
    expect(document.body.textContent).toContain("Allow browser or cloud speech processing");
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
    // Default surah when the API is unavailable (fetch is stubbed to reject in this test).
    expect(document.body.textContent).toContain("Surah Al-Faatiha");

    const nextButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Next step"),
    );

    await act(async () => {
      nextButton?.click();
      nextButton?.click();
      nextButton?.click();
    });

    // No backend in this smoke test -> zero real flagged words -> the banner must say so
    // honestly. A previous version hardcoded "three words need a gentle review" regardless of
    // what actually happened, and this assertion pinned that fabrication.
    expect(document.body.textContent).toContain("No flagged words in this pass");
    expect(document.body.textContent).not.toContain("three words");
    expect(document.body.textContent).toContain("Send to teacher");

    const sendToTeacherButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Send to teacher"),
    );

    await act(async () => {
      sendToTeacherButton?.click();
    });

    // No backend and no analyzed session in this smoke test -> nothing was actually sent, and
    // the banner must say so. A previous version unconditionally displayed "Sent to teacher."
    // after a button that made no request at all — this assertion pinned that lie.
    expect(document.body.textContent).toContain("No analyzed recitation to send yet");
    expect(document.body.textContent).not.toContain("Sent to your teacher");

    await act(async () => {
      nextButton?.click();
      nextButton?.click();
    });

    expect(document.body.textContent).toContain("Practice complete");
    // No recitation happened in this smoke run (no backend, no alignment) -> the completion panel
    // must NOT claim "Progress saved." A previous version asserted that unconditionally.
    expect(document.body.textContent).toContain("Record a recitation next time to save progress");
    expect(document.body.textContent).not.toContain("Progress saved");
  });

  it("the skip-to-content link's target is actually focusable, not just scrollable", async () => {
    // Regression test: <main id="main-content"> had no tabindex, so it was NOT a focusable
    // element at all. Activating "Skip to content" would scroll the viewport there (the browser's
    // default :target anchor-navigation behavior) but keyboard focus stayed wherever it was (or
    // fell back to <body>) — a keyboard/screen-reader user got no actual navigational benefit,
    // defeating the entire purpose of a skip link (WCAG 2.4.1 Bypass Blocks).
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const skipLink = document.querySelector<HTMLAnchorElement>(".skip-link");
    expect(skipLink?.getAttribute("href")).toBe("#main-content");

    const main = document.getElementById("main-content");
    expect(main?.tagName).toBe("MAIN");
    // tabIndex -1 is what makes an otherwise-non-interactive element programmatically focusable
    // (via .focus() or an anchor jump) without adding it to the normal Tab order.
    expect(main?.tabIndex).toBe(-1);

    // Directly exercise focusability, not just the attribute's presence.
    await act(async () => {
      main?.focus();
    });
    expect(document.activeElement).toBe(main);
  });

  it("double-clicking Record before getUserMedia resolves opens only one microphone stream", async () => {
    // Regression test: toggleAsrRecording's START path only flips isRecording to true after
    // getUserMedia/startServerAsr resolves, so a double-click while the first call is still
    // pending previously passed the isRecording guard twice, opened a second real MediaStream,
    // and orphaned the first (only the second controller ends up referenced, so the first
    // stream's tracks were never stopped). Use a deferred getUserMedia so both clicks land
    // inside the pending window, then assert only one MediaRecorder (one real mic stream) and
    // one getUserMedia call resulted.
    let resolveGetUserMedia: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void = () => {};
    const getUserMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveGetUserMedia = resolve;
        }),
    );
    Object.defineProperty(window.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    // Recording is gated on affirmative consent; grant it on Learner Home, before starting
    // practice (ConsentPanel lives there, not inside the practice flow itself).
    const consentCheckbox = document.querySelector<HTMLInputElement>(
      '[aria-label="Recording consent"] input[type="checkbox"]',
    );
    await act(async () => {
      consentCheckbox?.click();
    });

    const startPracticeButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Start Practice"),
    );
    await act(async () => {
      startPracticeButton?.click();
    });

    const recordButton = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Record your recitation"]');
    expect(recordButton()).toBeTruthy();

    // Two rapid clicks, both before getUserMedia resolves.
    await act(async () => {
      recordButton()?.click();
      recordButton()?.click();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveGetUserMedia({ getTracks: () => [{ stop: vi.fn() }] });
    });

    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it("tears down the mic visualizer if Stop is clicked before its own getUserMedia resolves", async () => {
    // Regression test: startMicVisualizer opens its OWN separate getUserMedia stream (for the
    // waveform), resolved asynchronously into visualizerStopRef.current via a `.then()` —
    // independent of the ASR path's own getUserMedia call. If Stop is clicked before this
    // particular promise resolves, the old code would store the visualizer's stop function into
    // the ref AFTER cleanup already ran, orphaning that mic stream + AudioContext forever (nothing
    // ever calls its stop function afterward). Make the visualizer's call (the first
    // getUserMedia call in the START path) resolve LATE, after Stop, and assert its AudioContext
    // gets closed anyway.
    class FakeAudioContext {
      static instances: FakeAudioContext[] = [];
      public closed = false;
      close = vi.fn(async () => {
        this.closed = true;
      });
      constructor() {
        FakeAudioContext.instances.push(this);
      }
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 32,
          getByteFrequencyData: vi.fn(),
        };
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    let resolveVisualizerGetUserMedia: (stream: unknown) => void = () => {};
    let callCount = 0;
    const getUserMedia = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        // The visualizer's call — stays pending until we resolve it manually, below.
        return new Promise((resolve) => {
          resolveVisualizerGetUserMedia = resolve;
        });
      }
      // The ASR path's own call — resolves immediately so isRecording flips true quickly,
      // well before the visualizer's call above.
      return Promise.resolve({ getTracks: () => [{ stop: vi.fn() }] });
    });
    Object.defineProperty(window.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const consentCheckbox = document.querySelector<HTMLInputElement>(
      '[aria-label="Recording consent"] input[type="checkbox"]',
    );
    await act(async () => {
      consentCheckbox?.click();
    });
    const startPracticeButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Start Practice"),
    );
    await act(async () => {
      startPracticeButton?.click();
    });

    const recordButton = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Record your recitation"], button[aria-label="Stop recording"]');

    await act(async () => {
      recordButton()?.click();
    });
    // ASR's getUserMedia (2nd call) has resolved; isRecording is true. The visualizer's (1st)
    // call is still pending.
    expect(document.body.textContent).toContain("Stop");

    await act(async () => {
      recordButton()?.click(); // Stop, while the visualizer's getUserMedia is still pending.
    });

    // Stopping also runs stopAndTranscribe's own decodeToWav16kMono, which creates (and
    // `finally`-closes) its own, unrelated AudioContext for audio decoding — snapshot the count
    // here so the assertion below targets only the visualizer's instance, not this one.
    const instancesBeforeVisualizerResolves = FakeAudioContext.instances.length;

    // Now let the visualizer's getUserMedia resolve, arriving after Stop was already clicked.
    await act(async () => {
      resolveVisualizerGetUserMedia({ getTracks: () => [{ stop: vi.fn() }] });
    });

    expect(FakeAudioContext.instances).toHaveLength(instancesBeforeVisualizerResolves + 1);
    const visualizerCtx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
    expect(visualizerCtx.close).toHaveBeenCalled();

    vi.unstubAllGlobals();
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

    // Wait for the lazy-loaded PlatformCommand chunk to resolve (may take multiple ticks).
    for (let i = 0; i < 10; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      if (document.body.textContent?.includes("Quran AI intelligence platform")) break;
    }

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
    // Without a backend the console falls back to the preview session id; assert the
    // gateway audio path shape rather than a hardcoded session id.
    expect(FakeWebSocket.instances[0].url).toContain("/v1/recitation-sessions/");
    expect(FakeWebSocket.instances[0].url).toContain("/audio");

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
    expect(document.body.textContent).toContain("KB streamed");
    expect(document.body.textContent).toContain("1 accepted acks");
  });

  it("double-clicking Start live recitation opens only one WebSocket and one mic stream", async () => {
    // Regression test: handleCaptureToggle's start path only assigns captureRef.current after
    // `await startBrowserMicCapture(...)` resolves (a real getUserMedia permission prompt), with
    // no synchronous guard before that await — a double-click in the pending window previously
    // re-entered the start branch, opening a second WebSocket AND a second mic stream, each
    // orphaning the first (refs get overwritten by whichever resolves last).
    let resolveGetUserMedia: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void = () => {};
    const getUserMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveGetUserMedia = resolve;
        }),
    );
    Object.defineProperty(window.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

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
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      if (document.body.textContent?.includes("Quran AI intelligence platform")) break;
    }

    const startButton = () => document.querySelector<HTMLButtonElement>(".capture-button");
    expect(startButton()).toBeTruthy();

    // Two rapid clicks, both before getUserMedia resolves.
    await act(async () => {
      startButton()?.click();
      startButton()?.click();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      resolveGetUserMedia({ getTracks: () => [{ stop: vi.fn() }] });
    });

    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it("stops the mic stream and closes the gateway socket when LiveAlignmentCard unmounts mid-capture", async () => {
    // Regression test: the only code that stopped the mic stream (captureRef.current.stop()) and
    // closed the gateway WebSocket (uploaderRef.current?.close()) was handleCaptureToggle's
    // manual-stop branch. There was no unmount cleanup, so navigating away from Internal Command
    // (e.g. back to Learner) while capture was running left the real microphone recording and
    // streaming audio to the gateway indefinitely -- a genuine privacy issue given this app's
    // explicit audio-consent requirements, not just a resource leak.
    const track = { stop: vi.fn() };
    Object.defineProperty(window.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) },
    });

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
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      if (document.body.textContent?.includes("Quran AI intelligence platform")) break;
    }

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".capture-button")?.click();
    });
    await act(async () => {});
    await act(async () => {
      FakeWebSocket.instances[0].onopen?.();
    });

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0].state).toBe("recording");
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.OPEN);

    // Navigate away -- back to Learner -- without clicking Stop first.
    const learnerButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Learner",
    );
    await act(async () => {
      learnerButton?.click();
    });

    expect(document.body.textContent).not.toContain("Quran AI intelligence platform");
    expect(FakeMediaRecorder.instances[0].state).toBe("inactive");
    expect(track.stop).toHaveBeenCalled();
    expect(FakeWebSocket.instances[0].readyState).toBe(3); // CLOSED
  });

  it("'Open related command tab' on a Teacher/Model Ops placeholder actually navigates to Internal Command", async () => {
    // Regression test: InternalSurface's placeholder button used to call onTabChange alone, which
    // only set activeTab — it never switched activeSection to "admin", so InternalSurface's own
    // `if (activeSection !== "admin")` early-return kept rendering the SAME placeholder. Clicking
    // the button did nothing observable.
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const teacherButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Teacher",
    );
    await act(async () => {
      teacherButton?.click();
    });
    expect(document.body.textContent).toContain("Teacher Review");
    expect(document.body.textContent).not.toContain("Quran AI intelligence platform");

    const openCommandButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Open related command tab"),
    );
    await act(async () => {
      openCommandButton?.click();
    });

    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      if (document.body.textContent?.includes("Quran AI intelligence platform")) break;
    }

    expect(document.body.textContent).toContain("Quran AI intelligence platform");
  });

  it("the Internal Command 'platform-apps' segmented control actually navigates between sections", async () => {
    // Regression test: PlatformCommand hardcoded `app.id === "learner" ? "active" : ""` with no
    // onClick handler at all, so this control always highlighted "Learner" regardless of the real
    // active section, and clicking any of its buttons did nothing.
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const internalCommandButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Internal Command"),
    );
    await act(async () => {
      internalCommandButton?.click();
    });
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      if (document.body.textContent?.includes("Quran AI intelligence platform")) break;
    }

    const teacherAppButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".platform-app")).find(
      (button) => button.querySelector("span")?.textContent === "Teacher",
    );
    expect(teacherAppButton?.className).not.toContain("active");

    await act(async () => {
      teacherAppButton?.click();
    });

    // Clicking must navigate OUT of Internal Command into the Teacher placeholder — not just
    // relabel which button in the still-visible console carries the "active" class.
    expect(document.body.textContent).toContain("Teacher Review");
    expect(document.body.textContent).not.toContain("Quran AI intelligence platform");
  });

  it("TopBar's language selector actually changes the active language, on every screen", async () => {
    // Regression test: TopBar rendered a plain <button> with no onClick and static "9 languages"
    // text — the only working language switcher was PlatformCommand's own <select>, reachable
    // only via Internal Command. A learner on the default Learner Home screen (rendered through
    // this same TopBar) had no way to change language at all.
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const select = document.querySelector<HTMLSelectElement>(".language-button select");
    expect(select, "TopBar must render a real, functional language <select>").toBeTruthy();
    expect(select!.value).toBe("ckb");

    const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      nativeValueSetter.call(select, "fr");
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(select!.value).toBe("fr");
    expect(document.body.textContent).toContain("Français");
  });

  it("TopBar's profile chip shows the real active user, not a hardcoded placeholder identity", async () => {
    // Regression test: TopBar was never passed displayName/roleLabel at all, so the chip always
    // rendered the translated placeholder default ("Soran Othman" / "Student") regardless of who
    // was actually using the app. In the default no-login-required mode the real identity is the
    // bypass-mode default learner ("Learner" / "learner"), not the placeholder.
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    expect(document.body.textContent).toContain("Learner");
    expect(document.body.textContent).not.toContain("Soran Othman");
  });

  it("TopBar's profile chip has no working logout in no-login-required mode, so it is disabled rather than a dead dropdown affordance", async () => {
    // Regression test: the chip rendered a ChevronDown icon implying a dropdown/menu, but was a
    // plain <div> with no onClick and no logout at all. There is no real session to log out of
    // in the default bypass-login mode (VITE_REQUIRE_LOGIN unset), so the fix disables the
    // button rather than wiring a no-op click handler that would silently do nothing.
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const profileChip = document.querySelector<HTMLButtonElement>(".profile-chip");
    expect(profileChip, "TopBar must render the profile chip as a real <button>").toBeTruthy();
    expect(profileChip!.disabled).toBe(true);
  });

  it("switching the language selector actually drives i18next, not just the dropdown's own display value", async () => {
    // Regression test for the gap this fixes: activeLanguage previously only picked which native
    // name to display in the dropdown and tagged session metadata sent to the backend -- it never
    // changed any rendered UI text. Import the real i18n singleton (not a mock) and confirm
    // i18next's own `language` actually updates when the selector changes.
    const { default: i18n } = await import("./i18n");

    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    const select = document.querySelector<HTMLSelectElement>(".language-button select");
    expect(select).toBeTruthy();

    const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      nativeValueSetter.call(select, "de");
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(i18n.language).toBe("de");

    // "de" has no real translated content yet (see i18n/index.ts) -- fallbackLng must still
    // resolve every key to its real English string rather than the raw key or empty text.
    expect(document.body.textContent).toContain("Learner");
    expect(document.body.textContent).not.toContain("sidebar.nav.learner");

    await act(async () => {
      nativeValueSetter.call(select, "ckb");
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(i18n.language).toBe("ckb");
  });
});
