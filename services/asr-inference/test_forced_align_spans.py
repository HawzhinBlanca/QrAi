"""`align_words` is the forced-aligned-span producer. This is its first direct test. (W1.6)

    .venv/bin/python -m pytest -q test_forced_align_spans.py

── What is real here and what is synthetic ─────────────────────────────────────────────────────
REAL: torchaudio's own `forced_align` and `merge_tokens`, the token-construction, span-grouping,
blank-index and frame->millisecond arithmetic in `forced_align.align_words` — every line under test
is the shipped one.

SYNTHETIC: the acoustic emissions. A fake CTC model returns a hand-built logit tensor whose
argmax path is known frame by frame, so the expected milliseconds are arithmetic rather than
opinion. This test therefore says NOTHING about alignment accuracy on real recitation — that claim
belongs to `forced_align_arabic.py`, which measures ~64ms word-start MAE against Quran.com ground
truth over the network with the real 1.2GB checkpoint, and is not gateable.

That split is the point. Because the only existing exercise of `align_words` needed a network and a
1.2GB download, the forced-aligned-span producer shipped with no gated direct test, and the defect
below sat in it undetected.

── Why these properties ────────────────────────────────────────────────────────────────────────
QA-2: "THE system SHALL preserve only server-derived recognized-token and canonical-alignment spans
satisfying `0 <= startMs < endMs` with absolute monotonic offsets; IF span evidence is malformed,
over limit, or unavailable, THEN it SHALL return an explicit non-finalized reason and persist none."

The Node side enforces that predicate defensively: `recognizedTokensFrom` in
`server/src/inference/runtime.mjs` throws `invalid-recognized-spans` on any span that violates it,
and the session is refused. Nothing anywhere proved the PRODUCER can satisfy it. A producer that
silently emitted `end <= start`, or spans in the wrong order, would make the platform refuse every
real session — fail-closed, so no alarm, just a feature that never works. Worse, a producer that
emitted plausible-but-wrong timings would pass every downstream check and hand a learner
fabricated evidence about where in the audio they made a mistake.
"""
import re
from types import SimpleNamespace

import pytest
import torch

import forced_align
from forced_align import align_words

SAMPLE_RATE = 16_000
# wav2vec2's convolutional feature extractor stride: one emission frame per 320 input samples
# (20ms). `align_words` derives its own ratio from the two tensor shapes rather than assuming this,
# which is why the fake model can pick any stride it likes; 320 keeps the numbers recognisable.
SAMPLES_PER_FRAME = 320


class _FakeCtcModel:
    """Stands in for Wav2Vec2ForCTC: called with a waveform, exposes `.logits`."""

    def __init__(self, logits):
        self._logits = logits

    def __call__(self, _waveform):
        return SimpleNamespace(logits=self._logits)


def _emission_from_frames(frame_labels, vocab_size):
    """Logits whose argmax at frame t is `frame_labels[t]`, peaked hard enough that the forced
    alignment has no reason to choose any other valid CTC path."""
    logits = torch.full((1, len(frame_labels), vocab_size), -12.0)
    for frame, label in enumerate(frame_labels):
        logits[0, frame, label] = 12.0
    return logits


def _install(vocab, frame_labels):
    """Point `align_words` at a fake model+vocab and return the matching waveform.

    Writing `_model` directly is what keeps this test gateable: `forced_align._load()` returns early
    when `_model` is already set, so `transformers` is never imported and no checkpoint is fetched.
    """
    forced_align._model = _FakeCtcModel(_emission_from_frames(frame_labels, len(vocab)))
    forced_align._vocab = vocab
    return torch.zeros((1, len(frame_labels) * SAMPLES_PER_FRAME))


@pytest.fixture(autouse=True)
def _restore_module_state():
    yield
    forced_align._model = None
    forced_align._vocab = None


def _ms(frame):
    return int(frame * SAMPLES_PER_FRAME * 1000 / SAMPLE_RATE)


# ── The shared fixture: two real Quranic words over a known 20-frame layout ──────────────────────
#
#   frame  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
#   label  .  .  ب  ب  س  م  م  .  ا  ا  ل  .  ل  ل  ه  ه  .  .  .  .
#          <--------- word 0 --------->  <---------- word 1 ---------->
#
# The blank at frame 11 is not decoration: CTC requires a blank between the two identical ل of
# "الله", so this layout also exercises the repeated-token path that a naive plan would miss.
WORDS = ["بسم", "الله"]
FRAME_PLAN = ["", "", "ب", "ب", "س", "م", "م", "", "ا", "ا", "ل", "", "ل", "ل", "ه", "ه", "", "", "", ""]
EXPECTED = [(_ms(2), _ms(7)), (_ms(8), _ms(16))]  # (40, 140) and (160, 320)


def _vocab_with_pad_at(pad_index):
    """Build a vocab for the fixture letters with `<pad>` at a chosen index.

    The index is a parameter because it is exactly what the defect below turns on, and because
    `FORCE_ALIGN_MODEL` lets an operator swap in any permissively-licensed Arabic CTC checkpoint —
    whose vocab orders its special tokens however its author chose.
    """
    ordered = ["ب", "س", "م", "ا", "ل", "ه", "<unk>"]
    ordered.insert(pad_index, "<pad>")
    return {symbol: index for index, symbol in enumerate(ordered)}


def _labels(vocab, plan):
    return [vocab["<pad>"] if symbol == "" else vocab[symbol] for symbol in plan]


def test_every_span_is_positive_monotonic_and_inside_the_audio():
    """QA-2's predicate, asserted against the producer instead of trusted downstream."""
    vocab = _vocab_with_pad_at(0)
    waveform = _install(vocab, _labels(vocab, FRAME_PLAN))
    duration_ms = waveform.size(1) * 1000 / SAMPLE_RATE

    spans = align_words(waveform, WORDS)

    assert len(spans) == len(WORDS), "word i of the response must be word i of the transcript"
    previous_end = -1
    for word, (start_ms, end_ms, score) in zip(WORDS, spans):
        assert start_ms >= 0, f"{word}: negative start {start_ms}"
        assert end_ms > start_ms, f"{word}: non-positive span {start_ms}..{end_ms}"
        assert start_ms >= previous_end, f"{word}: span moves backwards from {previous_end}"
        assert end_ms <= duration_ms, f"{word}: span ends {end_ms}ms past {duration_ms}ms of audio"
        assert 0.0 <= score <= 1.0, f"{word}: score {score} is not a probability"
        previous_end = end_ms


def test_the_milliseconds_are_the_frame_arithmetic_and_not_approximately_it():
    """Exact values, because Node adds a window offset to these numbers and persists the sum.

    `recognizedTokensFrom(..., {offsetMs})` composes `offsetMs + localMs` into the absolute session
    timeline. If the local milliseconds drifted from the frame arithmetic, every window after the
    first would place the learner's words somewhere they never spoke, and the sum would still look
    monotonic and in-bounds — passing every check the platform makes.
    """
    vocab = _vocab_with_pad_at(0)
    waveform = _install(vocab, _labels(vocab, FRAME_PLAN))

    spans = align_words(waveform, WORDS)

    assert [(s, e) for s, e, _ in spans] == EXPECTED


def test_shifting_the_utterance_later_shifts_the_spans_by_exactly_that_much():
    """The offset property Node relies on: frame->ms is linear with no per-window constant.

    A window is a slice of a longer session, and its spans become absolute by adding the slice's
    start. That is only sound if the same audio content, moved later in the clip, produces spans
    later by precisely the same amount.
    """
    vocab = _vocab_with_pad_at(0)
    shift_frames = 5

    waveform = _install(vocab, _labels(vocab, FRAME_PLAN))
    baseline = align_words(waveform, WORDS)

    shifted_plan = [""] * shift_frames + FRAME_PLAN
    waveform = _install(vocab, _labels(vocab, shifted_plan))
    shifted = align_words(waveform, WORDS)

    for (base_start, base_end, _), (moved_start, moved_end, _) in zip(baseline, shifted):
        assert moved_start - base_start == _ms(shift_frames)
        assert moved_end - base_end == _ms(shift_frames)


def test_the_blank_index_is_read_from_the_vocab_and_not_assumed_to_be_zero():
    """The same recitation, aligned with a checkpoint whose `<pad>` is not index 0.

    `torchaudio.functional.merge_tokens(tokens, scores, blank=0)` defaults its blank to 0.
    `align_words` passes the vocab's real `<pad>` to `forced_align` and then calls `merge_tokens`
    on the result — so unless the same blank reaches BOTH, the second call strips whichever symbol
    happens to occupy index 0 (here a real Arabic letter) and keeps the genuine blank frames as if
    they were spoken tokens. The span list then has more entries than the transcript has tokens,
    every `token_spans[a:b]` slice lands on the wrong tokens, and each word is handed the timing of
    a neighbour.

    Nothing downstream can catch that. The spans stay positive, stay ordered, stay inside the
    audio, and satisfy QA-2 completely — they are simply about the wrong moments in the recitation.
    A learner would be shown their error at a timestamp where they said something else.

    Today's default checkpoint happens to put `<pad>` at 0, which is why this has never been seen.
    `FORCE_ALIGN_MODEL` is documented as swappable for any permissively-licensed Arabic CTC model,
    so "the vocab we happen to load orders its specials the way we assumed" is a property of one
    checkpoint, not an invariant of the code.
    """
    vocab = _vocab_with_pad_at(6)
    assert vocab["<pad>"] == 6 and vocab["ب"] == 0, "the fixture must actually move <pad> off zero"

    waveform = _install(vocab, _labels(vocab, FRAME_PLAN))
    spans = align_words(waveform, WORDS)

    assert [(s, e) for s, e, _ in spans] == EXPECTED, (
        "the spans changed when only the vocab's ordering did. The audio, the words and the frame "
        "layout are identical to the passing case above; only which integer means <pad> moved."
    )


def test_a_transcript_longer_than_the_audio_supports_is_refused():
    """The explicit-reason half of QA-2, at the producer.

    CTC cannot align more target tokens than there are emission frames. `align_words` detects that
    and raises ValueError, which the endpoint maps to 400 — a caller-fixable statement about the
    input. Without the check, torchaudio raises a RuntimeError that falls into the generic handler
    and becomes a 500: "the server broke, retry" for a request that can never succeed.
    """
    vocab = _vocab_with_pad_at(0)
    waveform = _install(vocab, _labels(vocab, ["", "ب", ""]))

    with pytest.raises(ValueError) as excinfo:
        align_words(waveform, WORDS)  # 7 tokens, 3 frames

    assert re.search(r"\b7\b.*\b3\b", str(excinfo.value)), (
        f"the refusal must name what it could not fit; got {str(excinfo.value)!r}"
    )


def test_a_word_with_no_alignable_characters_still_gets_a_bounded_span():
    """The `<unk>` branch, pinned as the deliberate behaviour it is documented to be.

    A word whose characters are all absent from the model vocab contributes no tokens, so
    `align_words` gives it one `<unk>` slot "so the word still gets a span". That span is real in
    the sense that CTC placed the `<unk>` somewhere, but it is evidence about an unknown symbol,
    not about the word — and it must at minimum stay positive, ordered and in-bounds rather than
    collapsing to zero width or swallowing a neighbour's timing.

    This is pinned rather than changed: it is reachable from `/v1/force-align` with a caller-chosen
    transcript, and W1.7 is the task that decides what a non-evidence-backed word is allowed to be.
    """
    vocab = {"<pad>": 0, "<unk>": 1, "ب": 2, "س": 3, "م": 4}
    plan = ["", "ب", "ب", "س", "م", "", "<unk>", "<unk>", "", ""]
    labels = [vocab["<pad>"] if s == "" else vocab[s] for s in plan]
    waveform = _install(vocab, labels)

    spans = align_words(waveform, ["بسم", "xyz"])

    assert len(spans) == 2
    (arabic_start, arabic_end, _), (unknown_start, unknown_end, _) = spans
    assert (arabic_start, arabic_end) == (_ms(1), _ms(5)), "the real word lost its own timing"
    assert unknown_start >= arabic_end, "the unknown word's span overlaps the word before it"
    assert unknown_end > unknown_start, "a zero-width span is not a measurement"
    assert unknown_end <= waveform.size(1) * 1000 / SAMPLE_RATE
