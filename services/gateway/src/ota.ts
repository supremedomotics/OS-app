import { verifyPayload } from "@supreme/crypto";

/**
 * OTA update channel (§14). The hub periodically checks a signed release manifest and
 * surfaces whether an update is available. It does NOT self-apply — applying is the OS
 * updater's job (staged rollout + rollback live there); the gateway only *detects* and
 * reports, and refuses an unsigned/forged manifest. Trust is an embedded Ed25519
 * public key, so an air-gapped or compromised channel can't push a bad release.
 */
export interface ReleaseManifest {
  channel: string;
  version: string;
  /** Signed artifact URL + content hash (the updater verifies the hash on download). */
  url: string;
  sha256: string;
  notes?: string;
  releasedAt: string;
}
export interface SignedReleaseManifest {
  manifest: ReleaseManifest;
  signature: string;
}

/** Verify a release manifest's Ed25519 signature against the embedded OTA public key. */
export function verifyReleaseManifest(signed: SignedReleaseManifest, publicKeyPem: string): boolean {
  return verifyPayload(signed.manifest, signed.signature, publicKeyPem);
}

/** Compare semver-ish versions (numeric dotted). Returns true if `candidate` > `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = candidate.split(".").map((n) => Number(n) || 0);
  const b = current.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export interface OtaCheckResult {
  updateAvailable: boolean;
  current: string;
  latest?: ReleaseManifest;
}

export interface OtaCheckerOptions {
  /** Signed-manifest URL for the channel, e.g. https://cloud/ota/stable.json. */
  url: string;
  /** Embedded OTA signing public key (PEM). */
  publicKeyPem: string;
  currentVersion: string;
  fetchImpl?: typeof fetch;
}

export class OtaChecker {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: OtaCheckerOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** Fetch + verify the channel manifest; report whether a newer signed release exists. */
  async check(): Promise<OtaCheckResult> {
    const res = await this.fetchImpl(this.opts.url);
    if (!res.ok) throw new Error(`ota ${res.status}`);
    const signed = (await res.json()) as SignedReleaseManifest;
    if (!verifyReleaseManifest(signed, this.opts.publicKeyPem)) {
      throw new Error("ota: manifest signature invalid — refusing");
    }
    const updateAvailable = isNewerVersion(signed.manifest.version, this.opts.currentVersion);
    return { updateAvailable, current: this.opts.currentVersion, latest: updateAvailable ? signed.manifest : undefined };
  }
}
