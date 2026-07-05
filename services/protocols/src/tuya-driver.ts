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

/**
 * Tuya driver (§3). Tuya is a PROPRIETARY ecosystem — devices are controlled either via
 * the Tuya Cloud API (signed, developer account) or locally over an encrypted protocol
 * that needs each device's LOCAL KEY (extracted once from the cloud). Either path is an
 * injectable {@link TuyaDevice} client seam here (a real impl wraps tuyapi / the cloud
 * SDK); the capability↔DPS mapping is the tested IP. Tuya exposes function "data points"
 * (DPS) whose indices are DEVICE-SPECIFIC, so a binding's `config` supplies them:
 *   { dpOnoff?: 1, dpBright?: 2, brightMin?: 10, brightMax?: 1000, dpPosition?: 3 }
 */
export interface TuyaDevice {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Write one or more data points. */
  set(dps: Record<string, unknown>): Promise<void>;
  /** Read the current data points. */
  get(): Promise<Record<string, unknown>>;
  /** Subscribe to pushed DPS updates. */
  onData(handler: (dps: Record<string, unknown>) => void): void;
}
/** Resolve a device client for a Tuya device id. */
export type TuyaConnect = (deviceId: string, config: Record<string, unknown>) => Promise<TuyaDevice>;

export interface TuyaDriverOptions {
  pollMs?: number;
  connect?: TuyaConnect;
}

interface TuyaDp {
  onoff: string;
  bright: string;
  position: string;
  brightMin: number;
  brightMax: number;
}
interface TuyaBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  client: TuyaDevice;
  dp: TuyaDp;
}

function dpConfig(config: Record<string, unknown>): TuyaDp {
  return {
    onoff: String(config.dpOnoff ?? "1"),
    bright: String(config.dpBright ?? "2"),
    position: String(config.dpPosition ?? "3"),
    brightMin: typeof config.brightMin === "number" ? config.brightMin : 10,
    brightMax: typeof config.brightMax === "number" ? config.brightMax : 1000,
  };
}

export class TuyaProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "tuya";
  private connected = false;
  private readonly opts: TuyaDriverOptions;
  private readonly bindings: TuyaBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private readonly clients = new Map<string, TuyaDevice>();

  constructor(opts: TuyaDriverOptions = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    for (const c of this.clients.values()) await c.disconnect();
    this.clients.clear();
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const config = binding.config ?? {};
    let client = this.clients.get(binding.address);
    if (!client) {
      const connect = this.opts.connect ?? defaultTuyaConnect;
      client = await connect(binding.address, config);
      await client.connect();
      client.onData((dps) => this.onDps(binding.address, dps));
      this.clients.set(binding.address, client);
    }
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, client, dp: dpConfig(config) });
    this.devices.add(binding.deviceId);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`tuya: ${deviceId} not bound for ${command.capability}`);
    const dps = this.commandToDps(command, b);
    if (!dps) throw new Error(`tuya: unsupported command for ${command.capability}`);
    await b.client.set(dps);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return []; // Tuya devices are enumerated from the cloud account (follow-on)
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commandToDps(command: CapabilityCommand, b: TuyaBinding): Record<string, unknown> | null {
    if (command.capability === "onoff") {
      const on =
        command.action === "on"
          ? true
          : command.action === "off"
            ? false
            : !(this.states.get(bindingKey(b.deviceId, "onoff")) as { on?: boolean } | undefined)?.on;
      return { [b.dp.onoff]: on };
    }
    if (command.capability === "brightness") {
      if (command.action === "off") return { [b.dp.onoff]: false };
      const level = typeof command.level === "number" ? command.level : 100;
      return { [b.dp.onoff]: true, [b.dp.bright]: this.scaleToTuya(level, b.dp) };
    }
    if (command.capability === "position") {
      const pos =
        command.action === "open" ? 100 : command.action === "close" ? 0 : (command.position ?? 0);
      return { [b.dp.position]: Math.max(0, Math.min(100, Math.round(pos))) };
    }
    return null;
  }

  private onDps(address: string, dps: Record<string, unknown>): void {
    for (const b of this.bindings) {
      if (b.client !== this.clients.get(address)) continue;
      const state = this.stateFromDps(b, dps);
      if (state) this.record(b.deviceId, b.capability, state);
    }
  }

  private stateFromDps(b: TuyaBinding, dps: Record<string, unknown>): CapabilityState | null {
    if (b.capability === "onoff" && b.dp.onoff in dps) {
      return { kind: "onoff", on: Boolean(dps[b.dp.onoff]) };
    }
    if (b.capability === "brightness" && b.dp.bright in dps) {
      const on = b.dp.onoff in dps ? Boolean(dps[b.dp.onoff]) : true;
      return { kind: "brightness", on, level: this.scaleFromTuya(Number(dps[b.dp.bright]), b.dp) };
    }
    if (b.capability === "position" && b.dp.position in dps) {
      return { kind: "position", position: Math.max(0, Math.min(100, Math.round(Number(dps[b.dp.position])))), moving: false };
    }
    return null;
  }

  private scaleToTuya(pct: number, dp: TuyaDp): number {
    const p = Math.max(0, Math.min(100, pct));
    return Math.round(dp.brightMin + (p / 100) * (dp.brightMax - dp.brightMin));
  }
  private scaleFromTuya(raw: number, dp: TuyaDp): number {
    const span = dp.brightMax - dp.brightMin || 1;
    return Math.max(0, Math.min(100, Math.round(((raw - dp.brightMin) / span) * 100)));
  }

  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState): void {
    const k = bindingKey(deviceId, capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId, capability, state, ts: new Date().toISOString() });
    }
  }
}

async function defaultTuyaConnect(): Promise<TuyaDevice> {
  throw new Error("tuya: no device client configured — provide connect() (tuyapi local, or the Tuya Cloud SDK)");
}
