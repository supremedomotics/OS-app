import { createPublicKey, randomBytes, verify as nodeVerify } from "node:crypto";
import type { SecretStore } from "./secrets.js";

export {
  issueMobileAuthorizationToken,
  verifyMobileAuthorizationToken,
  MOBILE_TOKEN_TTL_MS,
  type MobileAuthorizationTokenPayload,
} from "@supreme/hub-identity";

/**
 * Real, server-side implementation of the Mobile pairing/authorization protocol whose
 * client half shipped in Phase 11 (`apps/new/shared/lib/src/identity/{mobile_identity,
 * pairing}.dart`). Closes the SERVER-SIDE REQUIRED gaps that phase explicitly documented:
 * an Ed25519-verifying `/v1/pairing/*` endpoint, a Hub-side authorization registry, and a
 * token the Tunnel Broker can verify WITHOUT calling the (often CGNAT-hidden) Hub
 * synchronously per request.
 *
 * Design: the Mobile authorization token is signed with the SAME Ed25519 device key
 * (`HubIdentity`, `@supreme/hub-identity`) the Hub already uses to authenticate its own
 * tunnel to the broker (ADR 0009's mTLS/challenge handshake). The broker already ends up
 * trusting that exact public key once a Hub's tunnel is attached — see `broker.ts`'s
 * `getHubPublicKey` — so verifying a Mobile token there is "does this bear a valid signature
 * from the Hub I already know is real," never a second, separately-trusted keypair. The Hub
 * remains the sole issuer/authority; the broker only verifies a signature (§27: transport,
 * not a smart-home authority).
 */

// ── Real Ed25519 verification of the Mobile's raw (non-PEM) public key ─────────────────────

/** DER prefix for an Ed25519 SubjectPublicKeyInfo wrapping a raw 32-byte public key — the
 * Dart client (`Ed25519MobileIdentity`) exchanges raw/base64 keys, not PEM, so this is the
 * standard, well-known wrapping needed before Node's `crypto` module can consume them. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Verifies a real Ed25519 signature from a Mobile device against its raw base64 public key.
 * Never throws — a malformed key/signature is simply "not valid," same as a wrong one. */
export function verifyMobileSignature(message: Buffer, signatureBase64: string, publicKeyBase64: string): boolean {
  try {
    const rawKey = Buffer.from(publicKeyBase64, "base64");
    if (rawKey.length !== 32) return false;
    const der = Buffer.concat([ED25519_SPKI_PREFIX, rawKey]);
    const keyObject = createPublicKey({ key: der, format: "der", type: "spki" });
    return nodeVerify(null, message, keyObject, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

// ── Pairing codes (homeowner-facing, short, out-of-band) ───────────────────────────────────

interface PairingCodeEntry {
  hubId: string;
  projectId: string;
  expiresAt: number;
}

/** Short-lived, single-use pairing codes an installer/admin action displays to the homeowner
 * (§8: never a MAC address, never a static shared secret). Generating one is an authenticated
 * admin action — this store just tracks validity, not who may request one (the route layer
 * owns that authorization check). */
export class PairingCodeStore {
  private readonly codes = new Map<string, PairingCodeEntry>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  generate(hubId: string, projectId: string): string {
    const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
    this.codes.set(code, { hubId, projectId, expiresAt: this.now() + this.ttlMs });
    return code;
  }

  /** Single-use: removed on first lookup regardless of outcome, so a code can never be
   * replayed even by the legitimate Mobile that already used it successfully. */
  consume(code: string): PairingCodeEntry | undefined {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry || this.now() > entry.expiresAt) return undefined;
    return entry;
  }
}

// ── Pairing challenges (cryptographic proof-of-possession, §7 replay protection) ───────────

export interface PendingChallenge {
  challengeId: string;
  challengeBytes: Buffer;
  mobilePublicKeyBase64: string;
  hubId: string;
  projectId: string;
}

interface StoredChallenge extends PendingChallenge {
  expiresAt: number;
}

/** Unpredictable (32 random bytes), short-lived, and — critically — SINGLE-USE: `consume()`
 * deletes the entry unconditionally on first lookup, so a previously successful (or failed)
 * challenge can never be replayed, per §7's explicit "Challenge 1 → success, Challenge 1 →
 * second attempt = failure" requirement. */
export class PairingChallengeStore {
  private readonly pending = new Map<string, StoredChallenge>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 60_000,
  ) {}

  issue(opts: { mobilePublicKeyBase64: string; hubId: string; projectId: string }): PendingChallenge {
    const challengeId = randomBytes(16).toString("base64url");
    const challenge: StoredChallenge = {
      challengeId,
      challengeBytes: randomBytes(32),
      mobilePublicKeyBase64: opts.mobilePublicKeyBase64,
      hubId: opts.hubId,
      projectId: opts.projectId,
      expiresAt: this.now() + this.ttlMs,
    };
    this.pending.set(challengeId, challenge);
    return challenge;
  }

  consume(challengeId: string): PendingChallenge | undefined {
    const c = this.pending.get(challengeId);
    this.pending.delete(challengeId); // unconditional — replay-proof even on a failed attempt
    if (!c || this.now() > c.expiresAt) return undefined;
    return c;
  }
}

// ── Hub-side authorization registry (persisted, authoritative) ─────────────────────────────

export interface MobileAuthorizationRecord {
  mobileId: string;
  publicKeyBase64: string;
  hubId: string;
  projectId: string;
  label: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
}

const REGISTRY_SECRET_NAME = "mobile_authorizations";

/**
 * The Hub's own authoritative record of which Mobile identities it has authorized (§4, §9,
 * §26). Persisted through the existing `SecretStore` (the same 0600-file-per-secret
 * convention `hub-agent.ts` already uses for `hub_identity`/`hub_credential`) — deliberately
 * NOT a new database layer; this is a small, home-scoped list, not a table needing SQL.
 */
export class MobileAuthorizationRegistry {
  constructor(private readonly store: SecretStore) {}

  private load(): MobileAuthorizationRecord[] {
    const raw = this.store.get(REGISTRY_SECRET_NAME);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as MobileAuthorizationRecord[];
    } catch {
      return [];
    }
  }

  private save(records: MobileAuthorizationRecord[]): void {
    this.store.set(REGISTRY_SECRET_NAME, JSON.stringify(records));
  }

  list(): MobileAuthorizationRecord[] {
    return this.load();
  }

  find(mobileId: string): MobileAuthorizationRecord | undefined {
    return this.load().find((r) => r.mobileId === mobileId);
  }

  upsert(record: MobileAuthorizationRecord): void {
    const records = this.load().filter((r) => r.mobileId !== record.mobileId);
    records.push(record);
    this.save(records);
  }

  /** Authoritative revocation (§9): the Hub is the one system of record — a Mobile deleting
   * its own local token is never sufficient, and this is what makes that true. */
  revoke(mobileId: string, nowIso: string): boolean {
    const records = this.load();
    const record = records.find((r) => r.mobileId === mobileId);
    if (!record) return false;
    record.revoked = true;
    record.revokedAt = nowIso;
    this.save(records);
    return true;
  }

  touchLastSeen(mobileId: string, nowIso: string): void {
    const records = this.load();
    const record = records.find((r) => r.mobileId === mobileId);
    if (!record) return;
    record.lastSeenAt = nowIso;
    this.save(records);
  }

  /** §10 project/Hub isolation: authorization is a (mobileId, hubId, projectId) tuple, never
   * `mobileId` alone — a Mobile authorized for Hub A's project can never pass this check for
   * Hub B, even with an otherwise-valid identity. */
  isAuthorized(mobileId: string, hubId: string, projectId: string): boolean {
    const record = this.find(mobileId);
    return !!record && !record.revoked && record.hubId === hubId && record.projectId === projectId;
  }
}

// Remote-session authorization tokens (issued by the Hub, verified by the broker without a
// synchronous call back) now live in `@supreme/hub-identity` — see the re-export at the top
// of this file — because `cloud/tunnel-broker` needs the verify half and does not (and must
// not) depend on `services/gateway`.
