/**
 * Bounded-window composition and absolute offsets, tested directly. (W1.6, QA-2)
 *
 *   node --test tests/inference/bounded-window-spans.test.mjs
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * `boundedPcmWindows` and `recognizedTokensFrom` are the two functions that turn a session's audio
 * into spans on an absolute timeline. Both are `export`ed — the usual sign that something is
 * exported so it can be tested — and until now nothing imported either of them. The only tests
 * near this path are `real-audio-spans.test.mjs`, which checks a byte-pinned fixture and a captured
 * response, and whose live-ASR case is `skip`ped unless `ASR_REAL_AUDIO_URL` is set.
 *
 * That is the same shape as the defect found in `services/asr-inference/forced_align.py` while
 * writing this task's Python proof: the forced-aligned-span producer had no gated test because its
 * direct accuracy harness needed a network and a 1.2GB checkpoint. It had been passing the wrong
 * blank index to `merge_tokens` and returning each word its neighbour's timing.
 *
 * These two functions can fail exactly the same way. A window whose `offsetMs` is off by one
 * context length, or cores that overlap, produce spans that are positive, ordered, inside the
 * audio, and about the wrong moment in the recitation. Every downstream check passes. The learner
 * is shown their mistake at a timestamp where they said something else.
 *
 * So the assertions here are about the properties nothing else can see:
 *   - the cores tile the session exactly once — no gap (a word is lost) and no overlap (a word is
 *     counted twice, from two different windows, at two different times)
 *   - context extends the AUDIO handed to the model without extending the core it is responsible
 *     for, and `offsetMs` is the context start, because that is the window's own time zero
 *   - `offsetMs + localMs` is the session timeline, so a token recognized in window 3 lands where
 *     it was actually spoken
 *   - malformed, non-monotonic and out-of-bounds span evidence is refused with a named reason
 *     rather than repaired, dropped, or averaged into something plausible
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { boundedPcmWindows, recognizedTokensFrom } from "../../server/src/inference/runtime.mjs";

const SAMPLE_RATE = 16_000;
const CORE_SECONDS = 90;
const CONTEXT_SECONDS = 2;
const MAX_WINDOWS = 20;

/** PCM16 of `seconds` of audio. Content is irrelevant here: every function under test reads only
 *  lengths and the sample rate, never a sample value. */
function pcmOfSeconds(seconds, sampleRate = SAMPLE_RATE) {
  return Buffer.alloc(Math.round(seconds * sampleRate) * 2);
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    return error?.reason ?? `threw without a reason: ${error}`;
  }
  return null;
}

// ── boundedPcmWindows ───────────────────────────────────────────────────────────────────────────

test("the cores tile the whole session exactly once — no gap and no overlap", () => {
  // 200s is deliberately not a multiple of the 90s core, so the last window is a short remainder.
  const totalMs = 200_000;
  const windows = boundedPcmWindows(pcmOfSeconds(200), SAMPLE_RATE);

  assert.equal(windows.length, Math.ceil(200 / CORE_SECONDS), "unexpected window count");
  assert.equal(windows[0].coreStartMs, 0, "the first core does not start at the session start");
  assert.equal(windows.at(-1).coreEndMs, totalMs, "the last core does not reach the session end");

  for (const [index, window] of windows.entries()) {
    assert.ok(window.coreEndMs > window.coreStartMs, `window ${index} has an empty core`);
    if (index === 0) continue;
    assert.equal(
      window.coreStartMs,
      windows[index - 1].coreEndMs,
      `window ${index} does not begin where window ${index - 1} ended. A gap loses every word ` +
        `spoken in it; an overlap reports the same word twice, at two different times.`,
    );
  }
});

test("context extends the audio the model sees, never the core it answers for", () => {
  const totalMs = 200_000;
  const contextMs = CONTEXT_SECONDS * 1000;
  const windows = boundedPcmWindows(pcmOfSeconds(200), SAMPLE_RATE);

  for (const [index, window] of windows.entries()) {
    // `offsetMs` IS the window's time zero, which is the start of its context — not of its core.
    // Confusing the two shifts every token in every window after the first by two seconds.
    assert.equal(
      window.offsetMs,
      Math.max(0, window.coreStartMs - contextMs),
      `window ${index}: offsetMs is not the context start`,
    );
    assert.equal(
      window.offsetMs + window.durationMs,
      Math.min(totalMs, window.coreEndMs + contextMs),
      `window ${index}: the window does not end at its context end`,
    );
    assert.equal(
      window.pcm.length,
      Math.round((window.durationMs / 1000) * SAMPLE_RATE) * 2,
      `window ${index}: durationMs disagrees with the bytes actually handed to the model`,
    );
    assert.ok(window.offsetMs <= window.coreStartMs, `window ${index}: context starts after its core`);
  }

  assert.equal(windows[0].offsetMs, 0, "the first window has no audio before it to borrow");
});

test("exactly one window is marked final, and it is the last", () => {
  // `final` widens the core's right edge from half-open to closed when tokens are assigned by
  // midpoint, so a token landing exactly on the session's last millisecond is kept rather than
  // discarded for belonging to a window that does not exist.
  const windows = boundedPcmWindows(pcmOfSeconds(200), SAMPLE_RATE);
  assert.deepEqual(
    windows.map((w) => w.final),
    [false, false, true],
  );
});

test("a session at the window limit is accepted and one window past it is refused", () => {
  // Both sides, because a limit only tested from the failing side can be off by one in the
  // direction that silently rejects legitimate sessions.
  const atLimit = boundedPcmWindows(pcmOfSeconds(MAX_WINDOWS * CORE_SECONDS), SAMPLE_RATE);
  assert.equal(atLimit.length, MAX_WINDOWS);

  const overBy = Buffer.alloc((MAX_WINDOWS * CORE_SECONDS * SAMPLE_RATE + 1) * 2);
  assert.equal(refusalReason(() => boundedPcmWindows(overBy, SAMPLE_RATE)), "session-duration-limit");
});

test("audio that is not complete PCM16 at a supported rate is refused, not guessed at", () => {
  assert.equal(
    refusalReason(() => boundedPcmWindows(Buffer.alloc(2001), SAMPLE_RATE)),
    "inconsistent-audio-format",
    "an odd byte count means a truncated final sample; every span derived from it is off",
  );
  assert.equal(refusalReason(() => boundedPcmWindows(Buffer.alloc(0), SAMPLE_RATE)), "inconsistent-audio-format");
  assert.equal(refusalReason(() => boundedPcmWindows("not a buffer", SAMPLE_RATE)), "inconsistent-audio-format");
  assert.equal(
    refusalReason(() => boundedPcmWindows(pcmOfSeconds(1), 44_100)),
    "inconsistent-audio-format",
    "an unsupported rate would scale every frame index into the wrong millisecond",
  );
});

// ── recognizedTokensFrom ────────────────────────────────────────────────────────────────────────

const oneWord = (over = {}) => ({
  words: [{ word: "بِسْمِ", start: 1.0, end: 2.0, probability: 0.9, ...over }],
});

test("a window's local timings become absolute session timings by exactly its offset", () => {
  const windows = boundedPcmWindows(pcmOfSeconds(200), SAMPLE_RATE);
  const third = windows[2];

  const tokens = recognizedTokensFrom(oneWord(), {
    offsetMs: third.offsetMs,
    durationMs: third.durationMs,
  });

  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].startMs, third.offsetMs + 1000);
  assert.equal(tokens[0].endMs, third.offsetMs + 2000);
  assert.ok(
    tokens[0].startMs >= third.coreStartMs - CONTEXT_SECONDS * 1000,
    "a token from the third window landed before the audio that window was given",
  );
});

test("Quran text crosses unchanged — the token carries the word, it does not re-derive it", () => {
  // The recognized word is Quranic recitation. This function changes units; it must not touch text.
  const word = "بِسْمِ";
  const [token] = recognizedTokensFrom(oneWord({ word }), { offsetMs: 0, durationMs: 5000 });
  assert.equal(token.text, word);
  assert.equal([...token.text].length, [...word].length, "a combining mark was added or removed");
});

test("no word timing at all is 'nothing measured', which is not the same as bad evidence", () => {
  // null lets the caller fall back to force-aligning the recognized transcript. Throwing here
  // would refuse sessions from every checkpoint that emits text without timestamps — which is the
  // shipped one.
  assert.equal(recognizedTokensFrom({ words: [] }, { durationMs: 5000 }), null);
  assert.equal(refusalReason(() => recognizedTokensFrom({}, {})), "invalid-recognized-spans");
  assert.equal(refusalReason(() => recognizedTokensFrom({ words: "x" }, {})), "invalid-recognized-spans");
});

test("one malformed span invalidates the whole array rather than being dropped", () => {
  // Dropping the bad element and keeping the rest would silently shorten the recitation, and the
  // survivors would still look perfectly well-formed.
  for (const [label, override] of [
    ["a zero-width span", { start: 1, end: 1 }],
    ["a backwards span", { start: 2, end: 1 }],
    ["a negative start", { start: -1, end: 1 }],
    ["a non-finite bound", { start: 1, end: Number.POSITIVE_INFINITY }],
    ["empty text", { word: "" }],
    ["non-string text", { word: 42 }],
    ["a confidence above one", { probability: 1.5 }],
    ["a missing confidence", { probability: undefined }],
  ]) {
    assert.equal(
      refusalReason(() => recognizedTokensFrom(oneWord(override), { durationMs: 5000 })),
      "invalid-recognized-spans",
      `${label} was accepted`,
    );
  }
});

test("spans that move backwards or run past the window are refused", () => {
  const backwards = {
    words: [
      { word: "أ", start: 2.0, end: 3.0, probability: 0.9 },
      { word: "ب", start: 1.0, end: 1.5, probability: 0.9 },
    ],
  };
  assert.equal(
    refusalReason(() => recognizedTokensFrom(backwards, { durationMs: 5000 })),
    "invalid-recognized-spans",
    "out-of-order spans would place a later word earlier in the session than an earlier one",
  );

  assert.equal(
    refusalReason(() => recognizedTokensFrom(oneWord({ start: 9, end: 10 }), { durationMs: 5000 })),
    "invalid-recognized-spans",
    "a span past the window's own duration is evidence about audio the window never contained",
  );
});

test("the forced-aligner's confidence field is read by name, not by position", () => {
  // The two producers disagree: /v1/transcribe returns `probability`, /v1/force-align returns
  // `score`. Reading the wrong one yields undefined, which the malformed check above rejects — so
  // getting this wrong refuses every forced-aligned session rather than corrupting one.
  const forced = { words: [{ word: "أ", start: 0.5, end: 1.0, score: 0.75 }] };
  const [token] = recognizedTokensFrom(forced, { durationMs: 5000, confidenceField: "score" });
  assert.equal(token.confidence, 0.75);
  assert.equal(
    refusalReason(() => recognizedTokensFrom(forced, { durationMs: 5000 })),
    "invalid-recognized-spans",
  );
});
