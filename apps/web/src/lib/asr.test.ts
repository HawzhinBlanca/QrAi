// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { splitTranscript, startAsr } from "./asr";

/** Minimal fake of the browser SpeechRecognition API, just enough to drive startAsr's callbacks. */
class FakeSpeechRecognition extends EventTarget {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
}

function fireResult(
  recognition: FakeSpeechRecognition,
  results: Array<{ transcript: string; confidence?: number; isFinal?: boolean }>,
  resultIndex?: number,
) {
  const event = new Event("result") as Event & { results: unknown; resultIndex?: number };
  event.results = results.map((r) => Object.assign([{ transcript: r.transcript, confidence: r.confidence }], { isFinal: r.isFinal }));
  event.resultIndex = resultIndex;
  recognition.dispatchEvent(event);
}

describe("startAsr", () => {
  it("reports isFinal from the real per-result SpeechRecognitionResult flag, not event.resultIndex", () => {
    const fake = new FakeSpeechRecognition();
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = function () {
      return fake;
    };

    const results: Array<{ transcript: string; confidence: number; isFinal: boolean }> = [];
    startAsr({
      onResult: (r) => results.push(r),
      onStatusChange: () => {},
      onError: () => {},
    });

    // Both results changed this event (resultIndex=0), so both are emitted. isFinal must be read
    // from each result's own flag, NOT derived from event.resultIndex — the bug this guards against
    // treated a truthy resultIndex as "final" for every result, reporting index 0 as final too.
    fireResult(
      fake,
      [
        { transcript: "بسم", confidence: 0.9, isFinal: false },
        { transcript: "الله", confidence: 0.95, isFinal: true },
      ],
      0,
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ transcript: "بسم", isFinal: false });
    expect(results[1]).toMatchObject({ transcript: "الله", isFinal: true });

    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it("iterates from event.resultIndex so already-finalized results are not re-emitted", () => {
    const fake = new FakeSpeechRecognition();
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = function () {
      return fake;
    };

    const results: Array<{ transcript: string; isFinal: boolean }> = [];
    startAsr({
      onResult: (r) => results.push(r),
      onStatusChange: () => {},
      onError: () => {},
    });

    // Event 1: the first (interim) result appears at index 0.
    fireResult(fake, [{ transcript: "بسم", isFinal: false }], 0);
    // Event 2: index 0 has finalized and a new interim appears at index 1. `results` is cumulative,
    // but resultIndex=1 says only index 1 changed — index 0 must NOT be re-emitted (the old
    // iterate-from-0 loop would emit "بسم" a second time, duplicating it downstream).
    fireResult(
      fake,
      [
        { transcript: "بسم", isFinal: true },
        { transcript: "الله", isFinal: false },
      ],
      1,
    );

    expect(results.map((r) => r.transcript)).toEqual(["بسم", "الله"]);

    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it("falls back to last-result-is-final when a result carries no isFinal flag", () => {
    const fake = new FakeSpeechRecognition();
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = function () {
      return fake;
    };

    const results: Array<{ transcript: string; isFinal: boolean }> = [];
    startAsr({
      onResult: (r) => results.push(r),
      onStatusChange: () => {},
      onError: () => {},
    });

    fireResult(fake, [{ transcript: "الرحمن" }]);

    expect(results).toEqual([{ transcript: "الرحمن", confidence: 0.5, isFinal: true }]);

    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });
});

describe("splitTranscript", () => {
  it("splits on whitespace and drops empty tokens", () => {
    expect(splitTranscript("  بسم   الله  الرحمن ")).toEqual(["بسم", "الله", "الرحمن"]);
  });

  it("returns an empty array for blank input", () => {
    expect(splitTranscript("   ")).toEqual([]);
  });
});
