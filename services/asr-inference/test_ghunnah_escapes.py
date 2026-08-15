"""Retirement gate for the former signal-presence Tajweed heuristic.

The old ghunnah/F0/energy route was unsafe learner authority. W1.10 replaces it with a private,
reference-aware shadow endpoint and retains the invisible-character regex invariant.
"""

import re
import sys

SRC = open("server.py", encoding="utf-8").read()
failures = []


def check(name, ok, detail=""):
    if ok:
        print(f"  ok   {name}")
    else:
        failures.append(name)
        print(f"  FAIL {name}{(' — ' + detail) if detail else ''}")


print("retired acoustic heuristic boundary:")
check("the public heuristic route is absent", '"/v1/analyze-tajweed"' not in SRC)
for retired in (
    "_analyze_tajweed_words_sync",
    "TajweedWordFinding",
    "qrai-audio-tajweed-heuristics@0.1",
    "detect_pitch_frequency",
    "spectral centroid",
):
    check(f"retired symbol/text is absent: {retired}", retired not in SRC)

check(
    "the private shadow observation route exists",
    '"/v1/acoustic-tajweed:observe"' in SRC,
)
check(
    "the private response has no learner finding field",
    "class AcousticObservationResponse" in SRC
    and "findings: list" not in SRC[SRC.index("class AcousticObservationResponse"):],
)

COMBINING = re.compile("[\u064B-\u065F\u0670\u06D6-\u06ED]")
offenders = [
    (line_number, line.strip()[:90])
    for line_number, line in enumerate(SRC.splitlines(), 1)
    if re.search(r"re\.(search|match|fullmatch|compile|sub|subn|split|findall|finditer)\(", line)
    and COMBINING.search(line)
]
check(
    "no regex in server.py contains a literal Arabic combining mark",
    not offenders,
    "; ".join(f"line {line_number}: {text}" for line_number, text in offenders),
)

print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
