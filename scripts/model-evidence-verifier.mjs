import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceSchema = JSON.parse(
  readFileSync(
    join(here, "..", "packages", "contracts", "schemas", "model-evaluation-evidence-v1.schema.json"),
    "utf8",
  ),
);
const validateEvidenceBundle = new Ajv2020({ allErrors: true, strict: true }).compile(evidenceSchema);

const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const publicKeyX = /^[A-Za-z0-9_-]{43}$/;

function fail(message) {
  throw new Error(`Model evidence verification failed: ${message}`);
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains missing or unknown fields.`);
  }
}

function assertWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail("RFC 8785 strings must not contain a lone surrogate.");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail("RFC 8785 strings must not contain a lone surrogate.");
    }
  }
}

function canonicalize(value, activeObjects) {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertWellFormedString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("RFC 8785 numbers must be finite.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    fail("RFC 8785 input must contain only JSON values.");
  }
  if (activeObjects.has(value)) fail("RFC 8785 input must not contain a cycle.");
  activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      const arrayKeys = Object.keys(value);
      if (
        arrayKeys.length !== value.length ||
        arrayKeys.some((property, index) => property !== String(index))
      ) {
        fail("RFC 8785 input must not contain a sparse or extended JSON array.");
      }
      return `[${value.map((item) => canonicalize(item, activeObjects)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("RFC 8785 input must contain only JSON objects.");
    }
    const properties = Object.keys(value).sort();
    if (Reflect.ownKeys(value).length !== properties.length) {
      fail("RFC 8785 input must not contain symbol or non-enumerable JSON object fields.");
    }
    return `{${properties
      .map((property) => {
        assertWellFormedString(property);
        return `${JSON.stringify(property)}:${canonicalize(value[property], activeObjects)}`;
      })
      .join(",")}}`;
  } finally {
    activeObjects.delete(value);
  }
}

export function canonicalizeRfc8785(value) {
  return canonicalize(value, new WeakSet());
}

function trustedKeys(policy) {
  assertExactKeys(policy, ["schemaVersion", "policyId", "keys"], "trusted signer policy");
  if (policy.schemaVersion !== "qrai-model-evaluation-trusted-signers/v1") {
    fail("trusted signer policy schemaVersion is unsupported.");
  }
  if (typeof policy.policyId !== "string" || !stableId.test(policy.policyId)) {
    fail("trusted signer policy policyId is invalid.");
  }
  if (!Array.isArray(policy.keys)) fail("trusted signer policy keys must be an array.");

  const keys = new Map();
  const publicKeyOwners = new Map();
  for (const entry of policy.keys) {
    assertExactKeys(
      entry,
      ["keyId", "algorithm", "trustClass", "status", "publicKeyJwk"],
      "trusted signer key",
    );
    if (typeof entry.keyId !== "string" || !stableId.test(entry.keyId)) {
      fail("trusted signer policy contains an invalid keyId.");
    }
    if (keys.has(entry.keyId)) fail(`trusted signer policy contains duplicate keyId ${entry.keyId}.`);
    if (entry.algorithm !== "Ed25519") fail(`trusted signer key ${entry.keyId} is not Ed25519.`);
    if (entry.trustClass !== "test-only" && entry.trustClass !== "release") {
      fail(`trusted signer key ${entry.keyId} has an invalid trust class.`);
    }
    if (entry.status !== "active" && entry.status !== "revoked") {
      fail(`trusted signer key ${entry.keyId} has an invalid status.`);
    }
    assertExactKeys(entry.publicKeyJwk, ["kty", "crv", "x"], "Ed25519 public JWK");
    const { crv, kty, x } = entry.publicKeyJwk;
    if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || !publicKeyX.test(x)) {
      fail(`trusted signer key ${entry.keyId} must contain a valid Ed25519 public key.`);
    }
    const decoded = Buffer.from(x, "base64url");
    if (decoded.length !== 32 || decoded.toString("base64url") !== x) {
      fail(`trusted signer key ${entry.keyId} must contain a canonical Ed25519 public key.`);
    }
    const existingKeyId = publicKeyOwners.get(x);
    if (existingKeyId) {
      fail(
        `trusted signer policy contains duplicate Ed25519 public key material for ${existingKeyId} and ${entry.keyId}.`,
      );
    }
    let publicKey;
    try {
      publicKey = createPublicKey({ key: entry.publicKeyJwk, format: "jwk" });
    } catch {
      fail(`trusted signer key ${entry.keyId} must contain a valid Ed25519 public key.`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      fail(`trusted signer key ${entry.keyId} must contain an Ed25519 public key.`);
    }
    publicKeyOwners.set(x, entry.keyId);
    keys.set(entry.keyId, { ...entry, publicKey });
  }
  return keys;
}

function decodeSignature(value) {
  const signature = Buffer.from(value, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value) {
    fail("signatureBase64Url is not a canonical Ed25519 signature.");
  }
  return signature;
}

function deepFreezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function verifyModelEvidenceBundle(bundle, trustPolicy, options = {}) {
  const optionKeys = Object.keys(options);
  if (optionKeys.some((key) => key !== "requireReleaseTrust")) {
    fail("verifier options contain an unknown field.");
  }
  if (
    options.requireReleaseTrust !== undefined &&
    typeof options.requireReleaseTrust !== "boolean"
  ) {
    fail("requireReleaseTrust must be boolean.");
  }
  if (!validateEvidenceBundle(bundle)) {
    const details = validateEvidenceBundle.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    fail(`bundle does not satisfy the evidence schema: ${details}`);
  }

  const keys = trustedKeys(trustPolicy);
  const trusted = keys.get(bundle.signature.keyId);
  if (!trusted) fail(`signature key ${bundle.signature.keyId} is not trusted.`);
  if (trusted.status !== "active") fail(`signature key ${bundle.signature.keyId} is not active.`);

  const payload = Buffer.from(canonicalizeRfc8785(bundle.evidence), "utf8");
  const payloadSha256 = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
  if (bundle.signature.payloadSha256 !== payloadSha256) {
    fail("payload SHA-256 does not match the RFC 8785 evidence bytes.");
  }
  const signature = decodeSignature(bundle.signature.signatureBase64Url);
  if (!verifySignature(null, payload, trusted.publicKey, signature)) {
    fail("Ed25519 signature is invalid.");
  }

  const releaseTrusted =
    trusted.trustClass === "release" && bundle.evidence.eligibility === "release-candidate";
  if (options.requireReleaseTrust && bundle.evidence.eligibility !== "release-candidate") {
    fail("release verification requires release-candidate eligibility.");
  }
  if (options.requireReleaseTrust && trusted.trustClass !== "release") {
    fail(`signature key ${bundle.signature.keyId} is ${trusted.trustClass}, not release trust.`);
  }

  // Return the exact payload whose signature was checked. The clone prevents a caller from
  // mutating the input bundle after verification; recursive freezing prevents the verified result
  // itself from becoming a time-of-check/time-of-use authority for different bytes.
  const evidence = deepFreezeJson(structuredClone(bundle.evidence));
  return Object.freeze({
    cryptographicallyValid: true,
    evidence,
    evidenceId: evidence.evidenceId,
    keyId: bundle.signature.keyId,
    payloadSha256,
    releaseTrusted,
    signatureAlgorithm: bundle.signature.algorithm,
    signatureBase64Url: bundle.signature.signatureBase64Url,
    signedAt: bundle.signature.signedAt,
    trustClass: trusted.trustClass,
  });
}
