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

    // event.resultIndex is a single event-level value (the index of the first result that
    // changed since the last event) — it is NOT a per-result finality signal. The bug this
    // guards against treated any truthy resultIndex as "this result is final" for every result
    // in the event, regardless of that result's own real isFinal flag. Set resultIndex=1 (a
    // plausible real value) while result[0].isFinal is genuinely false: the old code
    // (`!!event.resultIndex || i === results.length - 1`) would report index 0 as final too,
    // since `!!1` is true independent of `i`.
    fireResult(
      fake,
      [
        { transcript: "بسم", confidence: 0.9, isFinal: false },
        { transcript: "الله", confidence: 0.95, isFinal: true },
      ],
      1,
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ transcript: "بسم", isFinal: false });
    expect(results[1]).toMatchObject({ transcript: "الله", isFinal: true });

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
