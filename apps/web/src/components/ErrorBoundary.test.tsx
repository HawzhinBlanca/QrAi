// @vitest-environment jsdom
//
// P2.6 / P6.2: the last-resort unavailable state.
//
// `ErrorBoundary` wraps the entire app (App.tsx:79) and is the only thing between an uncaught
// render error and a blank white screen. It had no test at all — which is the worst place for that,
// because a broken error boundary is INVISIBLE until the day something else breaks. It fails at
// exactly the moment nothing else is working, and there is no second safety net behind it.
//
// Everything asserted here is a promise this component already makes to a learner. None of them
// were checked.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ErrorBoundary } from "./ErrorBoundary";

/** A child that throws during RENDER — the only kind of error a boundary can catch. */
function Boom({ message = "kaboom" }: { message?: string }): never {
  throw new Error(message);
}

function Fine() {
  return <p>the app is fine</p>;
}

describe("ErrorBoundary — the screen a learner sees when everything else has failed", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // React re-logs every caught render error, and `componentDidCatch` logs its own. Silenced so a
    // passing run is readable — NOT to hide failures: the assertions below never consult the console,
    // and the spy is restored after each test.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    act(() => root.unmount());
    container.remove();
  });

  const render = (children: React.ReactNode) => {
    act(() => root.render(<ErrorBoundary>{children}</ErrorBoundary>));
  };

  it("passes children through untouched when nothing is wrong", () => {
    // The control. Without it, every assertion below is satisfied by a boundary that shows the
    // error screen unconditionally — which would be a far worse bug than the one being guarded.
    render(<Fine />);
    expect(container.textContent).toContain("the app is fine");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("catches a render error instead of leaving a blank screen", () => {
    render(<Boom />);
    expect(container.textContent?.length, "the boundary rendered nothing — a learner sees white").toBeGreaterThan(0);
    expect(container.textContent).not.toContain("the app is fine");
  });

  it("announces itself to a screen reader rather than only appearing", () => {
    // A learner using a screen reader gets no notification that anything happened otherwise: the
    // content simply stops. `role="alert"` is what makes the failure perceivable rather than silent.
    render(<Boom />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert, "the recovery UI is not exposed as an alert").not.toBeNull();
    expect((alert?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("never shows a learner a raw translation key", () => {
    // The same defect class as MicNotice: i18next echoes the key back when a translation is missing,
    // so deleting `errorBoundary.title` would make a crashing app greet the learner with the literal
    // string "errorBoundary.title". This screen is the one place that mistake is most likely to
    // survive review, because almost nobody ever looks at it.
    render(<Boom />);
    // The alert must be asserted FIRST. Without this line the test passes when the boundary does not
    // render at all — there is no text, so there is no key in it — which a mutation run demonstrated
    // by removing `getDerivedStateFromError` and watching this one stay green while four others went
    // red. "No bad string present" is satisfied by "no string present"; the assertion has to require
    // that the screen exists before it can say anything useful about what is on it.
    const alert = container.querySelector('[role="alert"]');
    expect(alert, "no error screen rendered, so this test proves nothing about its copy").not.toBeNull();
    expect((alert?.textContent ?? "").length).toBeGreaterThan(0);
    expect(alert?.textContent ?? "").not.toMatch(/errorBoundary\./);
  });

  it("offers a way out, and the recovery action actually clears the error", () => {
    // "Try again" resetting state is the entire difference between a recoverable screen and a dead
    // end that only a page reload escapes.
    render(<Boom />);
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.length, "the error screen offers no action at all").toBeGreaterThan(0);

    const tryAgain = buttons[0];
    // Re-render with a healthy child first: clicking reset while the child still throws would
    // legitimately show the error again, and would tell us nothing about whether reset works.
    act(() => root.render(<ErrorBoundary><Fine /></ErrorBoundary>));
    act(() => tryAgain.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.textContent).toContain("the app is fine");
    expect(container.querySelector('[role="alert"]'), "the error screen survived its own reset").toBeNull();
  });

  it("keeps the technical detail collapsed behind a disclosure", () => {
    // The error message is developer text. It is legitimate to expose it — an operator sitting with
    // a learner needs it — but it must not be the thing a learner reads first, and an unbounded
    // message is exactly the kind of string that later grows a URL or an id nobody meant to show.
    render(<Boom message="TypeError: cannot read properties of undefined" />);
    const details = container.querySelector("details");
    expect(details, "the technical detail is not inside a disclosure").not.toBeNull();
    expect(details?.hasAttribute("open"), "technical detail is expanded by default").toBe(false);
  });
});
