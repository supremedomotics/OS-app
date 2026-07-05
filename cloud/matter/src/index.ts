import { uuidv7 } from "@supreme/hub-identity";

/**
 * @supreme/matter-cloud — Matter fabric/credential brokering (blueprint §9).
 *
 * Supreme runs the on-network Matter controller/bridge ON THE HUB; this cloud service brokers
 * FABRIC state and credentials so a home's Matter fabric can be multi-admin (Supreme + a
 * third-party ecosystem like Apple Home or Google) and future Matter-cloud APIs are coordinated
 * centrally. It models fabric creation, admin (multi-admin) membership, and per-node operational
 * credential records — the metadata layer above the hub's real Matter PKI/commissioning.
 */

export interface Fabric {
  id: string;
  homeId: string;
  fabricId: string; // 64-bit Matter fabric id (hex)
  rootRef: string; // reference to the trusted root (RCAC) held by the hub
  createdAt: number;
}

export interface FabricAdmin {
  fabricId: string;
  adminNodeId: string;
  label: string; // e.g. "Supreme Hub", "Apple Home", "Google"
  addedAt: number;
}

export interface MatterNode {
  fabricId: string;
  nodeId: string;
  vendorId: number;
  productId: number;
  /** Operational credential reference (NOC issued under the fabric). */
  nocRef: string;
  commissionedAt: number;
}

export interface IMatterStore {
  putFabric(f: Fabric): void;
  getFabric(id: string): Fabric | undefined;
  fabricsForHome(homeId: string): Fabric[];
  putAdmin(a: FabricAdmin): void;
  admins(fabricId: string): FabricAdmin[];
  putNode(n: MatterNode): void;
  nodes(fabricId: string): MatterNode[];
}

export class InMemoryMatterStore implements IMatterStore {
  private fabrics = new Map<string, Fabric>();
  private adminsByFabric = new Map<string, FabricAdmin[]>();
  private nodesByFabric = new Map<string, MatterNode[]>();
  putFabric(f: Fabric) {
    this.fabrics.set(f.id, f);
  }
  getFabric(id: string) {
    return this.fabrics.get(id);
  }
  fabricsForHome(homeId: string) {
    return [...this.fabrics.values()].filter((f) => f.homeId === homeId);
  }
  putAdmin(a: FabricAdmin) {
    const list = this.adminsByFabric.get(a.fabricId) ?? [];
    list.push(a);
    this.adminsByFabric.set(a.fabricId, list);
  }
  admins(fabricId: string) {
    return this.adminsByFabric.get(fabricId) ?? [];
  }
  putNode(n: MatterNode) {
    const list = this.nodesByFabric.get(n.fabricId) ?? [];
    list.push(n);
    this.nodesByFabric.set(n.fabricId, list);
  }
  nodes(fabricId: string) {
    return this.nodesByFabric.get(fabricId) ?? [];
  }
}

export class MatterError extends Error {}

let fabricCounter = 0x1000;

export class MatterCloudService {
  private readonly store: IMatterStore;
  private readonly now: () => number;

  constructor(opts: { store?: IMatterStore; now?: () => number } = {}) {
    this.store = opts.store ?? new InMemoryMatterStore();
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Get the home's fabric, creating it (with the Supreme hub as founding admin) on first call.
   * Idempotent so a hub re-enabling Matter or re-syncing doesn't fork a second fabric.
   */
  ensureFabric(homeId: string, supremeAdminNodeId = "0x1"): Fabric {
    const existing = this.store.fabricsForHome(homeId)[0];
    return existing ?? this.createFabric(homeId, supremeAdminNodeId);
  }

  /** Create a home's Matter fabric with the Supreme hub as the founding admin. */
  createFabric(homeId: string, supremeAdminNodeId = "0x1"): Fabric {
    const fabric: Fabric = {
      id: uuidv7(this.now()),
      homeId,
      fabricId: `0x${(++fabricCounter).toString(16).toUpperCase()}`,
      rootRef: `rcac-${uuidv7(this.now())}`,
      createdAt: this.now(),
    };
    this.store.putFabric(fabric);
    this.store.putAdmin({ fabricId: fabric.fabricId, adminNodeId: supremeAdminNodeId, label: "Supreme Hub", addedAt: this.now() });
    return fabric;
  }

  /** Add a co-admin (multi-admin: share the fabric with Apple Home / Google / etc.). */
  addAdmin(fabricId: string, adminNodeId: string, label: string): FabricAdmin {
    const admin: FabricAdmin = { fabricId, adminNodeId, label, addedAt: this.now() };
    this.store.putAdmin(admin);
    return admin;
  }

  admins(fabricId: string): FabricAdmin[] {
    return this.store.admins(fabricId);
  }

  /** Commission a node into the fabric (records its operational credential reference). Idempotent
   * per (fabricId, nodeId): re-syncing the same node returns the existing record instead of forking. */
  commissionNode(input: { fabricId: string; nodeId: string; vendorId: number; productId: number }): MatterNode {
    const existing = this.store.nodes(input.fabricId).find((n) => n.nodeId === input.nodeId);
    if (existing) return existing;
    const node: MatterNode = {
      fabricId: input.fabricId,
      nodeId: input.nodeId,
      vendorId: input.vendorId,
      productId: input.productId,
      nocRef: `noc-${uuidv7(this.now())}`,
      commissionedAt: this.now(),
    };
    this.store.putNode(node);
    return node;
  }

  nodes(fabricId: string): MatterNode[] {
    return this.store.nodes(fabricId);
  }

  fabricsForHome(homeId: string): Fabric[] {
    return this.store.fabricsForHome(homeId);
  }
}

// HTTP surface (the hub syncs fabric/node metadata here for multi-admin coordination).
export { buildMatterServer, type MatterServerOptions } from "./server.js";
