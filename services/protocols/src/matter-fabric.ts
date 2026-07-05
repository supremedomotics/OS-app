import type { MatterNodeInfo, MatterProtocolDriver } from "./matter-driver.js";

/**
 * Hub-side Matter fabric coordination (blueprint §9, ADR 0010). The hub owns the real fabric and
 * local control; this manager mirrors fabric/node METADATA to the OPTIONAL cloud Matter service so a
 * home's fabric can be multi-admin and centrally coordinated. Cloud sync is best-effort and
 * non-fatal — Matter keeps working on the hub if the cloud is unreachable (invariant: cloud is never
 * on the critical path).
 */

/** The cloud-sync seam. Production wires `HttpMatterFabricSync`; tests inject a fake. */
export interface MatterFabricSync {
  /** Idempotently ensure the home's fabric exists in the cloud; returns its fabric id. */
  ensureFabric(homeId: string): Promise<{ fabricId: string }>;
  /** Record a node the hub commissioned locally. */
  recordNode(fabricId: string, node: { nodeId: string; vendorId?: number; productId?: number }): Promise<void>;
}

export interface MatterFabricManagerOptions {
  driver: MatterProtocolDriver;
  homeId: string;
  /** Omit to run fully local (no cloud mirroring). */
  sync?: MatterFabricSync;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export class MatterFabricManager {
  private fabricId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly opts: MatterFabricManagerOptions;

  constructor(opts: MatterFabricManagerOptions) {
    this.opts = opts;
  }

  /** Begin mirroring: ensure the fabric, then forward every commissioned node to the cloud. */
  async start(): Promise<void> {
    if (this.opts.sync) {
      try {
        this.fabricId = (await this.opts.sync.ensureFabric(this.opts.homeId)).fabricId;
        this.opts.log?.("matter fabric synced to cloud", { fabricId: this.fabricId });
      } catch (err) {
        this.opts.log?.("matter fabric cloud sync unavailable (local-only)", { error: (err as Error).message });
      }
    }
    this.unsubscribe = this.opts.driver.onCommissioned((node) => void this.handleCommissioned(node));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get currentFabricId(): string | null {
    return this.fabricId;
  }

  private async handleCommissioned(node: MatterNodeInfo): Promise<void> {
    if (!this.opts.sync || !this.fabricId) return;
    try {
      await this.opts.sync.recordNode(this.fabricId, { nodeId: node.nodeId });
      this.opts.log?.("matter node mirrored to cloud", { nodeId: node.nodeId });
    } catch (err) {
      this.opts.log?.("matter node cloud sync failed (local commissioning unaffected)", { error: (err as Error).message });
    }
  }
}

/** HTTP client for the cloud Matter service (outbound-only; failures are swallowed by the manager). */
export class HttpMatterFabricSync implements MatterFabricSync {
  constructor(private readonly opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }) {}

  private get f(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }
  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" };
  }

  async ensureFabric(_homeId: string): Promise<{ fabricId: string }> {
    const res = await this.f(`${this.opts.baseUrl}/v1/matter/fabrics`, { method: "POST", headers: this.headers() });
    if (!res.ok) throw new Error(`ensureFabric failed (${res.status})`);
    const body = (await res.json()) as { fabric: { fabricId: string } };
    return { fabricId: body.fabric.fabricId };
  }

  async recordNode(fabricId: string, node: { nodeId: string; vendorId?: number; productId?: number }): Promise<void> {
    const res = await this.f(`${this.opts.baseUrl}/v1/matter/fabrics/${encodeURIComponent(fabricId)}/nodes`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(node),
    });
    if (!res.ok) throw new Error(`recordNode failed (${res.status})`);
  }
}
