import {
  buildEnrollmentRequest,
  generateHubIdentity,
  publicKeyFingerprint,
  verifyDeviceCredential,
  type Attestation,
  type DeviceCredential,
  type HubIdentity,
} from "@supreme/hub-identity";
import type { SecretStore } from "./secrets.js";

/**
 * Hub Agent — the hub side of zero-touch provisioning (ADR 0008, blueprint §3). On first boot
 * the hub generates its cryptographic identity, enrolls with the cloud Hub Registry, and
 * stores the issued device credential. All of this is OPTIONAL and NON-FATAL: if the cloud is
 * unreachable, the hub keeps running fully locally (invariant I1) and retries enrollment later.
 *
 * The agent never blocks boot and never holds plaintext anywhere but the sealed secrets store.
 */

const IDENTITY_SECRET = "hub_identity";
const CREDENTIAL_SECRET = "hub_credential";

interface StoredCredential {
  credential: DeviceCredential;
  caPublicKey: string;
  brokerEndpoint: string;
  renewBeforeMs: number;
  /** Real X.509 mTLS material issued by the registry (when a PKI CA is configured). */
  deviceCert?: string;
  deviceKey?: string;
  mtlsCaCert?: string;
  mtlsEndpoint?: string;
}

/** The X.509 material the hub uses to dial the broker's mTLS listener. */
export interface MtlsMaterial {
  deviceCert: string;
  deviceKey: string;
  /** CA cert (PEM) to verify the broker's server cert. */
  caCert: string;
  /** Broker mTLS listener as host:port. */
  endpoint: string;
}

function mtlsOf(s: StoredCredential | null | undefined): MtlsMaterial | null {
  if (s?.deviceCert && s.deviceKey && s.mtlsCaCert && s.mtlsEndpoint) {
    return { deviceCert: s.deviceCert, deviceKey: s.deviceKey, caCert: s.mtlsCaCert, endpoint: s.mtlsEndpoint };
  }
  return null;
}

/** Load the hub identity from the sealed store, or generate + persist a new one (once). */
export function loadOrCreateHubIdentity(store: SecretStore, nowMs: number = Date.now()): HubIdentity {
  const raw = store.get(IDENTITY_SECRET);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as HubIdentity;
      if (parsed.hubUuid && parsed.publicKey && parsed.privateKey) return parsed;
    } catch {
      // fall through and regenerate if the stored blob is corrupt
    }
  }
  const identity = generateHubIdentity(nowMs);
  store.set(IDENTITY_SECRET, JSON.stringify(identity));
  return identity;
}

/** Minimal fetch-shaped response the agent needs (so tests can inject a fake). */
export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
}

export interface HubAgentOptions {
  store: SecretStore;
  registryUrl: string;
  model: string;
  fwVersion: string;
  /** Attestation evidence; a factory/installer signature today, a TPM quote in Phase 4. */
  attestation?: Attestation;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface EnrollmentState {
  identity: HubIdentity;
  credential: DeviceCredential | null;
  brokerEndpoint: string | null;
  enrolled: boolean;
  /** X.509 material for the mTLS tunnel, when the registry issued it. */
  mtls: MtlsMaterial | null;
}

export class HubAgent {
  private readonly store: SecretStore;
  private readonly registryUrl: string;
  private readonly model: string;
  private readonly fwVersion: string;
  private readonly attestation: Attestation;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;
  readonly identity: HubIdentity;

  constructor(opts: HubAgentOptions) {
    this.store = opts.store;
    this.registryUrl = opts.registryUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.fwVersion = opts.fwVersion;
    this.attestation = opts.attestation ?? { kind: "dev", evidence: "dev-attestation" };
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.identity = loadOrCreateHubIdentity(this.store, this.now());
  }

  /** This hub's stable id, for display / mDNS TXT. */
  get hubUuid(): string {
    return this.identity.hubUuid;
  }

  /** Device public-key fingerprint clients pin during local (mDNS) discovery. */
  get fingerprint(): string {
    return publicKeyFingerprint(this.identity.publicKey);
  }

  /** The currently-stored credential, if enrolled and still valid. */
  currentCredential(): StoredCredential | null {
    const raw = this.store.get(CREDENTIAL_SECRET);
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as StoredCredential;
      const check = verifyDeviceCredential(stored.credential, stored.caPublicKey, this.now());
      return check.valid ? stored : null;
    } catch {
      return null;
    }
  }

  /**
   * Ensure the hub is enrolled: if we hold a still-valid credential we're done; otherwise
   * enroll (or renew). Non-fatal — returns the state and logs on failure so boot proceeds.
   */
  async ensureEnrolled(): Promise<EnrollmentState> {
    const existing = this.currentCredential();
    const needsRenew =
      existing !== null && existing.credential.notAfter - this.now() < existing.renewBeforeMs;
    if (existing && !needsRenew) {
      return { identity: this.identity, credential: existing.credential, brokerEndpoint: existing.brokerEndpoint, enrolled: true, mtls: mtlsOf(existing) };
    }
    try {
      const path = existing ? "/v1/hubs/renew" : "/v1/hubs/enroll";
      const req = buildEnrollmentRequest(this.identity, { model: this.model, fwVersion: this.fwVersion }, this.attestation, this.now());
      const res = await this.fetchImpl(`${this.registryUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        this.log("hub enrollment failed", { status: res.status });
        return { identity: this.identity, credential: existing?.credential ?? null, brokerEndpoint: existing?.brokerEndpoint ?? null, enrolled: Boolean(existing), mtls: mtlsOf(existing) };
      }
      const stored = (await res.json()) as StoredCredential;
      this.store.set(CREDENTIAL_SECRET, JSON.stringify(stored));
      this.log("hub enrolled", { hubUuid: this.hubUuid, serial: stored.credential.serial, mtls: Boolean(stored.deviceCert) });
      return { identity: this.identity, credential: stored.credential, brokerEndpoint: stored.brokerEndpoint, enrolled: true, mtls: mtlsOf(stored) };
    } catch (err) {
      // Cloud unreachable — keep running locally and retry on the next boot/heartbeat.
      this.log("hub enrollment skipped (cloud unreachable)", { error: (err as Error).message });
      return { identity: this.identity, credential: existing?.credential ?? null, brokerEndpoint: existing?.brokerEndpoint ?? null, enrolled: Boolean(existing), mtls: mtlsOf(existing) };
    }
  }

  /** Request a proximity-gated claim code to display for the owner to claim this hub. */
  async requestClaimCode(): Promise<{ code: string; expiresAt: number } | null> {
    try {
      const res = await this.fetchImpl(`${this.registryUrl}/v1/hubs/${this.hubUuid}/claim-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) return null;
      const code = (await res.json()) as { code: string; expiresAt: number };
      return { code: code.code, expiresAt: code.expiresAt };
    } catch {
      return null;
    }
  }
}

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, json: () => res.json() };
};
