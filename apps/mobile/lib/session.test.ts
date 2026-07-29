import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  audioFormatFromUri,
  authHeaders,
  buildConsentPayload,
  canStartRecording,
  parseRecognizedText,
} from "./session.ts";

describe("mobile session helpers", () => {
  describe("authHeaders", () => {
    it("sends a Bearer token when logged in", () => {
      assert.deepEqual(authHeaders({ userId: "u1", tenantId: "t1", token: "jwt-abc" }), {
        authorization: "Bearer jwt-abc",
      });
    });

    it("falls back to actor headers when there is a user but no token", () => {
      assert.deepEqual(authHeaders({ userId: "u1", tenantId: "t1", token: "" }), {
        "x-tenant-id": "t1",
        "x-user-id": "u1",
        "x-user-role": "learner",
      });
    });

    it("sends no auth headers when unauthenticated", () => {
      assert.deepEqual(authHeaders(null), {});
    });
  });

  describe("canStartRecording", () => {
    it("blocks recording until consent is given", () => {
      assert.equal(canStartRecording(false), false);
      assert.equal(canStartRecording(true), true);
    });
  });

  describe("parseRecognizedText", () => {
    it("splits on whitespace and drops empties", () => {
      assert.deepEqual(parseRecognizedText("  بسم   الله  الرحمن "), ["بسم", "الله", "الرحمن"]);
    });
    it("is robust to null/undefined/empty", () => {
      assert.deepEqual(parseRecognizedText(null), []);
      assert.deepEqual(parseRecognizedText(undefined), []);
      assert.deepEqual(parseRecognizedText(""), []);
      assert.deepEqual(parseRecognizedText("   "), []);
    });
  });

  describe("audioFormatFromUri", () => {
    it("reports m4a for the native HIGH_QUALITY recording (both ios and android write .m4a)", () => {
      assert.equal(audioFormatFromUri("file:///data/user/0/app/cache/Audio/rec-123.m4a"), "m4a");
    });
    it("reports webm for a web recording", () => {
      assert.equal(audioFormatFromUri("blob:http://localhost/abc-def.webm"), "webm");
    });
    it("ignores query strings when reading the extension", () => {
      assert.equal(audioFormatFromUri("file:///tmp/rec.wav?ts=1699999999"), "wav");
    });
    it("falls back to m4a for an unknown or missing extension", () => {
      assert.equal(audioFormatFromUri("file:///tmp/recording"), "m4a");
      assert.equal(audioFormatFromUri("file:///tmp/rec.aiff"), "m4a");
    });
  });

  describe("buildConsentPayload", () => {
    it("reflects the learner's ACTUAL toggles — never a hardcoded guardianApproved:true", () => {
      const payload = buildConsentPayload(true, false);
      assert.equal(payload.recordingConsent, true);
      assert.equal(payload.guardianApproved, false); // not fabricated
      assert.equal(payload.externalAsrProcessing, false);
      assert.equal(payload.audioRetention, "discard");
      assert.equal(payload.consentVersion, "mobile-v1");
    });
    it("carries guardian approval through when granted", () => {
      assert.equal(buildConsentPayload(true, true).guardianApproved, true);
    });
  });
});
