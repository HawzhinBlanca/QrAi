// @vitest-environment jsdom
//
// P2.6 (permission / unavailable states) + honesty, for the banner that narrates what is happening
// during practice.
//
// `ModeBanner` carries three guarantees and TWO of them record regressions that actually shipped:
//
//   1. `mistakes` — "Real count of words flagged in this session's alignment — never a hardcoded
//      number... a previous version hardcoded 'three words' regardless of what actually happened."
//   2. `teacherSendState` — "claims 'sent' only when the backend confirmed it (a previous version
//      claimed it unconditionally)."
//   3. Precedence: a denied or unavailable microphone is announced INSTEAD of the practice banner,
//      whatever mode the learner is in.
//
// Both regressions are the same shape: telling a learner something about their own recitation that
// is not true. Neither was under test.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { MicState, PracticeMode } from "../types/practice";
import { ModeBanner, type TeacherSendState } from "./ModeBanner";

/**
 * The component's own prop type, not a retyped copy.
 *
 * A local string union plus `as never` at the call site would compile forever: rename a practice
 * mode and this fixture keeps passing against one the app no longer has. Same reason the
 * CompletePanel fixture stopped using a cast.
 */
type Mode = Exclude<PracticeMode, "home">;

describe("ModeBanner", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (
    overrides: {
      micState?: MicState;
      mode?: Mode;
      mistakes?: number;
      teacherSendState?: TeacherSendState;
      onCheckMic?: () => void;
      onSendToTeacher?: () => void;
    } = {},
  ) => {
    const {
      micState = "ready",
      mode = "guided-recite",
      mistakes = 0,
      teacherSendState = "idle",
      onCheckMic = () => {},
      onSendToTeacher = () => {},
    } = overrides;
    act(() =>
      root.render(
        <ModeBanner
          micState={micState}
          mode={mode}
          mistakes={mistakes}
          teacherSendState={teacherSendState}
          onCheckMic={onCheckMic}
          onSendToTeacher={onSendToTeacher}
        />,
      ),
    );
    return container;
  };

  it("announces every banner to a screen reader", () => {
    // Every branch returns `role="status"`. A learner who cannot see the banner is told what
    // happened; drop the role from one branch and that branch goes silent for them alone.
    for (const probe of [
      { micState: "denied" as MicState },
      { micState: "unavailable" as MicState },
      { mode: "correction" as Mode },
      { mode: "drill" as Mode },
      {},
    ]) {
      const el = render(probe).querySelector('[role="status"]');
      expect(el, `no status role for ${JSON.stringify(probe)}`).not.toBeNull();
      expect((el?.textContent ?? "").length).toBeGreaterThan(0);
    }
  });

  it("puts a denied microphone ahead of whatever mode the learner is in", () => {
    // Precedence, and it is the reason the mic checks sit first. In `drill` with a denied mic, a
    // learner told to "repeat the short phrase three times" cannot: nothing is listening.
    const text = render({ micState: "denied", mode: "drill" }).textContent ?? "";
    expect(text).toContain("Microphone access is denied");
    expect(text).not.toContain("repeat the short phrase");
  });

  it("offers a retry when the microphone was DENIED, and none when it is UNAVAILABLE", () => {
    // The distinction is the whole point of two states. Permission can be granted; missing hardware
    // cannot, and a Try-again button there sends a learner in a circle.
    const denied = render({ micState: "denied" });
    expect(denied.querySelector("button")).not.toBeNull();

    const unavailable = render({ micState: "unavailable" });
    expect(unavailable.textContent).toContain("unavailable");
    expect(
      unavailable.querySelector("button"),
      "an unavailable microphone offered a retry that cannot succeed",
    ).toBeNull();
  });

  it("calls back when the learner retries the microphone", () => {
    const onCheckMic = vi.fn();
    render({ micState: "denied", onCheckMic }).querySelector("button")!.click();
    expect(onCheckMic).toHaveBeenCalledTimes(1);
  });

  it("reports the REAL flagged-word count, never a fixed one", () => {
    // The shipped regression: the copy said "three words" regardless of what the alignment found.
    // Telling a learner three words need work when one did — or when none did — is a claim about
    // their recitation that is simply false.
    expect(render({ mode: "correction", mistakes: 1 }).textContent).toContain("1 word");
    expect(render({ mode: "correction", mistakes: 7 }).textContent).toContain("7 words");
  });

  it("says nothing was flagged rather than reporting zero words", () => {
    const text = render({ mode: "correction", mistakes: 0 }).textContent ?? "";
    expect(text).toContain("No flagged words");
    expect(text, "a zero count was rendered as if it were a finding").not.toMatch(/\b0 words?\b/);
  });

  it("claims a teacher was sent to ONLY when the backend confirmed it", () => {
    // The second shipped regression. `idle` matters most: it is the state before any send, so a
    // learner who has not sent anything must not be told it was sent.
    expect(render({ mode: "drill", teacherSendState: "sent" }).textContent).toContain(
      "Sent to your teacher",
    );
    for (const teacherSendState of ["idle", "failed", "nothing-to-send"] as const) {
      const text = render({ mode: "drill", teacherSendState }).textContent ?? "";
      expect(text, `${teacherSendState} claimed a successful send`).not.toContain(
        "Sent to your teacher",
      );
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("marks a failed send as a warning, not as ordinary practice copy", () => {
    // The only branch that changes the banner's class. Losing it makes a failure look exactly like
    // a normal drill instruction.
    expect(
      render({ mode: "drill", teacherSendState: "failed" }).querySelector(".warning"),
    ).not.toBeNull();
    expect(
      render({ mode: "drill", teacherSendState: "sent" }).querySelector(".warning"),
    ).toBeNull();
  });

  it("never shows a learner a raw translation key or an unfilled placeholder", () => {
    for (const probe of [
      { micState: "denied" as MicState },
      { micState: "unavailable" as MicState },
      { mode: "correction" as Mode, mistakes: 2 },
      { mode: "correction" as Mode, mistakes: 0 },
      { mode: "drill" as Mode, teacherSendState: "failed" as TeacherSendState },
      {},
    ]) {
      const text = render(probe).textContent ?? "";
      expect(text, `${JSON.stringify(probe)} leaked an i18n key`).not.toMatch(/modeBanner\./);
      expect(text, `${JSON.stringify(probe)} left a placeholder unfilled`).not.toMatch(/\{\{|\}\}/);
    }
  });
});
