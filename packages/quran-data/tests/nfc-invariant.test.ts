import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// MIG4 — the NFC invariant, as an executable trap.
//
// The shipped corpus is deliberately NOT in Unicode NFC. These tests assert that it STAYS that way.
// They are a tripwire, not a goal: if one fails, some layer upstream began normalizing Quranic text
// and the correct response is to find and remove that call, never to update the expectation here.
//
// Why it matters: services/asr-inference/server.py:626-632 pattern-matches the raw
// consonant+shadda+vowel ordering to detect ghunnah, and every canonical checksum is computed over
// the shipped bytes. NFC silently reorders shadda (U+0651, ccc=33) after a vowel like fatha
// (U+064E, ccc=30) in 5,771 of 6,236 ayahs — no exception, no warning, just different text.
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/nfc-vectors.json", import.meta.url)), "utf8"),
) as { vectors: { ref: string; shipped: number[]; nfc: number[] }[] };

const toStr = (cps: number[]) => String.fromCodePoint(...cps);

describe("NFC invariant — the corpus must stay byte-exact as shipped", () => {
  it("has vectors (an empty fixture would pass every test below vacuously)", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
  });

  it("every vector is NFC-UNSTABLE — this is the tripwire", () => {
    for (const v of fixture.vectors) {
      const shipped = toStr(v.shipped);
      expect(shipped.normalize("NFC"), `${v.ref}: corpus text is now NFC-stable — did something upstream normalize it?`).not.toBe(shipped);
    }
  });

  it("normalizing produces exactly the recorded NFC form (pins the transform, not just that it differs)", () => {
    for (const v of fixture.vectors) {
      expect(toStr(v.shipped).normalize("NFC"), v.ref).toBe(toStr(v.nfc));
    }
  });

  it("the shipped text still contains shadda directly after a consonant, before its vowel", () => {
    // The specific ordering the Python ghunnah patterns rely on. If NFC ever ran, shadda would
    // have moved after the vowel and this is the assertion that catches it.
    const SHADDA = 0x0651;
    const found = fixture.vectors.some((v) => {
      const i = v.shipped.indexOf(SHADDA);
      if (i <= 0) return false;
      const next = v.shipped[i + 1];
      // fatha/damma/kasra and their tanwin forms
      return next !== undefined && next >= 0x064b && next <= 0x0650;
    });
    expect(found, "no vector has shadda-before-vowel; the fixture no longer guards the ordering").toBe(true);
  });

  it("the shipped corpus is still NFC-unstable at scale, not just these three vectors", () => {
    // Reads the shipped JSON directly rather than going through the bundle builders: this asserts
    // a property of the DATA, so it must not depend on the shape of any API that wraps it.
    const dir = fileURLToPath(new URL("../src/data/full-quran", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    let total = 0;
    let unstable = 0;
    for (const f of files) {
      const parsed = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as
        | { ayahs?: { text?: string }[] }
        | { text?: string }[];
      const ayahs = Array.isArray(parsed) ? parsed : (parsed.ayahs ?? []);
      for (const a of ayahs) {
        const t = a.text;
        if (!t) continue;
        total += 1;
        if (t !== t.normalize("NFC")) unstable += 1;
      }
    }

    expect(total, "no ayah text found — the corpus layout changed").toBeGreaterThan(6000);
    // Measured at the time of writing: 5,771 of 6,236. Asserting a wide floor rather than the
    // exact number keeps this from failing on a legitimate corpus correction, while still
    // catching a wholesale normalization of the data.
    expect(unstable / total).toBeGreaterThan(0.8);
  });
});
