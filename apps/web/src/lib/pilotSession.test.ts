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
