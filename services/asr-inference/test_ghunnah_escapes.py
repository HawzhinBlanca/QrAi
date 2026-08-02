"""The ghunnah regexes must use `\\u` escapes, and must still detect the same thing.

    python test_ghunnah_escapes.py

AGENTS.md: "Arabic regex character classes must use `\\u` escapes, never literal combining marks."
A combining mark inside `[...]` renders on top of the bracket, sorts unpredictably, and can be
reordered or dropped by any tool that touches the file. In PR #258 a literal class in
`forced_align.py` merged two ranges, deleted every Arabic letter, and passed human review.

So this file asserts two different things, and it needs both:

1. **Equivalence** — the escaped patterns still flag exactly the words the literal ones flagged.
   An escape that is correct but wrong about which codepoint it names is a silent behaviour change
   in the code that decides whether to tell a learner they mispronounced the Qur'an.
2. **The rule, as a gate** — no regex anywhere in `server.py` may contain a literal Arabic
   combining mark again. Equivalence alone would let the next edit reintroduce one.

── What this is, and is not ────────────────────────────────────────────────────────────────────
Importing `server.py` pulls in fastapi and torch, which every suite in this directory deliberately
avoids so they run anywhere (see `test_forced_align_normalization.py`). So the patterns are lifted
out of the source and compiled here. That is real behavioural proof of the patterns themselves,
but it does not exercise the surrounding audio-feature branch (`f0_std > 10`).

Every Arabic string below is written by codepoint for the same reason the source is: a test whose
own literals can be mangled in transit cannot prove anything about mangled literals.
"""
import re
import sys

SRC = open("server.py", encoding="utf-8").read()

# ── Codepoints under test ────────────────────────────────────────────────────────────────────────────
NOON, MEEM = "\u0646", "\u0645"
SHADDA, SUKUN = "\u0651", "\u0652"
FATHATAN, DAMMATAN, KASRATAN = "\u064B", "\u064C", "\u064D"
FATHA, DAMMA, KASRA = "\u064E", "\u064F", "\u0650"
ALIF, WAW, YEH, RA = "\u0627", "\u0648", "\u064A", "\u0631"
LAM, AYN, HAMZA_I = "\u0644", "\u0639", "\u0625"

failures = []


def check(name, ok, detail=""):
    if ok:
        print(f"  ok   {name}")
    else:
        failures.append(name)
        print(f"  FAIL {name}{(' — ' + detail) if detail else ''}")


print("ghunnah regex escapes:")

# ── 1. Lift the three patterns out of the has_ghunnah block ─────────────────────────────────────
_block = re.search(r"has_ghunnah = \((.*?)\n        \)", SRC, re.S)
check("the has_ghunnah block is still shaped as expected", _block is not None)
if _block is None:
    print("\n1 failed")
    sys.exit(1)

patterns = re.findall(r're\.search\("((?:[^"\\]|\\.)*)"', _block.group(1))
check("all three ghunnah patterns were found", len(patterns) == 3, f"found {len(patterns)}")

# The source writes them as `\uXXXX` inside a normal Python string, so Python has already resolved
# them by the time the module runs. Do the same here rather than handing `re` the raw backslashes.
compiled = [re.compile(p.encode().decode("unicode_escape")) for p in patterns]


def has_ghunnah(word):
    return any(c.search(word) for c in compiled)


# ── 2. Equivalence: the same words in, the same answers out ─────────────────────────────────────
# `matches` mirrors the three documented triggers; the non-matches are the false positives the
# original comment says this gate exists to avoid.
CASES = [
    # (word, expected, why)
    (HAMZA_I + NOON + SHADDA + FATHA, True, "inna — noon + shadda"),
    (MEEM + KASRA + NOON + SUKUN, True, "min — noon + sukoon"),
    (MEEM + SHADDA + FATHA, True, "meem + shadda"),
    (AYN + FATHA + LAM + KASRA + YEH + MEEM + DAMMATAN, True, "aleemun — tanween"),
    (MEEM + KASRA + NOON, True, "min at waqf — word-final noon"),
    (NOON + DAMMA + WAW + RA, False, "noor — a MOVING noon carries no ghunnah"),
    (MEEM + FATHA + LAM + KASRA + YEH + KASRA + LAM, False, "no noon/meem-sakin, no tanween"),
    (ALIF + LAM + HAMZA_I, False, "no noon, no meem, no tanween"),
]
for word, expected, why in CASES:
    check(
        f"{'flags' if expected else 'ignores'}: {why}",
        has_ghunnah(word) is expected,
        f"got {has_ghunnah(word)}, expected {expected}",
    )

# ── 3. The rule, as a gate ──────────────────────────────────────────────────────────────────────
# Arabic combining marks: harakat/tanween (U+064B..U+065F), superscript alef (U+0670),
# and Qur'anic annotation marks (U+06D6..U+06ED).
COMBINING = re.compile("[\\u064B-\\u065F\\u0670\\u06D6-\\u06ED]")
offenders = [
    (i, line.strip()[:90])
    for i, line in enumerate(SRC.splitlines(), 1)
    if re.search(r"re\.(search|match|fullmatch|compile|sub|subn|split|findall|finditer)\(", line)
    and COMBINING.search(line)
]
check(
    "no regex in server.py contains a literal Arabic combining mark",
    not offenders,
    "; ".join(f"line {i}: {t}" for i, t in offenders),
)

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
