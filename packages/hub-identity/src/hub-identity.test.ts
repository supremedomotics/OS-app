import { describe, expect, it } from "vitest";
import {
  buildEnrollmentRequest,
  DevHubCA,
  generateClaimCode,
  generateHubIdentity,
  isUuidv7,
  publicKeyFingerprint,
  signChallenge,
  toPublicIdentity,
  uuidv7,
  validateEnrollmentRequest,
  verifyClaimCode,
  verifyDeviceCredential,
  verifyEnrollmentSelfSignature,
  verifyHubPresentation,
  type Attestation,
} from "./index.js";

const META = { model: "Supreme Hub Pro", fwVersion: "0.4.0" };
const ATTEST: Attestation = { kind: "factory", evidence: "factory-sig-abc" };
const T0 = 1_750_000_000_000; // fixed clock for determinism

describe("hub identity", () => {
  it("generates a valid UUIDv7 and an Ed25519 keypair", () => {
    const id = generateHubIdentity(T0);
    expect(isUuidv7(id.hubUuid)).toBe(true);
    expect(id.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(id.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(toPublicIdentity(id)).toEqual({ hubUuid: id.hubUuid, publicKey: id.publicKey });
  });

  it("orders UUIDv7s by time", () => {
    const a = uuidv7(T0);
    const b = uuidv7(T0 + 1000);
    expect(a < b).toBe(true); // first 48 bits are the timestamp
  });
});

describe("zero-touch enrollment", () => {
  it("round-trips: identity → request → CA issues → verify", () => {
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);
    expect(verifyEnrollmentSelfSignature(req)).toBe(true);

    const check = validateEnrollmentRequest(req, { nowMs: T0 });
    expect(check.ok).toBe(true);

    const ca = DevHubCA.generate();
    const cred = ca.issue(req, { nowMs: T0 });
    expect(cred.hubUuid).toBe(id.hubUuid);
    expect(cred.devicePublicKey).toBe(id.publicKey);

    expect(verifyDeviceCredential(cred, ca.caPublicKey, T0).valid).toBe(true);
  });

  it("rejects a tampered request (self-signature fails)", () => {
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);
    const tampered = { ...req, meta: { ...META, fwVersion: "9.9.9" } };
    expect(verifyEnrollmentSelfSignature(tampered)).toBe(false);
    expect(validateEnrollmentRequest(tampered, { nowMs: T0 }).ok).toBe(false);
  });

  it("rejects a stale request", () => {
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);
    const late = validateEnrollmentRequest(req, { nowMs: T0 + 10 * 60_000 });
    expect(late.ok).toBe(false);
    expect(late.reason).toMatch(/stale/);
  });

  it("rejects an empty attestation under the default policy", () => {
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, { kind: "factory", evidence: "" }, T0);
    expect(validateEnrollmentRequest(req, { nowMs: T0 }).ok).toBe(false);
  });
});

describe("device credential", () => {
  it("rejects a credential signed by a different CA", () => {
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);
    const realCa = DevHubCA.generate();
    const cred = realCa.issue(req, { nowMs: T0 });
    const impostor = DevHubCA.generate();
    expect(verifyDeviceCredential(cred, impostor.caPublicKey, T0).valid).toBe(false);
  });

  it("expires after notAfter", () => {
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);
    const ca = DevHubCA.generate();
    const cred = ca.issue(req, { nowMs: T0, ttlMs: 1000 });
    expect(verifyDeviceCredential(cred, ca.caPublicKey, T0 + 999).valid).toBe(true);
    expect(verifyDeviceCredential(cred, ca.caPublicKey, T0 + 1001).valid).toBe(false);
  });
});

describe("per-connection presentation (mTLS-equivalent challenge)", () => {
  it("accepts a hub that signs the challenge with its device key", () => {
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);
    const ca = DevHubCA.generate();
    const cred = ca.issue(req, { nowMs: T0 });

    const challenge = "broker-nonce-xyz";
    const sig = signChallenge(challenge, id.privateKey);
    expect(verifyHubPresentation(cred, ca.caPublicKey, challenge, sig, T0).valid).toBe(true);
  });

  it("rejects a hub that does not hold the matching private key", () => {
    const id = generateHubIdentity(T0);
    const req = buildEnrollmentRequest(id, META, ATTEST, T0);
    const ca = DevHubCA.generate();
    const cred = ca.issue(req, { nowMs: T0 });

    const attacker = generateHubIdentity(T0);
    const sig = signChallenge("broker-nonce-xyz", attacker.privateKey);
    expect(verifyHubPresentation(cred, ca.caPublicKey, "broker-nonce-xyz", sig, T0).valid).toBe(false);
  });
});

describe("claiming (ownership binding)", () => {
  it("verifies a valid, unexpired claim code in constant time", () => {
    const id = generateHubIdentity(T0);
    const claim = generateClaimCode(id.hubUuid, T0);
    expect(verifyClaimCode(claim, claim.code, T0 + 60_000)).toBe(true);
    expect(verifyClaimCode(claim, "WRONGXXX", T0 + 60_000)).toBe(false);
  });

  it("rejects an expired claim code", () => {
    const id = generateHubIdentity(T0);
    const claim = generateClaimCode(id.hubUuid, T0, 1000);
    expect(verifyClaimCode(claim, claim.code, T0 + 2000)).toBe(false);
  });
});

describe("public key fingerprint (mDNS pinning)", () => {
  it("is stable and 32 hex chars", () => {
    const id = generateHubIdentity(T0);
    const fp = publicKeyFingerprint(id.publicKey);
    expect(fp).toHaveLength(32);
    expect(publicKeyFingerprint(id.publicKey)).toBe(fp);
  });
});
