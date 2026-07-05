import {
  DevHubCA,
  generateClaimCode,
  validateEnrollmentRequest,
  verifyClaimCode,
  type AttestationVerifier,
  type ClaimCode,
  type DeviceCredential,
  type EnrollmentRequest,
  type IHubCertificateAuthority,
} from "@supreme/hub-identity";
import { issueDeviceCert, type CertAuthority } from "@supreme/hub-pki";

/**
 * @supreme/hub-registry — the cloud Hub Registry (ADR 0008, blueprint §3, §4).
 *
 * Transport-agnostic core (like the relay's tunnel core) so it is unit-testable without a
 * server; an HTTP/gRPC surface wraps these methods. Responsibilities:
 *   • zero-touch ENROLLMENT: verify a hub's signed request + attestation, persist it as
 *     provisioned-but-unclaimed, and issue a device credential via the Hub CA;
 *   • CLAIMING: bind a provisioned hub to an owner account via a proximity-gated claim code,
 *     creating the home + owner membership;
 *   • lifecycle: heartbeat/presence, credential renewal (proof-of-possession), revocation,
 *     and ownership transfer.
 *
 * It owns NO device state — only the hub↔account ownership graph (invariant I2).
 */

export { buildHubRegistryServer, type HubRegistryServerOptions } from "./server.js";

export type HubStatus = "provisioned" | "claimed" | "suspended" | "decommissioned";

export interface HubRecord {
  hubUuid: string;
  status: HubStatus;
  publicKey: string;
  model: string;
  fwVersion: string;
  /** Active credential serial (for revocation tracking). */
  certSerial: string | null;
  claimedByAccountId: string | null;
  dealerOrgId: string | null;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface HomeRecord {
  id: string;
  name: string;
  ownerAccountId: string;
  hubUuid: string;
  createdAt: number;
}

export interface MembershipRecord {
  id: string;
  homeId: string;
  accountId: string;
  role: "owner" | "admin" | "installer" | "homeowner" | "family" | "guest" | "service";
  createdAt: number;
}

/**
 * Persistence seam — Postgres in production (`@supreme/cloud-persistence`); in-memory for
 * tests/dev. Async throughout so a real database (or a Redis-backed nonce check) sits behind it.
 */
export interface IHubRegistryStore {
  getHub(hubUuid: string): Promise<HubRecord | undefined>;
  putHub(hub: HubRecord): Promise<void>;
  listHubsForAccount(accountId: string): Promise<HubRecord[]>;
  /** Returns false if the nonce was already seen (replay) — enforces single-use enrollment. */
  recordNonce(nonce: string, expiresAt: number): Promise<boolean>;
  revoked(serial: string): Promise<boolean>;
  revoke(serial: string): Promise<void>;
  putClaimCode(code: ClaimCode): Promise<void>;
  getClaimCode(hubUuid: string): Promise<ClaimCode | undefined>;
  putHome(home: HomeRecord): Promise<void>;
  putMembership(m: MembershipRecord): Promise<void>;
  membershipsForHub(hubUuid: string): Promise<MembershipRecord[]>;
}

export class InMemoryHubRegistryStore implements IHubRegistryStore {
  private hubs = new Map<string, HubRecord>();
  private nonces = new Map<string, number>();
  private revokedSerials = new Set<string>();
  private claimCodes = new Map<string, ClaimCode>();
  private homes = new Map<string, HomeRecord>();
  private memberships: MembershipRecord[] = [];

  async getHub(hubUuid: string) {
    return this.hubs.get(hubUuid);
  }
  async putHub(hub: HubRecord) {
    this.hubs.set(hub.hubUuid, hub);
  }
  async listHubsForAccount(accountId: string) {
    return [...this.hubs.values()].filter((h) => h.claimedByAccountId === accountId);
  }
  async recordNonce(nonce: string, expiresAt: number) {
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, expiresAt);
    return true;
  }
  async revoked(serial: string) {
    return this.revokedSerials.has(serial);
  }
  async revoke(serial: string) {
    this.revokedSerials.add(serial);
  }
  async putClaimCode(code: ClaimCode) {
    this.claimCodes.set(code.hubUuid, code);
  }
  async getClaimCode(hubUuid: string) {
    return this.claimCodes.get(hubUuid);
  }
  async putHome(home: HomeRecord) {
    this.homes.set(home.id, home);
  }
  async putMembership(m: MembershipRecord) {
    this.memberships.push(m);
  }
  async membershipsForHub(hubUuid: string) {
    const homeIds = new Set([...this.homes.values()].filter((h) => h.hubUuid === hubUuid).map((h) => h.id));
    return this.memberships.filter((m) => homeIds.has(m.homeId));
  }
}

export interface EnrollResult {
  credential: DeviceCredential;
  caPublicKey: string;
  brokerEndpoint: string;
  /** Credential renewal lead time (ms before notAfter the hub should renew). */
  renewBeforeMs: number;
  /** Real X.509 device cert + key (PEM) for the mutual-TLS tunnel — present when a PKI CA is
   * configured. The hub presents these dialing the broker; `mtlsCaCert` verifies the broker's
   * server cert; `mtlsEndpoint` is the host:port of the mTLS listener. */
  deviceCert?: string;
  deviceKey?: string;
  mtlsCaCert?: string;
  mtlsEndpoint?: string;
}

export interface ClaimResult {
  home: HomeRecord;
  membership: MembershipRecord;
}

export class RegistryError extends Error {
  constructor(
    readonly code: "validation_failed" | "conflict" | "not_found" | "unauthorized",
    message: string,
  ) {
    super(message);
  }
}

export interface HubRegistryOptions {
  store?: IHubRegistryStore;
  ca?: IHubCertificateAuthority & { caPublicKey: string };
  brokerEndpoint?: string;
  verifyAttestation?: AttestationVerifier;
  /** X.509 Hub CA — when set, enrollment also issues a real device cert for the mTLS tunnel. */
  pkiCa?: CertAuthority;
  /** mTLS listener endpoint (host:port) handed to the hub when a PKI CA is configured. */
  mtlsEndpoint?: string;
  /** Injectable id generators for deterministic tests. */
  newId?: (prefix: string) => string;
  now?: () => number;
}

export class HubRegistry {
  private readonly store: IHubRegistryStore;
  private readonly ca: IHubCertificateAuthority & { caPublicKey: string };
  private readonly brokerEndpoint: string;
  private readonly verifyAttestation?: AttestationVerifier;
  private readonly pkiCa?: CertAuthority;
  private readonly mtlsEndpoint?: string;
  private readonly newId: (prefix: string) => string;
  private readonly now: () => number;
  private seq = 0;

  constructor(opts: HubRegistryOptions = {}) {
    this.store = opts.store ?? new InMemoryHubRegistryStore();
    this.ca = opts.ca ?? DevHubCA.generate();
    this.brokerEndpoint = opts.brokerEndpoint ?? "https://broker.supremedomotics.in";
    this.verifyAttestation = opts.verifyAttestation;
    this.pkiCa = opts.pkiCa;
    this.mtlsEndpoint = opts.mtlsEndpoint;
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? ((p) => `${p}-${(++this.seq).toString(36)}-${this.now().toString(36)}`);
  }

  /** Zero-touch enrollment: verify → persist (provisioned, unclaimed) → issue credential. */
  async enroll(req: EnrollmentRequest): Promise<EnrollResult> {
    const nowMs = this.now();
    const check = validateEnrollmentRequest(req, { nowMs, verifyAttestation: this.verifyAttestation });
    if (!check.ok) throw new RegistryError("validation_failed", check.reason ?? "invalid enrollment");

    // Single-use nonce — reject replays of a captured request.
    if (!(await this.store.recordNonce(req.nonce, nowMs + 10 * 60_000))) {
      throw new RegistryError("conflict", "enrollment nonce already used");
    }

    const existing = await this.store.getHub(req.hubUuid);
    // Re-enrollment of a known hub must come from the SAME device key (no hijack).
    if (existing && existing.publicKey !== req.publicKey) {
      throw new RegistryError("unauthorized", "hub uuid already bound to a different key");
    }

    const credential = this.ca.issue(req, { nowMs });
    const hub: HubRecord = existing
      ? { ...existing, fwVersion: req.meta.fwVersion, certSerial: credential.serial }
      : {
          hubUuid: req.hubUuid,
          status: "provisioned",
          publicKey: req.publicKey,
          model: req.meta.model,
          fwVersion: req.meta.fwVersion,
          certSerial: credential.serial,
          claimedByAccountId: null,
          dealerOrgId: null,
          createdAt: nowMs,
          lastSeenAt: nowMs,
        };
    await this.store.putHub(hub);

    const result: EnrollResult = {
      credential,
      caPublicKey: this.ca.caPublicKey,
      brokerEndpoint: this.brokerEndpoint,
      renewBeforeMs: 7 * 24 * 60 * 60_000,
    };
    // When a PKI CA is configured, also issue a real X.509 device cert for the mTLS tunnel.
    if (this.pkiCa) {
      const tls = issueDeviceCert(this.pkiCa, { hubUuid: req.hubUuid, serial: credential.serial, notBeforeMs: nowMs });
      result.deviceCert = tls.certPem;
      result.deviceKey = tls.keyPem;
      result.mtlsCaCert = this.pkiCa.caCertPem;
      result.mtlsEndpoint = this.mtlsEndpoint;
    }
    return result;
  }

  /** Renew a credential — proves possession of the device key (same validation path). */
  async renew(req: EnrollmentRequest): Promise<EnrollResult> {
    const hub = await this.store.getHub(req.hubUuid);
    if (!hub) throw new RegistryError("not_found", "hub is not enrolled");
    if (hub.publicKey !== req.publicKey) throw new RegistryError("unauthorized", "key mismatch");
    return this.enroll(req);
  }

  /** Issue a single-use, time-boxed claim code (shown on the hub / signed mDNS). */
  async issueClaimCode(hubUuid: string): Promise<ClaimCode> {
    const hub = await this.store.getHub(hubUuid);
    if (!hub) throw new RegistryError("not_found", "hub is not enrolled");
    if (hub.status === "claimed") throw new RegistryError("conflict", "hub already claimed");
    const code = generateClaimCode(hubUuid, this.now());
    await this.store.putClaimCode(code);
    return code;
  }

  /** Bind a provisioned hub to an owner account; creates the home + owner membership. */
  async claim(hubUuid: string, accountId: string, presentedCode: string, homeName = "My Home"): Promise<ClaimResult> {
    const hub = await this.store.getHub(hubUuid);
    if (!hub) throw new RegistryError("not_found", "hub is not enrolled");
    if (hub.status === "claimed") throw new RegistryError("conflict", "hub already claimed");
    const expected = await this.store.getClaimCode(hubUuid);
    if (!expected || !verifyClaimCode(expected, presentedCode, this.now())) {
      throw new RegistryError("unauthorized", "invalid or expired claim code");
    }

    const nowMs = this.now();
    await this.store.putHub({ ...hub, status: "claimed", claimedByAccountId: accountId });
    const home: HomeRecord = {
      id: this.newId("home"),
      name: homeName,
      ownerAccountId: accountId,
      hubUuid,
      createdAt: nowMs,
    };
    const membership: MembershipRecord = {
      id: this.newId("mbr"),
      homeId: home.id,
      accountId,
      role: "owner",
      createdAt: nowMs,
    };
    await this.store.putHome(home);
    await this.store.putMembership(membership);
    return { home, membership };
  }

  /** Transfer ownership (dealer → customer). Owner-authorized; audit-logged by the caller. */
  async transfer(hubUuid: string, toAccountId: string): Promise<void> {
    const hub = await this.store.getHub(hubUuid);
    if (!hub) throw new RegistryError("not_found", "hub is not enrolled");
    await this.store.putHub({ ...hub, claimedByAccountId: toAccountId });
  }

  async heartbeat(hubUuid: string): Promise<void> {
    const hub = await this.store.getHub(hubUuid);
    if (!hub) throw new RegistryError("not_found", "hub is not enrolled");
    await this.store.putHub({ ...hub, lastSeenAt: this.now() });
  }

  async revoke(serial: string): Promise<void> {
    await this.store.revoke(serial);
  }

  async isRevoked(serial: string): Promise<boolean> {
    return this.store.revoked(serial);
  }

  async getHub(hubUuid: string): Promise<HubRecord | undefined> {
    return this.store.getHub(hubUuid);
  }

  async listHubsForAccount(accountId: string): Promise<HubRecord[]> {
    return this.store.listHubsForAccount(accountId);
  }
}
