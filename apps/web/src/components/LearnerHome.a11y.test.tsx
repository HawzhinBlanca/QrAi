// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import "../i18n";
import type { RecitationConsent, SurahInfo } from "../lib/api";
import { LearnerHome, type LearnerHomeProps } from "./LearnerHome";

const consent: RecitationConsent = {
  recordingConsent: false,
  audioRetention: "discard",
  anonymizedLearning: false,
  externalAsrProcessing: false,
  guardianApproved: false,
  consentVersion: "pilot-v1",
};
const surah: SurahInfo = { surahNumber: 1, ayahCount: 7, name: "Al-Fatihah" };

function baseProps(overrides: Partial<LearnerHomeProps> = {}): LearnerHomeProps {
  return {
    micState: "idle",
    onCheckMic: () => {},
    onStartPractice: () => {},
    memorizationPlan: null,
    progress: null,
    consent,
    onConsentChange: () => {},
    surahList: [surah],
    selectedSurah: surah,
    onSelectSurah: () => {},
    apiError: null,
    platformOffline: false,
    onRetry: () => {},
    ...overrides,
  };
}

// P2.5 — accessibility automation. Runs axe-core over the rendered learner home (its richest surface:
// headings, the practice-surah <select>, the consent checkbox group, the mastery summary). Asserts no
// serious/critical violations. `color-contrast` is disabled because it needs real layout, which jsdom
// does not compute (that dimension is a P6.2 manual/visual pass); the structural/semantic/label rules
// that catch the common regressions DO run here.
describe("LearnerHome accessibility (P2.5 — axe automation)", () => {
  let container: HTMLDivElement;
  afterEach(() => container?.remove());

  async function violations(props: LearnerHomeProps) {
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<LearnerHome {...props} />);
    });
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  }

  it("has no serious/critical axe violations on the learner home", async () => {
    const serious = await violations(baseProps());
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("has no serious/critical axe violations in the offline/error state", async () => {
    const serious = await violations(
      baseProps({ platformOffline: true, apiError: "Could not reach the platform API." }),
    );
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
