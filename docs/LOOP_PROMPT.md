# The 10/10 loop

Run with `/loop <interval> <the prompt below>`, or paste the prompt as-is.

It is deliberately short. Every line in it was earned by a real defect in this repository — the
rationale is in `## Why each line is there` at the bottom, which the loop itself does not need to
read.

---

## The prompt

```
Drive QrAi to a real 10/10 — ONE defect per iteration, proven, backend and frontend alike.

SELECT (one, then stop selecting)
Pick the weakest EVIDENCE, not the weakest code. In order:
  1. A guarantee the code makes that no test can break. Best signal: a comment explaining
     why something matters, next to no test that fires when you remove it.
  2. An open row in specs/readiness-recovery-10-10/tasks.md with an engineering half
     nobody has done. Read the row's own words, not the summary.
  3. A learner-visible path with no coverage of its unavailable / loading / offline /
     permission / timeout state, its RTL layout, or its screen-reader semantics.
Alternate backend and frontend across iterations so neither rots.
Anything needing a human signature — scholar, SRE, security, privacy, legal, pilot,
device, keystore — is NOT yours. Record it precisely and move on.

MEASURE
Reproduce before you explain. Run it, curl it, query the DB, screenshot the page.
Never state a cause you have not observed. If a claim is cheap to check, check it.

PROVE THE TEST CAN FAIL
Write the oracle first. Then break the thing it guards and watch it go RED, restore it and
watch it go GREEN. A test that has never been red is not evidence, it is decoration.
Report the mutation you ran.

CHANGE
Smallest correct change. No refactor riding along. If you find a second defect, write it
down and finish the first.

DONE
`bash scripts/verify.sh` exits 0, then CI is green. Never your own judgment.
Flip a ledger row only via its documented path, and only when both are true.

NEVER
- Weaken, skip, delete or loosen a test to get green.
- Invent results, evidence, approvals, timings, or numbers.
- Normalize canonical Quran text, or any string derived from it.
  Arabic character classes use \u escapes, never literal combining marks.
- Emit learner-facing AI output without source, confidence and approval gates.
- Log raw audio, tokens, secrets, or learner PII.
- Touch .env*, secrets/**, *.pem, keystores — or generate any credential.
- Drop tenant RLS from a tenant-owned query.

THE DEFECT THIS CODEBASE ACTUALLY HAS
Guards that pass for the wrong reason. A gate wired but never run. An assertion a constant
satisfies. A check the compiler already made. A field only ever observed as null. A branch
that fails OPEN on input it cannot parse. A pin on today's state dressed as an invariant.
Whenever you meet a guard, ask: "what exactly would make this red?" If the answer is
nothing, you have found the work.

REPORT EACH ITERATION
What you measured · what it actually was · the mutation that proved the test ·
what you did NOT close, and why.
Corrections beat consistency: if an earlier claim of yours was wrong, say so and move on.

STOP
When every remaining row needs a person, say that plainly and stop. Do not manufacture work.
```

---

## Why each line is there

Not commentary — each is a defect this repository actually had.

| Line | The defect that earned it |
|---|---|
| *weakest evidence, not weakest code* | Twelve rows read "engineering in place". A third of them weren't. The code looked finished; the evidence never existed. |
| *a comment explaining why something matters, next to no test* | The HTTP client carried a paragraph on why a hung ML upstream must not block a request. The timeout was real. **Nothing had ever fired it.** |
| *read the row's own words* | "P4.4 names a licence gate" — the gate did not exist. The summary said the phase was fine. |
| *alternate backend and frontend* | `MicNotice` covered all five microphone states and had no test at all, while backend work absorbed every iteration. |
| *reproduce before you explain* | A confident RTL bug report did not reproduce; measurement showed `dir: "ltr"`. Another: base64 was blamed for a stall that measurement put at 2.8 ms of 80 ms. |
| *prove the test can fail* | A confidentiality assertion **passed with the encryption replaced by `cat`** — gzip had hidden the marker. It was written the same hour. |
| *report the mutation* | Removing an upstream timeout does not make the suite fail. It makes it hang until the runner kills it. Only running the mutation says so. |
| *smallest change* | — |
| *never your own judgment* | The house rule. Local green and CI green are different claims; for a day, CI was not running at all. |
| *never weaken a test* | The tempting fix is always the assertion, not the bug. |
| *never invent evidence* | The one failure with no recovery: fabricated proof is worse than no proof, and it is invisible. |
| *fails OPEN on input it cannot parse* | The learner gate forwarded, unredacted, any `findings` it could not inspect. A marker string put in an ML response came back in the learner's payload. |
| *a pin dressed as an invariant* | A locale check verified English and stopped there — correct today, and it stops working the day someone does the real work. |
| *corrections beat consistency* | "Key custody is the owner's decision" was true of symmetric encryption and wrong here. A public-key envelope removed the question entirely, and the deferral had inherited a constraint nobody examined. |
| *do not manufacture work* | Most of what remains needs a scholar, an SRE, a security assessor, or a device. An agent that keeps going invents work to justify running. |
