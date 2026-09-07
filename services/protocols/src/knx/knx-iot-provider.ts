import type { DiscoveredDevice } from "@supreme/integration-layer";
import type { IKnxProvider, KnxTask, ProviderDiagnostics, ProviderHealth } from "./provider.js";
import {
  CoapKnxIotTransport,
  COAP_ALL_NODES_MULTICAST,
  COAP_DEFAULT_PORT,
  type IKnxIotTransport,
} from "./knx-iot-transport.js";

/**
 * KNX IoT Provider (§ Internal Architecture, § Compatibility Report) — real client for
 * the KNX Association's KNX IoT Point API, built on the documented wire protocol
 * (CoAP multicast discovery, CoAP GET for resources). Registered ONLY for
 * `discovery.metadata` and `discovery.functional_blocks` in {@link SupremeKnxDriver} —
 * bus/dpt/security/transport communication remains {@link "./knx-ultimate-provider.js"
 * KnxUltimateProvider}'s job (§ no duplication between providers).
 *
 * `discovery.semantic`/`discovery.resource_model`/`discovery.room_metadata` are NOT
 * implemented here — there is no live KNX IoT device in this environment to validate a
 * real GET/parse cycle against, so they stay honestly unregistered rather than guessed
 * at from documentation alone (same discipline as KNX Ultimate's `bus.group_read` gap).
 */
export interface KnxIotProviderOptions {
  multicastAddress?: string;
  port?: number;
  discoveryTimeoutMs?: number;
  /** Injectable for tests; defaults to the real CoAP/UDP transport. */
  transport?: IKnxIotTransport;
}

export class KnxIotProvider implements IKnxProvider {
  readonly name = "knx-iot";
  private readonly multicastAddress: string;
  private readonly port: number;
  private readonly discoveryTimeoutMs: number;
  private readonly transport: IKnxIotTransport;
  private connected = false;

  // Real, incrementing-only counters — never fabricated (§ Diagnostics).
  private packetsSent = 0;
  private packetsReceived = 0;
  private lastTelegramAt: string | null = null;
  private lastCommandAt: string | null = null;
  private lastError: string | null = null;

  constructor(opts: KnxIotProviderOptions = {}) {
    this.multicastAddress = opts.multicastAddress ?? COAP_ALL_NODES_MULTICAST;
    this.port = opts.port ?? COAP_DEFAULT_PORT;
    this.discoveryTimeoutMs = opts.discoveryTimeoutMs ?? 3000;
    this.transport = opts.transport ?? new CoapKnxIotTransport();
  }

  async initialize(): Promise<void> {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async shutdown(): Promise<void> {
    await this.disconnect();
  }

  /** Real CoAP multicast discovery on `/.well-known/core` (§ KNX IoT Point API spec).
   * Each responding device becomes one {@link DiscoveredDevice} with no capabilities
   * assigned yet — functional blocks (and therefore capabilities) require the separate
   * `discovery.functional_blocks` follow-up, since discovery and capability resolution
   * are two distinct CoAP round-trips in the real protocol, not one. */
  async discover(): Promise<DiscoveredDevice[]> {
    this.packetsSent++;
    const entries = await this.transport.discoverOnce(this.multicastAddress, this.port, this.discoveryTimeoutMs);
    if (entries.length > 0) {
      this.packetsReceived += entries.length;
      this.lastTelegramAt = new Date().toISOString();
    }
    return entries.map((e) => ({
      backendId: `knx-iot:${e.host}`,
      suggestedName: e.host,
      capabilities: [],
      raw: { host: e.host, port: this.port, linkFormat: e.linkFormat, source: "knx-iot" },
    }));
  }

  async execute(task: KnxTask): Promise<unknown> {
    if (task.kind === "discovery.functional_blocks") {
      this.lastCommandAt = new Date().toISOString();
      this.packetsSent++;
      try {
        const body = await this.transport.get(task.host, task.port ?? this.port, "/fb", this.discoveryTimeoutMs);
        this.packetsReceived++;
        this.lastTelegramAt = new Date().toISOString();
        return body;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }
    throw new Error(`knx-iot: unsupported task "${task.kind}"`);
  }

  /** This provider is never registered for `bus.monitor` — group-address state
   * observation stays KNX Ultimate's job (§ no duplication), so subscribing here is a
   * configuration error. Real KNX IoT resource observation (CoAP Observe) is a distinct
   * capability, exposed separately as {@link observeResource} rather than overloading
   * this method's group-address-keyed contract. */
  subscribe(): void {
    throw new Error("knx-iot: subscribe() is not applicable — this provider is not registered for bus.monitor");
  }
  unsubscribe(): void {}

  /** Real CoAP Observe (§ Observe Layer) on a KNX IoT resource — never exposes a raw
   * CoAP notification to the caller, only the decoded payload string; translating that
   * into a Supreme event is {@link "./supreme-knx-driver.js" SupremeKnxDriver}'s job. */
  observeResource(host: string, pathname: string, onUpdate: (payload: string) => void, port = this.port): () => void {
    return this.transport.observe(host, port, pathname, (payload) => {
      this.packetsReceived++;
      this.lastTelegramAt = new Date().toISOString();
      onUpdate(payload);
    }, (err) => {
      this.lastError = err.message;
    });
  }

  health(): ProviderHealth {
    return { connected: this.connected, lastError: this.lastError };
  }

  diagnostics(): ProviderDiagnostics {
    return {
      provider: this.name,
      connected: this.connected,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      lastTelegramAt: this.lastTelegramAt,
      lastCommandAt: this.lastCommandAt,
      lastError: this.lastError,
      reconnectAttempts: 0,
    };
  }
}
