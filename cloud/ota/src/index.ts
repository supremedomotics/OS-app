import { sha256Hex, signPayload, verifyPayload } from "@supreme/crypto";

/**
 * @supreme/ota — the cloud Firmware/OTA service (blueprint §9, §14).
 *
 * Publishes signed release manifests per channel (stable/beta/…) and controls a DETERMINISTIC
 * staged rollout: a release is offered to a percentage cohort, and a given hub's eligibility is
 * a stable function of its id (so a hub never flip-flops between "offered" and "not"). The hub
 * verifies the manifest signature offline before applying (the OS updater stages + rolls back).
 * The cloud only decides AVAILABILITY; it never pushes — hubs poll `availableFor`.
 */

export type Channel = "stable" | "beta" | "dev";

export interface ReleaseManifest {
  version: string;
  channel: Channel;
  /** Signed artifact location + integrity digest. */
  url: string;
  sha256: string;
  /** Minimum current version required to take this update (skip-protection). */
  minVersion?: string;
  notes?: string;
  publishedAt: number;
}

export interface SignedRelease {
  manifest: ReleaseManifest;
  /** Ed25519 signature over the canonical manifest (verified on the hub, offline). */
  signature: string;
  /** 0–100: fraction of the channel's fleet currently eligible. */
  rolloutPercent: number;
}

/** Compare dotted numeric versions: -1 | 0 | 1. Non-numeric segments compare lexically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    const cmp = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : nx - ny;
    if (cmp !== 0) return Math.sign(cmp);
  }
  return 0;
}

/** Stable rollout bucket [0,100) for a hub+version — same inputs always yield the same bucket. */
export function rolloutBucket(hubId: string, version: string): number {
  const h = sha256Hex(`${hubId}|${version}`);
  // Top 32 bits of the digest → [0,100).
  return (parseInt(h.slice(0, 8), 16) % 10_000) / 100;
}

export interface IReleaseStore {
  put(release: SignedRelease): void;
  latestForChannel(channel: Channel): SignedRelease | undefined;
  setRollout(channel: Channel, version: string, percent: number): void;
}

export class InMemoryReleaseStore implements IReleaseStore {
  private byChannel = new Map<Channel, SignedRelease[]>();
  put(release: SignedRelease) {
    const list = this.byChannel.get(release.manifest.channel) ?? [];
    list.push(release);
    this.byChannel.set(release.manifest.channel, list);
  }
  latestForChannel(channel: Channel) {
    const list = this.byChannel.get(channel) ?? [];
    return [...list].sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0];
  }
  setRollout(channel: Channel, version: string, percent: number) {
    const r = (this.byChannel.get(channel) ?? []).find((x) => x.manifest.version === version);
    if (r) r.rolloutPercent = Math.max(0, Math.min(100, percent));
  }
}

export class OtaError extends Error {}

export interface OtaOptions {
  signingPrivateKey: string;
  signingPublicKey: string;
  store?: IReleaseStore;
  now?: () => number;
}

export class OtaService {
  private readonly priv: string;
  readonly publicKey: string;
  private readonly store: IReleaseStore;
  private readonly now: () => number;

  constructor(opts: OtaOptions) {
    this.priv = opts.signingPrivateKey;
    this.publicKey = opts.signingPublicKey;
    this.store = opts.store ?? new InMemoryReleaseStore();
    this.now = opts.now ?? (() => Date.now());
  }

  /** Publish a release: sign the manifest and store it (rollout starts at `rolloutPercent`). */
  publish(manifest: Omit<ReleaseManifest, "publishedAt">, rolloutPercent = 0): SignedRelease {
    const full: ReleaseManifest = { ...manifest, publishedAt: this.now() };
    const release: SignedRelease = { manifest: full, signature: signPayload(full, this.priv), rolloutPercent };
    this.store.put(release);
    return release;
  }

  setRollout(channel: Channel, version: string, percent: number): void {
    this.store.setRollout(channel, version, percent);
  }

  /**
   * What update (if any) a hub should be offered: the latest signed release on its channel that
   * is NEWER than its current version, passes minVersion, and whose rollout cohort includes it.
   */
  availableFor(hubId: string, channel: Channel, currentVersion: string): SignedRelease | null {
    const latest = this.store.latestForChannel(channel);
    if (!latest) return null;
    if (compareVersions(latest.manifest.version, currentVersion) <= 0) return null;
    if (latest.manifest.minVersion && compareVersions(currentVersion, latest.manifest.minVersion) < 0) return null;
    if (rolloutBucket(hubId, latest.manifest.version) >= latest.rolloutPercent) return null; // not in cohort yet
    return latest;
  }

  /** Verify a release manifest's signature (what the hub does offline before applying). */
  verify(release: SignedRelease): boolean {
    return verifyPayload(release.manifest, release.signature, this.publicKey);
  }
}
