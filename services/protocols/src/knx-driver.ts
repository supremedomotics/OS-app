import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import {
  bindingKey,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { defaultDpt, stateFromValue, valueFromCommand, type KnxValue } from "./knx-codec.js";

/**
 * KNXnet/IP transport seam. A real KNXnet/IP connection (tunnelling or routing) is
 * injected or loaded from `knxultimate`; this keeps the byte-level DPT framing in
 * the transport and lets the driver be unit-tested against a fake bus.
 */
export interface KnxConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Group-write a decoded value to a group address with the given DPT. */
  write(groupAddress: string, value: KnxValue, dpt: string): Promise<void>;
  /** Observe a status group address (decoded per DPT); handler runs on each update. */
  observe(groupAddress: string, dpt: string, handler: (value: KnxValue) => void): void;
}

export interface KnxDriverOptions {
  /** KNXnet/IP gateway host (tunnelling) or multicast group (routing). */
  host: string;
  port?: number;
  /** Injectable transport (tests pass a fake bus; prod loads `knxultimate`). */
  createConnection?: (opts: { host: string; port: number }) => Promise<KnxConnection>;
}

interface KnxBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  /** Group address commands are written to. */
  writeGa: string;
  /** Group address status is read from (defaults to writeGa). */
  statusGa: string;
  dpt: string;
  config: Record<string, unknown>;
}

/**
 * Real KNXnet/IP protocol driver (§3, §7) — KNX is the backbone of high-end European
 * installs (lighting, blinds, HVAC). Commands are KNX group-writes; device status is
 * observed on (often separate) status group addresses. The driver confines all KNX
 * framing and emits pure Supreme capabilities upward.
 */
export class KnxProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "knx";
  private conn: KnxConnection | null = null;
  private readonly opts: KnxDriverOptions;
  private readonly bindings: KnxBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();

  constructor(opts: KnxDriverOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.conn) return;
    const factory = this.opts.createConnection ?? defaultKnxConnection;
    this.conn = await factory({ host: this.opts.host, port: this.opts.port ?? 3671 });
    await this.conn.connect();
    for (const b of this.bindings) this.observe(b);
  }

  async disconnect(): Promise<void> {
    await this.conn?.disconnect();
    this.conn = null;
  }

  isConnected(): boolean {
    return this.conn !== null;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const cfg = binding.config ?? {};
    const entry: KnxBinding = {
      deviceId: binding.deviceId,
      capability: binding.capability,
      writeGa: binding.address,
      statusGa: typeof cfg.statusAddress === "string" ? cfg.statusAddress : binding.address,
      dpt: typeof cfg.dpt === "string" ? cfg.dpt : defaultDpt(binding.capability as CapabilityState["kind"]),
      config: cfg,
    };
    this.bindings.push(entry);
    this.devices.add(binding.deviceId);
    if (this.conn) this.observe(entry);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.conn) throw new Error("knx: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`knx: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const value = valueFromCommand(command, prev);
    if (value === null) throw new Error(`knx: unsupported command for ${command.capability}`);
    await this.conn.write(b.writeGa, value, b.dpt);
    // Optimistically reflect the command; a status telegram will confirm/correct it.
    const optimistic = stateFromValue(b.capability as CapabilityState["kind"], value, b.config);
    if (optimistic) this.record(b, optimistic);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // KNX has no device discovery without an ETS project import; devices are
    // commissioned explicitly from their group-address map.
    return [];
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private observe(b: KnxBinding): void {
    if (!this.conn) return;
    this.conn.observe(b.statusGa, b.dpt, (value) => {
      const state = stateFromValue(b.capability as CapabilityState["kind"], value, b.config);
      if (state) this.record(b, state);
    });
  }

  private record(b: KnxBinding, state: CapabilityState): void {
    const k = bindingKey(b.deviceId, b.capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId: b.deviceId, capability: b.capability, state, ts: new Date().toISOString() });
    }
  }
}

/** Default transport backed by `knxultimate` (KNXnet/IP tunnelling over UDP). */
async function defaultKnxConnection(opts: { host: string; port: number }): Promise<KnxConnection> {
  const moduleName = "knxultimate";
  const imported = (await import(moduleName)) as unknown as KnxUltimateModule;
  const runtime = (imported.default ?? imported) as KnxUltimateModule;
  const Client = imported.KNXClient ?? runtime.KNXClient;
  const dptlib = imported.dptlib ?? runtime.dptlib;
  if (!Client || !dptlib) throw new Error("knx: knxultimate did not expose KNXClient and dptlib");

  const client = new Client({
    hostProtocol: "TunnelUDP",
    ipAddr: opts.host,
    ipPort: opts.port,
  });
  return wrapKnxUltimate(client, dptlib);
}

interface KnxUltimateModule {
  default?: KnxUltimateModule;
  KNXClient?: new (opts: Record<string, unknown>) => KnxUltimateClient;
  dptlib?: KnxUltimateDptLib;
}

interface KnxUltimateClient {
  Connect(): void;
  Disconnect(): Promise<void>;
  write(groupAddress: string, value: KnxValue, dpt: string): void;
  on(event: "connected", cb: () => void): KnxUltimateClient;
  on(event: "error", cb: (err: unknown) => void): KnxUltimateClient;
  on(event: "indication", cb: (packet: KnxUltimateIndication) => void): KnxUltimateClient;
}

interface KnxUltimateDptLib {
  resolve(dpt: string): unknown;
  fromBuffer(raw: Buffer, dptConfig: unknown): KnxValue;
}

interface KnxUltimateIndication {
  cEMIMessage?: {
    dstAddress?: { toString(): string };
    npdu?: {
      dataValue?: Buffer;
      isGroupWrite?: boolean;
      isGroupResponse?: boolean;
    };
  };
}

interface KnxUltimateObserver {
  dpt: string;
  handler: (value: KnxValue) => void;
}

function wrapKnxUltimate(client: KnxUltimateClient, dptlib: KnxUltimateDptLib): KnxConnection {
  const observers = new Map<string, KnxUltimateObserver[]>();
  client.on("indication", (packet) => {
    const cemi = packet.cEMIMessage;
    const dst = cemi?.dstAddress?.toString?.();
    const raw = cemi?.npdu?.dataValue;
    if (!dst || !raw) return;
    const handlers = observers.get(dst);
    if (!handlers?.length) return;
    for (const { dpt, handler } of handlers) {
      const value = dptlib.fromBuffer(raw, dptlib.resolve(dpt));
      handler(value);
    }
  });

  return {
    async connect() {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        client.on("connected", () => {
          settled = true;
          resolve();
        });
        client.on("error", (err) => {
          if (!settled) reject(err instanceof Error ? err : new Error(String(err)));
        });
        client.Connect();
      });
    },
    async disconnect() {
      await client.Disconnect();
    },
    async write(ga, value, dpt) {
      client.write(ga, value, dpt);
    },
    observe(ga, dpt, handler) {
      const handlers = observers.get(ga) ?? [];
      handlers.push({ dpt, handler });
      observers.set(ga, handlers);
    },
  };
}
