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
import {
  capabilitiesFromDeviceType,
  colorStateFromMireds,
  commandToDali,
  parseDaliAddress,
  stateFromArcLevel,
  type DaliAddress,
  type DimmingCurve,
} from "./dali-codec.js";

export interface DaliUnitInfo {
  shortAddress: number;
  deviceType: number;
}

/**
 * DALI bus transport seam. A real hub provides a master/interface bound to the DALI
 * line (a USB DALI interface, or an HTTP bridge to the python-dali commissioning
 * sidecar); tests inject a fake. All IEC 62386 byte framing lives in the bus impl, so
 * the codec/driver are fully unit-tested without hardware. DALI control gear does not
 * report spontaneously, so status is polled via `queryActualLevel`.
 */
export interface DaliBus {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Direct Arc Power Control: set level 0..254 (0 = off). */
  setArcPower(addr: DaliAddress, level: number): Promise<void>;
  /** DT8 colour temperature in mireds (DTR load → SET Tc → ACTIVATE sequence). */
  setColourTemperature(addr: DaliAddress, mireds: number): Promise<void>;
  /** Query the actual arc power level (0..254), or null if it can't be read. */
  queryActualLevel(addr: DaliAddress): Promise<number | null>;
  /** Commissioned short addresses + device types (for discovery). */
  scan(): Promise<DaliUnitInfo[]>;
}

export interface DaliDriverOptions {
  /** Serial port of the USB DALI interface, e.g. "/dev/ttyUSB0". */
  port?: string;
  /** Poll period in ms for actual-level status (default 5000). */
  pollMs?: number;
  /** Injectable bus (tests pass a fake; prod wires a real DALI interface). */
  createBus?: (opts: DaliDriverOptions) => Promise<DaliBus>;
}

interface DaliBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  addr: DaliAddress;
  curve: DimmingCurve;
  config: Record<string, unknown>;
}

/**
 * Real DALI (IEC 62386) protocol driver (§3) — addressable lighting common in luxury
 * installs (gallery tracks, architectural lighting). Commands become DALI operations
 * (DAPC level / off / DT8 colour temperature); status is polled via QUERY ACTUAL LEVEL.
 * Confines all DALI framing; emits pure Supreme capabilities upward.
 */
export class DaliProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "dali";
  private bus: DaliBus | null = null;
  private readonly opts: DaliDriverOptions;
  private readonly bindings: DaliBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DaliDriverOptions = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.bus) return;
    const factory = this.opts.createBus ?? defaultDaliBus;
    this.bus = await factory(this.opts);
    await this.bus.connect();
    const period = this.opts.pollMs ?? 5000;
    this.timer = setInterval(() => void this.poll(), period);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.bus?.disconnect();
    this.bus = null;
  }

  isConnected(): boolean {
    return this.bus !== null;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const cfg = binding.config ?? {};
    this.bindings.push({
      deviceId: binding.deviceId,
      capability: binding.capability,
      addr: parseDaliAddress(binding.address),
      curve: cfg.dimmingCurve === "linear" ? "linear" : "logarithmic",
      config: cfg,
    });
    this.devices.add(binding.deviceId);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.bus) throw new Error("dali: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`dali: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const op = commandToDali(command, prev, b.curve);
    if (!op) throw new Error(`dali: unsupported command for ${command.capability}`);

    if (op.op === "arc") {
      await this.bus.setArcPower(b.addr, op.level);
      const state = stateFromArcLevel(b.capability, op.level, b.curve);
      if (state) this.record(b, state);
    } else if (op.op === "off") {
      await this.bus.setArcPower(b.addr, 0);
      const state = stateFromArcLevel(b.capability, 0, b.curve);
      if (state) this.record(b, state);
    } else {
      await this.bus.setColourTemperature(b.addr, op.mireds);
      this.record(b, colorStateFromMireds(op.mireds, prev));
    }
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    if (!this.bus) return [];
    const units = await this.bus.scan();
    return units.map((u) => ({
      backendId: `short:${u.shortAddress}`,
      suggestedName: `DALI unit ${u.shortAddress}`,
      capabilities: capabilitiesFromDeviceType(u.deviceType),
      raw: { deviceType: u.deviceType },
    }));
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One poll cycle: query actual level for level-bearing bindings. Public for tests. */
  async poll(): Promise<void> {
    if (!this.bus) return;
    for (const b of this.bindings) {
      if (b.capability !== "onoff" && b.capability !== "brightness") continue;
      try {
        const level = await this.bus.queryActualLevel(b.addr);
        if (level === null) continue;
        const state = stateFromArcLevel(b.capability, level, b.curve);
        if (state) this.record(b, state);
      } catch {
        // A transient query error must not stop polling other units.
      }
    }
  }

  private record(b: DaliBinding, state: CapabilityState): void {
    const k = bindingKey(b.deviceId, b.capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId: b.deviceId, capability: b.capability, state, ts: new Date().toISOString() });
    }
  }
}

/** Default bus — a real hub wires a DALI interface here (USB master / sidecar bridge). */
async function defaultDaliBus(_opts: DaliDriverOptions): Promise<DaliBus> {
  throw new Error(
    "dali: no interface configured — provide createBus (a USB DALI master, or an HTTP " +
      "bridge to the python-dali commissioning sidecar)",
  );
}
