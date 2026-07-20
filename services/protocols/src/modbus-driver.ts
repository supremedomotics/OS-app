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
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";

/**
 * Real Modbus TCP protocol driver (§3, §7) — common for energy meters, plant/HVAC
 * controllers, and industrial relays in luxury installs. Modbus is poll-based (no
 * push), so the driver periodically reads each bound coil/register and emits a
 * Supreme state event when a value changes. It is the only component that knows
 * Modbus framing; everything above sees normalized capabilities.
 *
 * Binding `address` is the 0-based protocol address; `config` carries the register
 * `type` ("coil" | "discrete" | "holding" | "input"), optional `unitId`, and for
 * sensors a `scale`/`unit`/`measure`.
 */

// Minimal structural type for the slice of modbus-serial we use (dynamically imported
// to avoid CJS/ESM default-interop friction; it's a real dependency of this package).
interface ModbusClient {
  connectTCP(host: string, opts: { port: number }): Promise<void>;
  setID(id: number): void;
  close(cb: () => void): void;
  readCoils(addr: number, len: number): Promise<{ data: boolean[] }>;
  readDiscreteInputs(addr: number, len: number): Promise<{ data: boolean[] }>;
  readHoldingRegisters(addr: number, len: number): Promise<{ data: number[] }>;
  readInputRegisters(addr: number, len: number): Promise<{ data: number[] }>;
  writeCoil(addr: number, value: boolean): Promise<unknown>;
  writeRegister(addr: number, value: number): Promise<unknown>;
}

export interface ModbusDriverOptions {
  host: string;
  port?: number;
  /** Poll period in ms (default 2000). */
  pollMs?: number;
  /** Injectable client factory (tests pass a client pointed at an in-process server). */
  createClient?: () => Promise<ModbusClient>;
}

type RegType = "coil" | "discrete" | "holding" | "input";

interface ModbusBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  address: number;
  type: RegType;
  unitId: number;
  scale: number;
  unit: string;
  measure: string;
}

export class ModbusProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "modbus";
  private client: ModbusClient | null = null;
  private readonly opts: ModbusDriverOptions;
  private readonly bindings: ModbusBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ModbusDriverOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    if (this.opts.createClient) {
      this.client = await this.opts.createClient();
    } else {
      const moduleName = "modbus-serial";
      const mod = (await import(moduleName)) as unknown as { default: new () => ModbusClient };
      const Ctor = mod.default;
      this.client = new Ctor();
      await this.client.connectTCP(this.opts.host, { port: this.opts.port ?? 502 });
    }
    // Begin polling. Unref so the interval never holds the process open.
    const period = this.opts.pollMs ?? 2000;
    this.timer = setInterval(() => void this.poll(), period);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await new Promise<void>((resolve) => {
      if (!this.client) return resolve();
      this.client.close(() => resolve());
    });
    this.client = null;
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const cfg = binding.config ?? {};
    this.bindings.push({
      deviceId: binding.deviceId,
      capability: binding.capability,
      address: Number(binding.address),
      type: (typeof cfg.type === "string" ? cfg.type : "holding") as RegType,
      unitId: typeof cfg.unitId === "number" ? cfg.unitId : 1,
      scale: typeof cfg.scale === "number" ? cfg.scale : 1,
      unit: typeof cfg.unit === "string" ? cfg.unit : "",
      measure: typeof cfg.measure === "string" ? cfg.measure : "value",
    });
    this.devices.add(binding.deviceId);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  /** § Driver Lifecycle Completion — releases this one device's bindings/cached state
   * without touching the shared Modbus TCP client or poll timer (still needed for any
   * other bound register). Idempotent. */
  async unbind(deviceId: DeviceId): Promise<void> {
    removeDeviceBindings(this.bindings, deviceId);
    this.devices.delete(deviceId);
    removeDeviceStates(this.states, deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.client) throw new Error("modbus: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`modbus: ${deviceId} not bound for ${command.capability}`);
    this.client.setID(b.unitId);
    if (command.capability === "onoff") {
      const prev = this.states.get(bindingKey(deviceId, "onoff"));
      const on =
        command.action === "on"
          ? true
          : command.action === "off"
            ? false
            : !(prev?.kind === "onoff" ? prev.on : false);
      await this.client.writeCoil(b.address, on);
      this.record(b, { kind: "onoff", on });
      return;
    }
    throw new Error(`modbus: unsupported command for ${command.capability}`);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return []; // Modbus has no native discovery; devices are commissioned explicitly.
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One poll cycle: read every bound point and emit changed states. Public for tests. */
  async poll(): Promise<void> {
    if (!this.client) return;
    for (const b of this.bindings) {
      try {
        this.client.setID(b.unitId);
        const state = await this.readOne(b);
        if (state) this.record(b, state);
      } catch {
        // A transient read error must not stop polling other points.
      }
    }
  }

  private async readOne(b: ModbusBinding): Promise<CapabilityState | null> {
    if (!this.client) return null;
    if (b.capability === "onoff") {
      const fn = b.type === "discrete" ? this.client.readDiscreteInputs : this.client.readCoils;
      const { data } = await fn.call(this.client, b.address, 1);
      return { kind: "onoff", on: Boolean(data[0]) };
    }
    if (b.capability === "sensor") {
      const fn = b.type === "input" ? this.client.readInputRegisters : this.client.readHoldingRegisters;
      const { data } = await fn.call(this.client, b.address, 1);
      return { kind: "sensor", value: (data[0] ?? 0) * b.scale, unit: b.unit, measure: b.measure };
    }
    return null;
  }

  private record(b: ModbusBinding, state: CapabilityState): void {
    const k = bindingKey(b.deviceId, b.capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return; // no change → no event
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId: b.deviceId, capability: b.capability, state, ts: new Date().toISOString() });
    }
  }
}
