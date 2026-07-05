import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  canonicalJson,
  generateSigningKeyPair,
  sha256Hex,
  signPayload,
  verifyPayload,
} from "@supreme/crypto";
import { isUuidv7, uuidv7 } from "./uuid.js";

export { uuidv7, isUuidv7 } from "./uuid.js";

/**
 * @supreme/hub-identity — the hub's cryptographic identity and the zero-touch enrollment
 * protocol (ADR 0008, blueprint §3). Shared by the hub agent (which generates identity and
 * requests enrollment) and the cloud Hub Registry (which verifies and issues credentials).
 *
 * Trust model:
 *   • The hub generates a UUIDv7 + Ed25519 device keypair on first boot. The private key
 *     never leaves the hub (sealed by the secrets manager; in Phase 4, a secure element).
 *   • The hub signs an EnrollmentRequest with the device key — proof of possession of the
 *     private key matching the enclosed public key.
 *   • The cloud Hub CA verifies that self-signature + the provisioning attestation, then
 *     issues a short-lived DeviceCredential binding {hubUuid, devicePublicKey} signed by the
 *     CA. The hub later authenticates with mTLS using this identity.
 *
 * The DeviceCredential here is a compact, Ed25519-signed JSON binding — the dev/test stand-in
 * for the production X.509 device certificate. The protocol (CSR-equivalent request → CA
 * issues → verify/expire/revoke) is identical, so swapping in real X.509 issuance is a CA
 * implementation detail behind {@link IHubCertificateAuthority}, not a protocol change.
 */

/** A hub's long-lived identity. The private key is sensitive and sealed at rest. */
export interface HubIdentity {
  hubUuid: string;
  /** Ed25519 device public key (SPKI PEM). */
  publicKey: string;
  /** Ed25519 device private key (PKCS8 PEM) — sealed; never sent to the cloud. */
  privateKey: string;
}

/** The public half of a hub identity, safe to share. */
export interface HubPublicIdentity {
  hubUuid: string;
  publicKey: string;
}

/** Provisioning attestation: factory/installer-signed today, TPM EK quote in Phase 4. */
export interface Attestation {
  kind: "factory" | "installer" | "tpm" | "dev";
  /** Opaque evidence (a signature, an EK cert + quote, …); verified by the CA's policy. */
  evidence: string;
}

/** Hub metadata captured at enrollment. */
export interface HubMeta {
  model: string;
  fwVersion: string;
}

/** The signed enrollment request — the CSR-equivalent the hub sends to the cloud. */
export interface EnrollmentRequest {
  hubUuid: string;
  publicKey: string;
  meta: HubMeta;
  attestation: Attestation;
  /** Anti-replay nonce (hub-generated, registry tracks recent nonces). */
  nonce: string;
  /** Issued-at (ms) — the registry rejects stale requests. */
  issuedAt: number;
  /** Ed25519 signature by the device key over the canonical request (sans this field). */
  selfSignature: string;
}

/** The CA-issued device credential (dev stand-in for an X.509 device certificate). */
export interface DeviceCredential {
  hubUuid: string;
  /** The device public key this credential is bound to. */
  devicePublicKey: string;
  /** Monotonic-ish unique serial for revocation tracking. */
  serial: string;
  notBefore: number;
  notAfter: number;
  /** Identifies which CA key signed this (for rotation). */
  caKeyId: string;
  /** Ed25519 signature by the CA over the canonical credential (sans this field). */
  caSignature: string;
}

// ── Hub-side ────────────────────────────────────────────────────────────────────────────

/** Generate a fresh hub identity (UUIDv7 + Ed25519 keypair). Call once on first boot. */
export function generateHubIdentity(nowMs: number = Date.now()): HubIdentity {
  const { publicKey, privateKey } = generateSigningKeyPair();
  return { hubUuid: uuidv7(nowMs), publicKey, privateKey };
}

/** Build a signed EnrollmentRequest proving possession of the device private key. */
export function buildEnrollmentRequest(
  identity: HubIdentity,
  meta: HubMeta,
  attestation: Attestation,
  nowMs: number = Date.now(),
): EnrollmentRequest {
  const body = {
    hubUuid: identity.hubUuid,
    publicKey: identity.publicKey,
    meta,
    attestation,
    nonce: randomBytes(16).toString("base64url"),
    issuedAt: nowMs,
  };
  const selfSignature = signPayload(body, identity.privateKey);
  return { ...body, selfSignature };
}

// ── Cloud-side: verification + issuance ──────────────────────────────────────────────────

/** Verify the enrollment request's self-signature (possession of the device key). */
export function verifyEnrollmentSelfSignature(req: EnrollmentRequest): boolean {
  const { selfSignature, ...body } = req;
  return verifyPayload(body, selfSignature, req.publicKey);
}

export interface EnrollmentCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Full registry-side validation of an enrollment request: shape, freshness, self-signature,
 * and attestation policy. Nonce/replay tracking is the registry's responsibility (stateful)
 * and is layered on top via {@link AttestationVerifier} + a nonce store.
 */
export function validateEnrollmentRequest(
  req: EnrollmentRequest,
  opts: {
    nowMs?: number;
    /** Max age of the request in ms (default 5 min). */
    maxAgeMs?: number;
    /** Attestation policy; default accepts factory/installer/dev evidence non-empty. */
    verifyAttestation?: AttestationVerifier;
  } = {},
): EnrollmentCheck {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  if (!isUuidv7(req.hubUuid)) return { ok: false, reason: "invalid hub uuid" };
  if (typeof req.issuedAt !== "number" || Math.abs(nowMs - req.issuedAt) > maxAgeMs) {
    return { ok: false, reason: "stale or future-dated request" };
  }
  if (!verifyEnrollmentSelfSignature(req)) return { ok: false, reason: "bad self-signature" };
  const verifyAttestation = opts.verifyAttestation ?? defaultAttestationVerifier;
  if (!verifyAttestation(req.attestation, req)) return { ok: false, reason: "attestation rejected" };
  return { ok: true };
}

export type AttestationVerifier = (a: Attestation, req: EnrollmentRequest) => boolean;

/** Permissive default for dev/Phase-1: accept non-empty factory/installer/dev evidence. */
export const defaultAttestationVerifier: AttestationVerifier = (a) =>
  (a.kind === "factory" || a.kind === "installer" || a.kind === "dev") && a.evidence.length > 0;

/** The Hub Certificate Authority seam. Dev impl signs JSON; prod issues X.509. */
export interface IHubCertificateAuthority {
  readonly keyId: string;
  /** Issue a device credential for a validated request. */
  issue(req: EnrollmentRequest, opts?: { ttlMs?: number; nowMs?: number }): DeviceCredential;
}

/**
 * Dev/test Hub CA: holds an Ed25519 CA keypair and issues Ed25519-signed DeviceCredentials.
 * Production replaces this with an X.509 issuing CA (KMS/HSM-backed) behind the same seam.
 */
export class DevHubCA implements IHubCertificateAuthority {
  readonly keyId: string;
  private readonly caPrivateKey: string;
  readonly caPublicKey: string;

  constructor(opts: { caPublicKey: string; caPrivateKey: string; keyId?: string }) {
    this.caPublicKey = opts.caPublicKey;
    this.caPrivateKey = opts.caPrivateKey;
    this.keyId = opts.keyId ?? `ca-${sha256Hex(opts.caPublicKey).slice(0, 12)}`;
  }

  /** Create a CA with a freshly generated keypair (dev convenience). */
  static generate(): DevHubCA {
    const { publicKey, privateKey } = generateSigningKeyPair();
    return new DevHubCA({ caPublicKey: publicKey, caPrivateKey: privateKey });
  }

  issue(req: EnrollmentRequest, opts: { ttlMs?: number; nowMs?: number } = {}): DeviceCredential {
    const nowMs = opts.nowMs ?? Date.now();
    const ttlMs = opts.ttlMs ?? 30 * 24 * 60 * 60_000; // 30 days, auto-renewed
    const body = {
      hubUuid: req.hubUuid,
      devicePublicKey: req.publicKey,
      serial: randomBytes(12).toString("hex"),
      notBefore: nowMs,
      notAfter: nowMs + ttlMs,
      caKeyId: this.keyId,
    };
    const caSignature = signPayload(body, this.caPrivateKey);
    return { ...body, caSignature };
  }
}

export interface CredentialCheck {
  valid: boolean;
  reason?: string;
}

/** Verify a DeviceCredential: CA signature + validity window. */
export function verifyDeviceCredential(
  cred: DeviceCredential,
  caPublicKey: string,
  nowMs: number = Date.now(),
): CredentialCheck {
  const { caSignature, ...body } = cred;
  if (!verifyPayload(body, caSignature, caPublicKey)) return { valid: false, reason: "bad CA signature" };
  if (nowMs < cred.notBefore) return { valid: false, reason: "not yet valid" };
  if (nowMs >= cred.notAfter) return { valid: false, reason: "expired" };
  return { valid: true };
}

/**
 * Verify that a presented credential matches a hub that is proving possession of its device
 * key NOW (e.g. at mTLS / control-channel auth): the credential's bound public key must
 * verify a fresh challenge signature. This is the per-connection auth check.
 */
export function verifyHubPresentation(
  cred: DeviceCredential,
  caPublicKey: string,
  challenge: string,
  challengeSignatureB64: string,
  nowMs: number = Date.now(),
): CredentialCheck {
  const credCheck = verifyDeviceCredential(cred, caPublicKey, nowMs);
  if (!credCheck.valid) return credCheck;
  if (!verifyPayload({ challenge }, challengeSignatureB64, cred.devicePublicKey)) {
    return { valid: false, reason: "challenge signature mismatch" };
  }
  return { valid: true };
}

/** The hub answers a connection challenge by signing it with its device key. */
export function signChallenge(challenge: string, devicePrivateKey: string): string {
  return signPayload({ challenge }, devicePrivateKey);
}

// ── Claiming (ownership binding) ──────────────────────────────────────────────────────────

/** A single-use, time-boxed claim code shown on the hub / advertised over signed mDNS. */
export interface ClaimCode {
  hubUuid: string;
  code: string;
  expiresAt: number;
}

/** Generate a short, human-typeable claim code (proximity-gated ownership; ADR 0008 §3.3). */
export function generateClaimCode(hubUuid: string, nowMs: number = Date.now(), ttlMs = 10 * 60_000): ClaimCode {
  // 8 base32-ish chars, unambiguous alphabet (no 0/O/1/I).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += alphabet[raw[i]! % alphabet.length];
  return { hubUuid, code, expiresAt: nowMs + ttlMs };
}

/** Constant-time claim-code comparison with expiry, for the registry's claim endpoint. */
export function verifyClaimCode(expected: ClaimCode, presentedCode: string, nowMs: number = Date.now()): boolean {
  if (nowMs >= expected.expiresAt) return false;
  const a = Buffer.from(expected.code);
  const b = Buffer.from(presentedCode);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Public identity view (drop the private key) for sending to the cloud / logging. */
export function toPublicIdentity(identity: HubIdentity): HubPublicIdentity {
  return { hubUuid: identity.hubUuid, publicKey: identity.publicKey };
}

/** Stable fingerprint of a device public key (for mDNS TXT + registry pinning). */
export function publicKeyFingerprint(publicKeyPem: string): string {
  return sha256Hex(canonicalJson({ pk: publicKeyPem })).slice(0, 32);
}
