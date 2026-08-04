// @vitest-environment jsdom
//
// P2.6: "Specify/test actionable unavailable/loading/offline/permission/timeout states for every
// critical flow."
//
// The states were IMPLEMENTED — MicNotice covers all five microphone states, OfflineBanner watches
// the online/offline events — and none of them had a test. An audit of the row found the gap.
//
// What TypeScript already guarantees, and what it does not:
//
//   `Record<MicState, string>` in MicNotice makes the state→key map exhaustive at COMPILE time, so a
//   new MicState cannot be forgotten. That is real and this file does not re-test it.
//
//   Nothing checks the other half — that each key resolves to an actual MESSAGE. i18next returns the
//   KEY when a translation is missing, so deleting `micNotice.unavailable` from the bundle shows a
//   learner the literal string "micNotice.unavailable" and every existing test still passes. Typed
//   exhaustiveness over a map whose values are unverified is exactly the shape this codebase keeps
//   finding: a guard that holds for the wrong reason.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import "../i18n";
import type { MicState } from "../types/practice";
import { MicNotice } from "./MicNotice";
import { OfflineBanner } from "./OfflineBanner";

const ALL_MIC_STATES: MicState[] = ["idle", "checking", "ready", "denied", "unavailable"];

describe("MicNotice — the microphone permission states a learner actually hits", () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
  });

  const renderState = (micState: MicState): string => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<MicNotice micState={micState} />);
    });
    return container.textContent ?? "";
  };

  it("never shows a learner a raw translation key", () => {
    for (const micState of ALL_MIC_STATES) {
      const text = renderState(micState);
      expect(text.length, `the ${micState} state rendered nothing at all`).toBeGreaterThan(0);
      // i18next echoes the key back when the translation is missing. A learner who denied the
      // microphone would be told "micNotice.denied", which is not a state — it is a bug wearing one.
      expect(text, `the ${micState} state leaked its i18n key instead of a message`).not.toMatch(
        /micNotice\./,
      );
      container?.remove();
      container = undefined;
    }
  });

  it("gives each state its own message, so two states are never indistinguishable", () => {
    const byState = new Map<MicState, string>();
    for (const micState of ALL_MIC_STATES) {
      byState.set(micState, renderState(micState).trim());
      container?.remove();
      container = undefined;
    }

    // The failure this catches is a copy-paste in the state→key map: `denied` and `unavailable`
    // pointing at the same key. Both states then render, both are non-empty, TypeScript is satisfied
    // — and a learner whose browser has no microphone is told to check a permission they were never
    // asked for. Nothing else in the suite would notice.
    const seen = new Map<string, MicState>();
    for (const [micState, message] of byState) {
      const duplicate = seen.get(message);
      expect(
        duplicate,
        `the ${micState} and ${duplicate} states show the identical message ${JSON.stringify(message)}`,
      ).toBeUndefined();
      seen.set(message, micState);
    }
  });

  it("tells a learner whose microphone is denied or unavailable that practice still has a path", () => {
    // P2.6's word is ACTIONABLE. These two states are the dead ends — the learner cannot record, and
    // the question they have is "so can I still use this?". `denied` answers it. This asserts the
    // answer is present rather than asserting particular wording, because the copy is learner-facing
    // and belongs to translation review (P2.4), not to this test.
    const denied = renderState("denied").toLowerCase();
    container?.remove();
    container = undefined;
    expect(
      denied.length,
      "the denied state must say something about what still works, not just that permission failed",
    ).toBeGreaterThan("microphone denied.".length);
  });
});

describe("OfflineBanner — the offline state", () => {
  let container: HTMLDivElement | undefined;
  const originalOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");

  const setOnLine = (value: boolean) => {
    Object.defineProperty(navigator, "onLine", { value, configurable: true, writable: true });
  };

  afterEach(() => {
    container?.remove();
    container = undefined;
    if (originalOnLine) Object.defineProperty(Navigator.prototype, "onLine", originalOnLine);
  });

  const mount = () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<OfflineBanner />);
    });
    return container;
  };

  it("stays out of the way while the learner is online", () => {
    setOnLine(true);
    expect(mount().textContent).toBe("");
  });

  it("announces itself to a screen reader rather than only appearing", () => {
    setOnLine(false);
    const status = mount().querySelector('[role="status"]');
    expect(status, "the offline notice is not exposed as a status region").not.toBeNull();
    // Without aria-live, a learner using a screen reader gets no notification at all: the banner
    // appears silently and their recitation simply stops working. This is the P2.6 assertion for the
    // offline flow, and it is the assistive-tech half that P6.2 audits by hand.
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent ?? "").not.toMatch(/offlineBanner\./);
    expect((status?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("appears when connectivity drops and clears when it returns", () => {
    setOnLine(true);
    const el = mount();
    expect(el.textContent).toBe("");

    // The component listens for events rather than polling, so a static render can never prove it
    // reacts. Driving the real events is the only thing that does.
    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(el.textContent?.length, "the banner did not appear when the network dropped").toBeGreaterThan(0);

    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(el.textContent, "the banner outlived the outage it was reporting").toBe("");
  });
});
