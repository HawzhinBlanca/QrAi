"""Regression tests for _strip_diacritics — runnable with a plain interpreter (no torch, no model).

    python test_forced_align_normalization.py

Why this file exists: `_DIACRITICS` shipped as a literal-character transcription of the JS class in
services/ml-inference/alignment.js:7, and the transcription merged two ranges into U+0610-U+0670 —
which covers the entire Arabic LETTER block U+0621-U+064A. `_strip_diacritics("بِسْمِ ٱللَّهِ")`
returned " ٱ ٱ": every letter deleted. align_words then looked up "<unk>" for every word and returned
fabricated timings, while docs reported a 64ms alignment MAE that could not have been real.

The first test below fails loudly on that bug. Every assertion uses \\u escapes for the expected
value, because literal combining marks are invisible in a diff — which is how the bug survived review.
"""
import re
import sys

# Import the module WITHOUT importing torch: forced_align imports torch at module scope, so pull the
# regex out of the source directly. This keeps the test runnable in CI with no ML dependencies.
_SRC = open("forced_align.py", encoding="utf-8").read()
_MATCH = re.search(r"^_DIACRITICS = re\.compile\((.+)\)$", _SRC, re.M)
assert _MATCH, "could not locate _DIACRITICS in forced_align.py"
_DIACRITICS = re.compile(eval(_MATCH.group(1)))  # noqa: S307 — our own source, pinned by the regex above


def _strip_diacritics(s: str) -> str:
    """Mirror of forced_align._strip_diacritics (kept in sync by test_mirror_matches_source)."""
    return _DIACRITICS.sub("", s).replace("ٱ", "ا")


def test_letters_survive_diacritic_stripping():
    """THE regression test. Bismillah must keep every consonant."""
    got = _strip_diacritics("بِسْمِ")  # بِسْمِ
    assert got == "بسم", repr(got)  # بسم


def test_full_phrase_keeps_all_letters():
    # بِسْمِ ٱللَّهِ ٱلرَّحِيمِ  ->  بسم الله الرحيم  (alef-wasla folded to plain alef)
    src = ("بِسْمِ "
           "ٱللَّهِ "
           "ٱلرَّحِيمِ")
    got = _strip_diacritics(src)
    assert got == "بسم الله الرحيم", repr(got)
    # The specific failure mode: the buggy class returned " ٱ ٱ" (2 chars + spaces).
    assert len(got) > 12, f"letters were stripped: {got!r}"


def test_every_arabic_letter_is_preserved():
    """No LETTER in U+0621-U+064A may be treated as a diacritic.

    U+0640 (tatweel) is excluded: it sits inside that range but is a formatting elongation
    character, not a letter, and is stripped deliberately (it is also in the JS reference class).
    """
    letters = "".join(chr(c) for c in range(0x0621, 0x064B) if c != 0x0640)
    assert _strip_diacritics(letters) == letters, "a letter was stripped"


def test_known_diacritics_are_removed():
    marks = [
        0x064B, 0x064C, 0x064D,          # tanwin
        0x064E, 0x064F, 0x0650,          # fatha/damma/kasra
        0x0651, 0x0652,                  # shadda, sukun
        0x0670,                          # superscript alef
        0x0640,                          # tatweel
        0x06D6, 0x06DA, 0x06DD, 0x06ED,  # quranic annotation marks
        0x0610, 0x061A,                  # honorific signs
        0xFEFF,                          # BOM
    ]
    for cp in marks:
        got = _strip_diacritics("ب" + chr(cp) + "س")
        assert got == "بس", f"U+{cp:04X} not stripped -> {got!r}"


def test_matches_the_js_reference_class():
    """The Python class must equal services/ml-inference/alignment.js:7 (plus the BOM).

    Two normalizers over the same scripture that disagree is the bug this whole file guards.
    """
    js = open("../ml-inference/alignment.js", encoding="utf-8").read()
    m = re.search(r"\.replace\(/\[([^\]]+)\]/g, \"\"\)", js)
    assert m, "could not find the JS diacritic class"
    js_ranges = set(re.findall(r"\\u([0-9A-Fa-f]{4})(?:-\\u([0-9A-Fa-f]{4}))?", m.group(1)))
    py_ranges = set(re.findall(r"\\u([0-9A-Fa-f]{4})(?:-\\u([0-9A-Fa-f]{4}))?", _MATCH.group(1)))
    py_ranges.discard(("feff", ""))
    py_ranges.discard(("FEFF", ""))
    norm = lambda s: {(a.lower(), b.lower()) for a, b in s}  # noqa: E731
    assert norm(js_ranges) == norm(py_ranges), f"JS {sorted(norm(js_ranges))} != PY {sorted(norm(py_ranges))}"


def test_mirror_matches_source():
    """This file's _strip_diacritics must stay behaviourally identical to the real one."""
    assert '.replace("\\u0671", "\\u0627")' in _SRC or 'replace("ٱ", "ا")' in _SRC, \
        "forced_align._strip_diacritics changed shape; update this mirror"


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  ok   {name}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
