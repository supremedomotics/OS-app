import { signPayload, verifyPayload } from "@supreme/crypto";

/**
 * @supreme/subscription — Subscription & Licensing (blueprint §13, §20).
 *
 * Plans grant ENTITLEMENTS (feature flags); the service issues signed, OFFLINE-VALIDATABLE
 * license tokens the hub stores and verifies with an embedded public key — so an air-gapped
 * install stays licensed and local features never black out on a billing hiccup (invariant
 * I1/I2). Re-validation is periodic and optional.
 */

export type Plan = "free" | "essential" | "pro" | "estate";
export type Feature =
  | "remote_access"
  | "push"
  | "cloud_backup"
  | "heavy_ai"
  | "voice_assistants"
  | "multi_home"
  | "fleet"
  | "energy_analytics";

/** Plan → entitlements. Local control + automation are ALWAYS available (never gated). */
export const PLAN_FEATURES: Record<Plan, Feature[]> = {
  free: ["remote_access", "push", "multi_home"],
  essential: ["remote_access", "push", "multi_home", "voice_assistants"],
  pro: ["remote_access", "push", "multi_home", "voice_assistants", "cloud_backup", "energy_analytics"],
  estate: ["remote_access", "push", "multi_home", "voice_assistants", "cloud_backup", "energy_analytics", "heavy_ai", "fleet"],
};

export interface Subscription {
  accountId: string;
  plan: Plan;
  status: "active" | "past_due" | "canceled";
  entitlements: Feature[];
  currentPeriodEnd: number;
  providerRef?: string;
}

/** A signed, offline-validatable license bound to a home/hub. */
export interface License {
  homeId: string;
  hubId: string;
  sku: Plan;
  features: Feature[];
  issuedAt: number;
  expiresAt: number;
}
export interface SignedLicense {
  license: License;
  signature: string;
}

export interface ISubscriptionStore {
  put(sub: Subscription): void;
  get(accountId: string): Subscription | undefined;
}
export class InMemorySubscriptionStore implements ISubscriptionStore {
  private subs = new Map<string, Subscription>();
  put(sub: Subscription) {
    this.subs.set(sub.accountId, sub);
  }
  get(accountId: string) {
    return this.subs.get(accountId);
  }
}

export interface SubscriptionOptions {
  signingPrivateKey: string;
  signingPublicKey: string;
  store?: ISubscriptionStore;
  now?: () => number;
  /** License validity in ms (default 90 days — re-issued on renewal). */
  licenseTtlMs?: number;
}

export class SubscriptionService {
  private readonly priv: string;
  readonly publicKey: string;
  private readonly store: ISubscriptionStore;
  private readonly now: () => number;
  private readonly licenseTtlMs: number;

  constructor(opts: SubscriptionOptions) {
    this.priv = opts.signingPrivateKey;
    this.publicKey = opts.signingPublicKey;
    this.store = opts.store ?? new InMemorySubscriptionStore();
    this.now = opts.now ?? (() => Date.now());
    this.licenseTtlMs = opts.licenseTtlMs ?? 90 * 24 * 60 * 60_000;
  }

  /** Create or change an account's subscription; entitlements derive from the plan. */
  subscribe(accountId: string, plan: Plan, opts: { periodMs?: number; providerRef?: string } = {}): Subscription {
    const sub: Subscription = {
      accountId,
      plan,
      status: "active",
      entitlements: PLAN_FEATURES[plan],
      currentPeriodEnd: this.now() + (opts.periodMs ?? 30 * 24 * 60 * 60_000),
      providerRef: opts.providerRef,
    };
    this.store.put(sub);
    return sub;
  }

  cancel(accountId: string): void {
    const sub = this.store.get(accountId);
    if (sub) this.store.put({ ...sub, status: "canceled" });
  }

  get(accountId: string): Subscription | undefined {
    return this.store.get(accountId);
  }

  /** Whether an account currently holds an entitlement (active + within period). */
  hasEntitlement(accountId: string, feature: Feature): boolean {
    const sub = this.store.get(accountId);
    if (!sub || sub.status === "canceled") return false;
    if (this.now() >= sub.currentPeriodEnd && sub.status !== "active") return false;
    return sub.entitlements.includes(feature);
  }

  /** Issue a signed license for a home/hub the hub can validate OFFLINE. */
  issueLicense(input: { accountId: string; homeId: string; hubId: string }): SignedLicense {
    const sub = this.store.get(input.accountId);
    const plan: Plan = sub?.plan ?? "free";
    const license: License = {
      homeId: input.homeId,
      hubId: input.hubId,
      sku: plan,
      features: PLAN_FEATURES[plan],
      issuedAt: this.now(),
      expiresAt: this.now() + this.licenseTtlMs,
    };
    return { license, signature: signPayload(license, this.priv) };
  }

  /** Verify a signed license offline (what the hub does with the embedded public key). */
  verifyLicense(signed: SignedLicense, nowMs: number = this.now()): { valid: boolean; reason?: string } {
    if (!verifyPayload(signed.license, signed.signature, this.publicKey)) return { valid: false, reason: "bad signature" };
    if (nowMs >= signed.license.expiresAt) return { valid: false, reason: "expired" };
    return { valid: true };
  }
}
