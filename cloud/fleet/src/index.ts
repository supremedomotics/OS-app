import { newId, type HomeId } from "@supreme/domain-model";

/**
 * Cloud fleet management (§13, §16) — OPTIONAL, opt-in. Lets an installer
 * organization oversee many homes/hubs from one place: register hubs, receive
 * heartbeats, and see online/offline status. Multi-tenant by `orgId`; a hub never
 * depends on this for in-home function (the hub is fully self-sufficient).
 */
export interface Hub {
  id: string;
  orgId: string;
  homeId: HomeId;
  name: string;
  /** Hub software version reported at registration / heartbeat. */
  version: string;
  registeredAt: string;
  lastSeenAt: string;
}

export type HubStatus = "online" | "offline";

export interface HubView extends Hub {
  status: HubStatus;
}

export interface IFleetStore {
  put(hub: Hub): Promise<void>;
  get(id: string): Promise<Hub | null>;
  listByOrg(orgId: string): Promise<Hub[]>;
}

export class InMemoryFleetStore implements IFleetStore {
  private readonly hubs = new Map<string, Hub>();
  async put(hub: Hub) {
    this.hubs.set(hub.id, hub);
  }
  async get(id: string) {
    return this.hubs.get(id) ?? null;
  }
  async listByOrg(orgId: string) {
    return [...this.hubs.values()].filter((h) => h.orgId === orgId);
  }
}

export interface FleetOptions {
  store?: IFleetStore;
  /** A hub is "offline" if it hasn't been seen within this many ms. */
  offlineAfterMs?: number;
  now?: () => number;
}

export class FleetService {
  private readonly store: IFleetStore;
  private readonly offlineAfterMs: number;
  private readonly now: () => number;

  constructor(opts: FleetOptions = {}) {
    this.store = opts.store ?? new InMemoryFleetStore();
    this.offlineAfterMs = opts.offlineAfterMs ?? 90_000;
    this.now = opts.now ?? Date.now;
  }

  /** Register (or re-register) a hub under an installer org. */
  async register(input: { orgId: string; homeId: HomeId; name: string; version: string }): Promise<Hub> {
    const ts = new Date(this.now()).toISOString();
    const hub: Hub = {
      id: newId("home").replace("home", "hub"),
      orgId: input.orgId,
      homeId: input.homeId,
      name: input.name,
      version: input.version,
      registeredAt: ts,
      lastSeenAt: ts,
    };
    await this.store.put(hub);
    return hub;
  }

  /** Record a heartbeat from a hub (keeps it "online"). */
  async heartbeat(hubId: string, version?: string): Promise<Hub> {
    const hub = await this.store.get(hubId);
    if (!hub) throw new Error(`unknown hub ${hubId}`);
    const updated: Hub = { ...hub, lastSeenAt: new Date(this.now()).toISOString(), version: version ?? hub.version };
    await this.store.put(updated);
    return updated;
  }

  /** List an org's hubs with derived online/offline status. */
  async listForOrg(orgId: string): Promise<HubView[]> {
    const hubs = await this.store.listByOrg(orgId);
    return hubs.map((h) => ({ ...h, status: this.statusOf(h) }));
  }

  private statusOf(hub: Hub): HubStatus {
    return this.now() - new Date(hub.lastSeenAt).getTime() <= this.offlineAfterMs ? "online" : "offline";
  }
}

export { buildFleetServer, type FleetServerOptions } from "./server.js";
