// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { actorHeaders } from "../data/platform";
import {
  getPilotCsrf,
  getPilotIdentity,
  isPilotMode,
  setPilotIdentity,
  type PilotIdentity,
} from "./pilotSession";

const SAMPLE: PilotIdentity = {
  userId: "learner-42",
  tenantId: "hikmah-pilot-erbil",
  displayName: "Pilot Learner",
  role: "learner",
  csrfToken: "csrf-abc-123",
};

afterEach(() => {
  setPilotIdentity(null);
  if (typeof localStorage !== "undefined") localStorage.clear();
});

describe("pilotSession", () => {
  it("is inactive by default", () => {
    expect(isPilotMode()).toBe(false);
    expect(getPilotIdentity()).toBeNull();
    expect(getPilotCsrf()).toBeNull();
  });

  it("activates and mirrors to localStorage once an identity is set", () => {
    setPilotIdentity(SAMPLE);
    expect(isPilotMode()).toBe(true);
    expect(getPilotCsrf()).toBe("csrf-abc-123");
    expect(localStorage.getItem("qrai-pilot-session")).toContain("learner-42");
  });

  it("clears state and storage on null", () => {
    setPilotIdentity(SAMPLE);
    setPilotIdentity(null);
    expect(isPilotMode()).toBe(false);
    expect(localStorage.getItem("qrai-pilot-session")).toBeNull();
  });
});

describe("actorHeaders auth selection", () => {
  it("sends only the CSRF token in pilot mode, never spoofable dev headers", () => {
    setPilotIdentity(SAMPLE);
    const headers = actorHeaders("hikmah-pilot-erbil", "learner-42", "learner");
    expect(headers).toEqual({ "x-csrf-token": "csrf-abc-123" });
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["x-tenant-id"]).toBeUndefined();
  });

  it("falls back to dev headers when not in pilot mode", () => {
    const headers = actorHeaders("t1", "u1", "learner");
    expect(headers).toEqual({ "x-tenant-id": "t1", "x-user-id": "u1", "x-user-role": "learner" });
  });

  it("prefers Bearer over dev headers when a token is present (non-pilot)", () => {
    const headers = actorHeaders("t1", "u1", "learner", "jwt-token");
    expect(headers).toEqual({ authorization: "Bearer jwt-token" });
  });
});

describe("a pilot session can be ended", () => {
  // ── Why this test exists ────────────────────────────────────────────────────────────────────────
  // Nothing ended one. `setPilotIdentity(null)` had no caller in the app, `logout()` cleared only
  // the LOGIN key, and the profile chip that would carry a logout renders `disabled` whenever
  // `bypassLogin` is set — which is the ONLY mode a pilot session can be bootstrapped in, and the
  // default (`VITE_REQUIRE_LOGIN` unset). Reproduced before the fix: after everything the UI could
  // do, `isPilotMode()` was still true and `qrai-pilot-session` still held the learner.
  //
  // On the shared classroom laptops this pilot deploys to, that handed the next person the previous
  // learner's recordings, mistakes and privacy controls, for 8h idle / 24h absolute.
  const identity = {
    userId: "learner-42",
    tenantId: "hikmah-pilot-erbil",
    displayName: "Amina",
    role: "learner",
    csrfToken: "csrf-abc",
  };

  it("clearing the identity ends pilot mode and leaves nothing behind", () => {
    setPilotIdentity(identity);
    expect(isPilotMode()).toBe(true);

    setPilotIdentity(null);

    expect(isPilotMode()).toBe(false);
    expect(getPilotIdentity()).toBeNull();
    expect(localStorage.getItem("qrai-pilot-session")).toBeNull();
    // The identity is what the app sends as the actor; after signing out there must be nothing to
    // send. Without this the next learner's requests would carry the previous learner's CSRF token.
    expect(getPilotCsrf()).toBeNull();
  });

  it("the LOGIN key is not what holds a pilot session", () => {
    // The precise shape of the original defect: `logout()` removes `quran-ai-auth` and that is all
    // it does. If someone ever "fixes" a pilot logout by clearing that key, this fails.
    setPilotIdentity(identity);
    localStorage.removeItem("quran-ai-auth");

    expect(isPilotMode()).toBe(true);
    expect(localStorage.getItem("qrai-pilot-session")).toContain("learner-42");
  });
});
