import type { SignedDriverBundle } from "@supreme/domain-model";
import { createBundle, signBundle } from "@supreme/driver-sdk";
import { FIRST_PARTY_MANIFESTS } from "./manifests.js";

/**
 * The Driver Store catalog source (§9). On a real deployment this is the cloud
 * Driver Store API / CDN mirror; the hub Driver Manager queries it (and works from
 * a local mirror offline). Catalog entries are signed bundles, verified on the hub
 * before install.
 */
export interface ICatalog {
  list(): Promise<SignedDriverBundle[]>;
  find(key: string, version?: string): Promise<SignedDriverBundle | null>;
}

/** In-memory catalog used in dev/tests, seeded with the first-party drivers. */
export class InMemoryCatalog implements ICatalog {
  private readonly entries: SignedDriverBundle[];

  constructor(entries: SignedDriverBundle[]) {
    this.entries = entries;
  }

  async list(): Promise<SignedDriverBundle[]> {
    return this.entries;
  }
  async find(key: string, version?: string): Promise<SignedDriverBundle | null> {
    const matches = this.entries.filter((e) => e.bundle.manifest.key === key);
    if (version) return matches.find((e) => e.bundle.manifest.version === version) ?? null;
    // Latest published version wins.
    return (
      matches
        .filter((e) => e.bundle.status === "published")
        .sort((a, b) => cmpVersion(b.bundle.manifest.version, a.bundle.manifest.version))[0] ?? null
    );
  }
}

/**
 * Build a signed first-party catalog using a publisher signing key. In production
 * the signing happens in the certification pipeline; here it seeds dev/test stores
 * deterministically.
 */
export function seedFirstPartyCatalog(privateKeyPem: string, signingKeyId: string): SignedDriverBundle[] {
  return FIRST_PARTY_MANIFESTS.map((manifest) => {
    const bundle = createBundle({
      manifest,
      payload: `first-party:${manifest.key}@${manifest.version}`,
      bundleUrl: `supreme-store://${manifest.key}/${manifest.version}`,
    });
    return signBundle(bundle, privateKeyPem, signingKeyId);
  });
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
