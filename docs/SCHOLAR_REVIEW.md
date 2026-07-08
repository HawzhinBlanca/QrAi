# Scholar review packet — tajweed engine (A1 / A3)

> **Purpose.** This is the turnkey packet a qualified scholar of tajweed (mujawwid / qāriʾ with
> ijāzah) needs to review and sign off the rule-based tajweed engine before its output may be treated
> as authoritative. It is **not** a ruling — it states exactly what the engine detects and where it
> simplifies, and asks specific questions. Nothing here substitutes for the scholar's judgment.
>
> **Context that bounds the risk.** Every AI/engine-generated tajweed note is already gated: it is
> shown to a learner only as **"AI suggestion · not yet reviewed"** until a human reviewer approves it
> (`canShowLearnerFacingAiOutput` in `packages/contracts`, mirrored in `services/agents/lib/gate.mjs`).
> Findings carry `severity: "practice"` — they are practice prompts, not fatwa. The questions below ask
> whether that framing is sufficient for each simplification, or whether a rule must be corrected,
> relabelled, or withheld.

Source of truth for the rules: [`services/ml-inference/tajweed.js`](../services/ml-inference/tajweed.js).
Each rule emits `{ rule, arabicName, category, severity: "practice", explanation, confidence, sources }`.

---

## 1. Per-word rules

| Rule | Fires when the word contains… | Known simplification |
|------|-------------------------------|----------------------|
| **madd-tabii** (مد طبيعي) | fatḥa+alif `َا`, ḍamma+wāw `ُو`, or kasra+yāʾ `ِي` | Detects natural madd only. Does **not** distinguish madd types (muttaṣil / munfaṣil / ʿiwaḍ / badal / lāzim) and does **not** assert a count beyond "two counts". |
| **madd (dagger alif)** (مد) | dagger alif `ٰ` (U+0670) | Flags the dagger-alif elongation (e.g. in `هَٰذَا`, `ٱللَّٰه`). Labelled `madd-maleki` in code — **please confirm the correct term**; the engine only flags presence + "hold two counts". |
| **ghunnah** (غنة) | nūn+sukūn `نْ`, word-final bare nūn `…ن`, or tanwīn `ـً ـٍ ـٌ` | Coarse: flags the nasalisation site without stating duration or the following-letter context that actually governs it (that is handled separately by the inter-word rules below). |
| **qalqalah** (قلقلة) | one of ق ط ب ج د carrying sukūn `ْ` | The five qalqalah letters (quṭb jad). Does not grade minor/major qalqalah. |
| **tafkhīm** (تفخيم) | presence of one of خ ص ض ط ظ ق | Fires on **six of the seven ḥurūf al-istiʿlāʾ by presence**, not context — **غ (ghayn) is currently missing** from the engine's letter set (see Question A1-2). Does **not** handle the context-dependent tafkhīm/tarqīq of **rāʾ (ر)** or the **lām of the name Allah**. *(An earlier version of this row said "seven" while both the row and the code list six — corrected so the packet is honest before review.)* |
| **shaddah** (شدة) | shadda `ّ` (U+0651) | Flags consonant doubling. See the open gap below re: nūn/mīm mushaddad. |

### Open gap (currently withheld, not wrongly shown)
- **nūn / mīm mushaddad ghunnah** (e.g. `إِنَّ`, `ثُمَّ`): the engine currently reports only *shaddah*, **not**
  the obligatory ghunnah on a mushaddad nūn/mīm. It is deliberately **not implemented** and is flagged
  in the test suite as awaiting this review (`services/ml-inference/tajweed.test.mjs`, marked `todo`).
  **Question A1-1:** should mushaddad ghunnah be added as a `severity: "practice"` finding for نّ/مّ, and
  is the two-count ghunnah framing correct?

## 2. Inter-word rules (nūn sākinah / tanwīn → next word's first letter)

| Rule | Next letter | Note |
|------|-------------|------|
| **idghām** (إدغام) | one of ي ر م ل و ن | Does **not** distinguish idghām **with** ghunnah (ي ن م و) from **without** (ل ر). |
| **iqlāb** (إقلاب) | ب | Convert nūn/tanwīn → mīm before bāʾ. |
| **ikhfāʾ** (إخفاء) | ت ث ج د ذ ز س ش ص ض ط ظ ف ق ك | The fifteen ikhfāʾ letters. |

Uthmānī-text handling the scholar should be aware of: the engine treats a **bare word-final nūn** as
sākin (the mushaf writes particles مِن/عَن/أَن etc. with a bare nūn), strips trailing annotation marks
(U+06D6–U+06ED), and matches on the next word's first **consonant** after removing ḥarakāt.

---

## Questions to sign off (each maps to an automated test once answered)

1. **A1 — detection correctness.** For each rule above, is the *site* it fires on doctrinally correct
   for Ḥafṣ ʿan ʿĀṣim? (Where it fires, not how long to hold.)
2. **A1 — acceptable simplifications.** Are these acceptable for a **practice-assist** tool whose output
   is human-review-gated and labelled provisional: (a) madd types not distinguished; (b) tafkhīm on
   presence, with rāʾ and the lām of Allah **not** handled; (c) idghām not split into with/without
   ghunnah; (d) mushaddad ghunnah currently withheld?
3. **A1-1 — mushaddad ghunnah.** Add it (نّ/مّ, two counts) or keep withheld?
4. **A1-2 — ghayn (غ) in tafkhīm.** The engine detects tafkhīm on six of the seven ḥurūf
   al-istiʿlāʾ — غ is currently missing. Should غ be added to the detection set (making it the
   classical seven: خ ص ض غ ط ق ظ), or is its omission acceptable for a practice-assist tool?
5. **A3 — labelling.** Is **"AI suggestion · not yet reviewed"** + human-review-before-authoritative +
   `severity: "practice"` a sufficient and honest frame for a learner? If not, what wording/gating is
   required?
6. **Withhold list.** Are there any rules above that must **not** be shown to a learner at all (even
   provisionally) until corrected?

**Sign-off.** When satisfied, the reviewing scholar records name + ijāzah/qualification + date, and the
answers to 1–6, in `docs/DECISIONS.md` (an ADR). That ADR — not this file — is the record that clears
A1/A3. Any rule the scholar rejects is removed or corrected and its test updated before release.
