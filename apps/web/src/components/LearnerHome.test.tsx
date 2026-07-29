// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("LearnerHome unavailable/error states (P2.6 — actionable + accessible)", () => {
  let container: HTMLDivElement;
  afterEach(() => container?.remove());

  it("surfaces an actionable, keyboard-focusable Retry control when the platform is unreachable", async () => {
    const onRetry = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <LearnerHome
          {...baseProps({
            platformOffline: true,
            apiError: "Could not reach the platform API. Please try again.",
            onRetry,
          })}
        />,
      );
    });

    // A real <button> (focusable, Enter/Space-activatable) — not a div-onClick dead-end (P2.1/P2.6).
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.tagName).toBe("BUTTON");
    // Non-empty accessible name (derived from its text content).
    expect(button?.textContent?.trim()).toBeTruthy();

    await act(async () => {
      button?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("announces a (non-offline) data-load error via role=alert so it is not silent", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<LearnerHome {...baseProps({ apiError: "boom-error-xyz" })} />);
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("boom-error-xyz");
  });
});
