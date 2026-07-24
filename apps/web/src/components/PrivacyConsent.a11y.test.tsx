// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import "../i18n";
import type { RecitationConsent } from "../lib/api";
import { ConsentPanel } from "./ConsentPanel";
import { PrivacySettings } from "./PrivacySettings";

const consent: RecitationConsent = {
  recordingConsent: false,
  audioRetention: "discard",
  anonymizedLearning: false,
  externalAsrProcessing: false,
  guardianApproved: false,
  consentVersion: "pilot-v1",
};

async function seriousViolations(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  container.remove();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help}`);
}

// P2.5/P6.2/P2.6 — extend axe automation to the consent + privacy self-service flows (both
// learner-facing and sensitive). color-contrast is deferred to the manual P6.2 visual pass.
describe("consent + privacy accessibility (axe automation)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("ConsentPanel has no serious/critical axe violations", async () => {
    expect(await seriousViolations(<ConsentPanel consent={consent} onConsentChange={() => {}} />)).toEqual([]);
  });

  it("PrivacySettings has no serious/critical axe violations", async () => {
    expect(
      await seriousViolations(
        <PrivacySettings tenantId="hikmah-pilot-erbil" userId="learner-1" authToken={undefined} />,
      ),
    ).toEqual([]);
  });
});
