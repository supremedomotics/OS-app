import { uuidv7 } from "@supreme/hub-identity";

/**
 * @supreme/dealer — the Installer/Dealer service (blueprint §14).
 *
 * Dealer organizations manage technicians and customer sites, assign hubs to sites, and request
 * OWNER-GRANTED, TIME-BOXED remote service access to a hub. Remote service is always
 * owner-authorized, auto-expiring, revocable, and audited — a technician never has standing
 * access to a customer's home.
 */

export interface Org {
  id: string;
  name: string;
  createdAt: number;
}
export interface Technician {
  orgId: string;
  accountId: string;
  role: "owner" | "tech";
}
export interface Site {
  id: string;
  orgId: string;
  name: string;
  customerAccountId: string | null;
  hubIds: string[];
  createdAt: number;
}
export interface ServiceGrant {
  id: string;
  hubId: string;
  technicianAccountId: string;
  grantedByAccountId: string; // the home owner
  validFrom: number;
  validUntil: number;
  revokedAt: number | null;
}

export interface IDealerStore {
  putOrg(o: Org): void;
  getOrg(id: string): Org | undefined;
  putTech(t: Technician): void;
  techs(orgId: string): Technician[];
  putSite(s: Site): void;
  getSite(id: string): Site | undefined;
  sites(orgId: string): Site[];
  putGrant(g: ServiceGrant): void;
  grantsForHub(hubId: string): ServiceGrant[];
}

export class InMemoryDealerStore implements IDealerStore {
  private orgs = new Map<string, Org>();
  private technicians: Technician[] = [];
  private siteMap = new Map<string, Site>();
  private grants: ServiceGrant[] = [];
  putOrg(o: Org) {
    this.orgs.set(o.id, o);
  }
  getOrg(id: string) {
    return this.orgs.get(id);
  }
  putTech(t: Technician) {
    this.technicians.push(t);
  }
  techs(orgId: string) {
    return this.technicians.filter((t) => t.orgId === orgId);
  }
  putSite(s: Site) {
    this.siteMap.set(s.id, s);
  }
  getSite(id: string) {
    return this.siteMap.get(id);
  }
  sites(orgId: string) {
    return [...this.siteMap.values()].filter((s) => s.orgId === orgId);
  }
  putGrant(g: ServiceGrant) {
    this.grants.push(g);
  }
  grantsForHub(hubId: string) {
    return this.grants.filter((g) => g.hubId === hubId);
  }
}

export class DealerError extends Error {
  constructor(readonly code: "not_found" | "forbidden", message: string) {
    super(message);
  }
}

export class DealerService {
  private readonly store: IDealerStore;
  private readonly now: () => number;

  constructor(opts: { store?: IDealerStore; now?: () => number } = {}) {
    this.store = opts.store ?? new InMemoryDealerStore();
    this.now = opts.now ?? (() => Date.now());
  }

  createOrg(name: string, ownerAccountId: string): Org {
    const org: Org = { id: uuidv7(this.now()), name, createdAt: this.now() };
    this.store.putOrg(org);
    this.store.putTech({ orgId: org.id, accountId: ownerAccountId, role: "owner" });
    return org;
  }

  addTechnician(orgId: string, accountId: string): Technician {
    if (!this.store.getOrg(orgId)) throw new DealerError("not_found", "org not found");
    const tech: Technician = { orgId, accountId, role: "tech" };
    this.store.putTech(tech);
    return tech;
  }

  technicians(orgId: string): Technician[] {
    return this.store.techs(orgId);
  }

  isTechnician(orgId: string, accountId: string): boolean {
    return this.store.techs(orgId).some((t) => t.accountId === accountId);
  }

  createSite(orgId: string, name: string, customerAccountId: string | null = null): Site {
    if (!this.store.getOrg(orgId)) throw new DealerError("not_found", "org not found");
    const site: Site = { id: uuidv7(this.now()), orgId, name, customerAccountId, hubIds: [], createdAt: this.now() };
    this.store.putSite(site);
    return site;
  }

  assignHub(siteId: string, hubId: string): Site {
    const site = this.store.getSite(siteId);
    if (!site) throw new DealerError("not_found", "site not found");
    if (!site.hubIds.includes(hubId)) site.hubIds.push(hubId);
    this.store.putSite(site);
    return site;
  }

  sites(orgId: string): Site[] {
    return this.store.sites(orgId);
  }

  /** Owner grants a technician time-boxed remote service to a hub. */
  grantRemoteService(input: {
    hubId: string;
    technicianAccountId: string;
    grantedByAccountId: string;
    durationMs?: number;
  }): ServiceGrant {
    const grant: ServiceGrant = {
      id: uuidv7(this.now()),
      hubId: input.hubId,
      technicianAccountId: input.technicianAccountId,
      grantedByAccountId: input.grantedByAccountId,
      validFrom: this.now(),
      validUntil: this.now() + (input.durationMs ?? 60 * 60_000), // default 1h
      revokedAt: null,
    };
    this.store.putGrant(grant);
    return grant;
  }

  revokeRemoteService(grantId: string, hubId: string): void {
    const grant = this.store.grantsForHub(hubId).find((g) => g.id === grantId);
    if (grant) grant.revokedAt = this.now();
  }

  /** Whether a technician currently has ACTIVE remote service to a hub (window + not revoked). */
  hasActiveServiceGrant(hubId: string, technicianAccountId: string): boolean {
    const now = this.now();
    return this.store.grantsForHub(hubId).some(
      (g) =>
        g.technicianAccountId === technicianAccountId &&
        g.revokedAt === null &&
        now >= g.validFrom &&
        now < g.validUntil,
    );
  }
}
