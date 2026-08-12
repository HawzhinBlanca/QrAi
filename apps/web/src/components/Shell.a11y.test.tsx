// @vitest-environment jsdom
//
// P6.2 — axe automation for the app shell: the chrome every role sees on every screen.
//
// A violation here is multiplied by every page, which is why these go first. None of these
// components had ever been scanned.
import { afterEach, describe, expect, it } from "vitest";

import "../i18n";
import { seriousViolations } from "../test-utils/axe";
import { BrandMark } from "./BrandMark";
import { ErrorBoundary } from "./ErrorBoundary";
import { LoginScreen } from "./LoginScreen";
import { MicNotice } from "./MicNotice";
import { ModeBanner } from "./ModeBanner";
import { OfflineBanner } from "./OfflineBanner";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { AuthProvider } from "../lib/auth";
import type { MicState } from "../types/practice";

const MIC_STATES: MicState[] = ["idle", "checking", "ready", "denied", "unavailable"];

afterEach(() => {
  document.body.innerHTML = "";
});

describe("app shell accessibility (axe automation)", () => {
  // Non-vacuity. Every assertion in this file and its siblings is `toEqual([])`, which an empty
  // container, a harness that silently rendered nothing, or a misconfigured ruleset all satisfy.
  // This proves the harness still reports a real violation before any of them is believed.
  it("the axe harness reports a violation when one exists", async () => {
    const found = await seriousViolations(
      <button type="button">
        <img alt="" src="data:," aria-hidden="false" />
      </button>,
    );
    expect(found.join(" ")).toContain("button-name");
  });

  it("BrandMark has no serious/critical violations", async () => {
    expect(await seriousViolations(<BrandMark />)).toEqual([]);
  });

  it("TopBar has no serious/critical violations", async () => {
    expect(
      await seriousViolations(
        <TopBar
          title="Practice"
          trustLabel="Pilot"
          activeLanguage="en"
          onLanguageChange={() => {}}
          displayName="Amina Yusuf"
          roleLabel="Learner"
          onLogout={() => {}}
        />,
      ),
    ).toEqual([]);
  });

  // Every role, because Sidebar filters its nav list by role — auditing only the default would
  // leave the learner's and teacher's actual navigation unscanned.
  for (const userRole of ["learner", "teacher", "scholar", "admin"]) {
    it(`Sidebar has no serious/critical violations for role ${userRole}`, async () => {
      expect(
        await seriousViolations(
          <Sidebar activeSection="learner" onSectionChange={() => {}} userRole={userRole} />,
        ),
      ).toEqual([]);
    });
  }

  // Every mic state, because ModeBanner returns a DIFFERENT tree for `denied` — the branch a
  // learner who refused the microphone actually sees.
  for (const micState of MIC_STATES) {
    it(`ModeBanner has no serious/critical violations in mic state ${micState}`, async () => {
      expect(
        await seriousViolations(
          <ModeBanner
            micState={micState}
            mode="guided-recite"
            mistakes={3}
            teacherSendState="idle"
            onCheckMic={() => {}}
            onSendToTeacher={() => {}}
          />,
        ),
      ).toEqual([]);
    });
  }

  for (const micState of MIC_STATES) {
    it(`MicNotice has no serious/critical violations in mic state ${micState}`, async () => {
      expect(await seriousViolations(<MicNotice micState={micState} />)).toEqual([]);
    });
  }

  // OfflineBanner renders null when online, so the audit has to force the offline branch — the
  // whole point of the component. Auditing the online case would scan an empty container and pass
  // while the banner a disconnected learner sees stayed unchecked.
  it("OfflineBanner has no serious/critical violations while offline", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      expect(await seriousViolations(<OfflineBanner />)).toEqual([]);
    } finally {
      if (descriptor) Object.defineProperty(Navigator.prototype, "onLine", descriptor);
    }
  });

  // The recovery UI, not the happy path: a boundary that is accessible only while nothing has gone
  // wrong is accessible only when it does not matter.
  it("ErrorBoundary has no serious/critical violations in its caught-error state", async () => {
    function Explodes(): never {
      throw new Error("audit: forced render failure");
    }
    const consoleError = console.error;
    console.error = () => {}; // React logs the caught boundary error; not a test signal.
    try {
      expect(
        await seriousViolations(
          <ErrorBoundary>
            <Explodes />
          </ErrorBoundary>,
        ),
      ).toEqual([]);
    } finally {
      console.error = consoleError;
    }
  });

  it("LoginScreen has no serious/critical violations", async () => {
    expect(
      await seriousViolations(
        <AuthProvider>
          <LoginScreen />
        </AuthProvider>,
      ),
    ).toEqual([]);
  });
});
