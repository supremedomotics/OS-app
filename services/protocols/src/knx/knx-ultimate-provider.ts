import type { DiscoveredDevice } from "@supreme/integration-layer";
import type { IKnxProvider, KnxTask, ProviderDiagnostics, ProviderHealth } from "./provider.js";

/**
 * KNX Ultimate Provider (§ Internal Architecture) — the real KNXnet/IP transport,
 * backed by the `knxultimate` npm package (tunnelling over UDP). Owns everything the
 * Task Router routes to it: group-address communication, DPT encode/decode, bus
 * monitoring, bus reads/writes, KNX Secure, routing, and tunnelling.
 *
 * This is the ONLY file in the Supreme KNX Driver that imports `knxultimate` — exactly
 * mirroring how the rest of the platform never sees Home Assistant, nothing outside
 * this file (and nothing outside this driver at all) may know `knxultimate` exists.
 */

interface KnxUltimateModule {
  default?: KnxUltimateModule;
  KNXClient?: new (opts: Record<string, unknown>) => KnxUltimateClient;
  dptlib?: KnxUltimateDptLib;
}
interface KnxUltimateClient {
  Connect(): void;
  Disconnect(): Promise<void>;
  write(groupAddress: string, value: unknown, dpt: string): void;
  on(event: "connected", cb: () => void): KnxUltimateClient;
  on(event: "error", cb: (err: unknown) => void): KnxUltimateClient;
  on(event: "indication", cb: (packet: KnxUltimateIndication) => void): KnxUltimateClient;
}
interface KnxUltimateDptLib {
  resolve(dpt: string): unknown;
  fromBuffer(raw: Buffer, dptConfig: unknown): unknown;
}
interface KnxUltimateIndication {
  cEMIMessage?: {
    dstAddress?: { toString(): string };
    npdu?: { dataValue?: Buffer; isGroupWrite?: boolean; isGroupResponse?: boolean };
  };
}

export interface KnxUltimateProviderOptions {
  host: string;
  port?: number;
}

export class KnxUltimateProvider implements IKnxProvider {
  readonly name = "knx-ultimate";
  private readonly opts: KnxUltimateProviderOptions;
  private client: KnxUltimateClient | null = null;
  private dptlib: KnxUltimateDptLib | null = null;
  private readonly observers = new Map<string, { dpt: string; handler: (value: unknown) => void }[]>();

  // Real, incrementing-only counters — never fabricated (§ Diagnostics).
  private packetsSent = 0;
  private packetsReceived = 0;
  private lastTelegramAt: string | null = null;
  private lastCommandAt: string | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;

  constructor(opts: KnxUltimateProviderOptions) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    // Nothing to do ahead of connect() for a tunnelling client; kept as an explicit
    // lifecycle stage (§ Driver Provider Interface) so a future provider with real
    // pre-connect setup (e.g. loading an ETS-derived DPT table) has somewhere to put it.
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // KNX Ultimate has no LAN discovery of its own (that is KNX IoT's job, per the
    // Task Router's routing table) — group addresses are only known once bound from
    // an ETS import or manual entry. Never fabricates a discovery result.
    return [];
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const moduleName = "knxultimate";
    try {
      const imported = (await import(moduleName)) as unknown as KnxUltimateModule;
      const runtime = (imported.default ?? imported) as KnxUltimateModule;
      const Client = imported.KNXClient ?? runtime.KNXClient;
      const dptlib = imported.dptlib ?? runtime.dptlib;
      if (!Client || !dptlib) throw new Error("knxultimate did not expose KNXClient and dptlib");
      this.dptlib = dptlib;
      this.client = new Client({ hostProtocol: "TunnelUDP", ipAddr: this.opts.host, ipPort: this.opts.port ?? 3671 });
      this.wireIndications(this.client, dptlib);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        this.client!.on("connected", () => { settled = true; resolve(); });
        this.client!.on("error", (err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          if (!settled) reject(err instanceof Error ? err : new Error(String(err)));
        });
        this.client!.Connect();
      });
    } catch (err) {
      this.reconnectAttempts++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.client = null;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.Disconnect();
    this.client = null;
  }

  async shutdown(): Promise<void> {
    await this.disconnect();
    this.observers.clear();
  }

  private wireIndications(client: KnxUltimateClient, dptlib: KnxUltimateDptLib): void {
    client.on("indication", (packet) => {
      const cemi = packet.cEMIMessage;
      const dst = cemi?.dstAddress?.toString?.();
      const raw = cemi?.npdu?.dataValue;
      if (!dst || !raw) return;
      this.packetsReceived++;
      this.lastTelegramAt = new Date().toISOString();
      const handlers = this.observers.get(dst);
      if (!handlers?.length) return;
      for (const { dpt, handler } of handlers) handler(dptlib.fromBuffer(raw, dptlib.resolve(dpt)));
    });
  }

  async execute(task: KnxTask): Promise<unknown> {
    if (!this.client) throw new Error("knx-ultimate: not connected");
    if (task.kind === "bus.group_write") {
      this.client.write(task.groupAddress, task.value, task.dpt);
      this.packetsSent++;
      this.lastCommandAt = new Date().toISOString();
      return undefined;
    }
    if (task.kind === "bus.group_read") {
      // KNX Ultimate's tunnelling client has no synchronous group-read primitive in
      // this driver's current transport wiring — status is learned passively via
      // subscribe(), matching the existing (pre-refactor) KnxProtocolDriver's own
      // behavior exactly. Documented, not silently faked (§ Diagnostics).
      throw new Error("knx-ultimate: active group-read is not implemented; subscribe() for passive status instead");
    }
    throw new Error(`knx-ultimate: unsupported task "${(task as KnxTask).kind}"`);
  }

  subscribe(groupAddress: string, dpt: string, handler: (value: unknown) => void): void {
    const list = this.observers.get(groupAddress) ?? [];
    list.push({ dpt, handler });
    this.observers.set(groupAddress, list);
  }

  unsubscribe(groupAddress: string): void {
    this.observers.delete(groupAddress);
  }

  health(): ProviderHealth {
    return { connected: this.client !== null, lastError: this.lastError };
  }

  diagnostics(): ProviderDiagnostics {
    return {
      provider: this.name,
      connected: this.client !== null,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      lastTelegramAt: this.lastTelegramAt,
      lastCommandAt: this.lastCommandAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}
