import { type HomeId, type License } from "@supreme/domain-model";
import { issueLicense } from "./index.js";

/**
 * Dealer licensing (§9 commercial). A dealer issues signed licenses for their customers' hubs,
 * transfers a license to a replacement hub, revokes it, and sees the activation history + seats in
 * use. Reuses {@link issueLicense} (Ed25519, hub-bound by homeId) — no parallel crypto. Pure service
 * over a pluggable record store; the cloud REST layer + dealer portal call it.
 */
export type LicenseRecordStatus = "issued" | "activated" | "revoked" | "transferred";

export interface LicenseRecord {
  id: string;
  dealerOrgId: string;
  /** The hub/home this license is bound to. */
  homeId: string;
  sku: string;
  features: string[];
  seats: number;
  issuedAt: string;
  expiresAt: string | null;
  status: LicenseRecordStatus;
  activatedAt: string | null;
  /** When transferred, the record this one supersedes (for the audit trail). */
  supersedes: string | null;
}

export interface ILicenseRecordStore {
  list(dealerOrgId: string): Promise<LicenseRecord[]>;
  get(id: string): Promise<LicenseRecord | null>;
  put(record: LicenseRecord): Promise<void>;
}

export class InMemoryLicenseRecordStore implements ILicenseRecordStore {
  private readonly records = new Map<string, LicenseRecord>();
  async list(dealerOrgId: string): Promise<LicenseRecord[]> {
    return [...this.records.values()].filter((r) => r.dealerOrgId === dealerOrgId).sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
  }
  async get(id: string): Promise<LicenseRecord | null> {
    return this.records.get(id) ?? null;
  }
  async put(record: LicenseRecord): Promise<void> {
    this.records.set(record.id, record);
  }
}

export class DealerLicensingError extends Error {}

export interface IssueForCustomerInput {
  dealerOrgId: string;
  homeId: string;
  sku: string;
  seats?: number;
  features?: string[];
  expiresAt?: string | null;
}

export class DealerLicensingService {
  constructor(
    private readonly store: ILicenseRecordStore,
    private readonly privateKeyPem: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Issue a signed license for a customer hub and record it. Returns the token to deliver + the record. */
  async issue(input: IssueForCustomerInput): Promise<{ license: License; record: LicenseRecord }> {
    const license = issueLicense(
      { homeId: input.homeId as HomeId, sku: input.sku, seats: input.seats ?? 1, features: input.features ?? [], expiresAt: input.expiresAt ?? null },
      this.privateKeyPem,
    );
    const record: LicenseRecord = {
      id: license.id,
      dealerOrgId: input.dealerOrgId,
      homeId: input.homeId,
      sku: input.sku,
      features: input.features ?? [],
      seats: input.seats ?? 1,
      issuedAt: license.issuedAt,
      expiresAt: license.expiresAt,
      status: "issued",
      activatedAt: null,
      supersedes: null,
    };
    await this.store.put(record);
    return { license, record };
  }

  /** Mark a license activated (called when the hub reports it activated). */
  async markActivated(licenseId: string): Promise<LicenseRecord> {
    const rec = await this.require(licenseId);
    if (rec.status === "revoked") throw new DealerLicensingError("license is revoked");
    const updated: LicenseRecord = { ...rec, status: "activated", activatedAt: this.now().toISOString() };
    await this.store.put(updated);
    return updated;
  }

  /** Revoke a license (customer churned / fraud). Seats free up. */
  async revoke(licenseId: string): Promise<LicenseRecord> {
    const rec = await this.require(licenseId);
    const updated: LicenseRecord = { ...rec, status: "revoked" };
    await this.store.put(updated);
    return updated;
  }

  /**
   * Transfer a license to a replacement hub: the token is hub-bound, so this REVOKES the old record
   * and ISSUES a fresh signed license for the new hub, preserving sku/features/expiry. Returns the
   * new token + record.
   */
  async transfer(licenseId: string, newHomeId: string): Promise<{ license: License; record: LicenseRecord }> {
    const rec = await this.require(licenseId);
    await this.store.put({ ...rec, status: "transferred" });
    const issued = await this.issue({ dealerOrgId: rec.dealerOrgId, homeId: newHomeId, sku: rec.sku, seats: rec.seats, features: rec.features, expiresAt: rec.expiresAt });
    const record: LicenseRecord = { ...issued.record, supersedes: rec.id };
    await this.store.put(record);
    return { license: issued.license, record };
  }

  /** The dealer's full issuance/activation history, newest first. */
  history(dealerOrgId: string): Promise<LicenseRecord[]> {
    return this.store.list(dealerOrgId);
  }

  /** Seats currently in use (activated, not revoked/transferred) across the dealer's customers. */
  async seatsInUse(dealerOrgId: string): Promise<number> {
    const records = await this.store.list(dealerOrgId);
    return records.filter((r) => r.status === "activated").reduce((n, r) => n + r.seats, 0);
  }

  private async require(id: string): Promise<LicenseRecord> {
    const rec = await this.store.get(id);
    if (!rec) throw new DealerLicensingError("license record not found");
    return rec;
  }
}
