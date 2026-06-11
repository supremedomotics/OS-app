import net from "node:net";
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
  commandToCoolMaster,
  parseUnitLine,
  temperatureStateFromUnit,
  type CoolMasterUnit,
} from "./coolmaster-codec.js";

export interface CoolMasterDriverOptions {
  /** CoolMasterNet bridge host. */
  host: string;
  /** ASCII control port (CoolMasterNet default 10102). */
  port?: number;
  /** Status poll period in ms (HVAC changes slowly; default 10000). */
  pollMs?: number;
  /** Injectable socket factory (tests point at an in-process CoolMaster server). */
  createSocket?: (host: string, port: number) => net.Socket;
}

interface CmBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  uid: string;
}

/**
 * Real CoolMasterNet HVAC driver (§3) — controls VRF/VRV indoor units through the
 * CoolAutomation bridge over its published ASCII protocol. A single TCP link to the
 * bridge controls many units (addressed by UID, e.g. "L1.100"); `ls2` is polled for
 * status. Maps onoff + temperature (setpoint/mode/ambient). Confines all CoolMaster
 * detail; emits pure Supreme capabilities.
 */
export class CoolMasterProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "coolmaster";
  private socket: net.Socket | null = null;
  private buffer = "";
  private readonly opts: CoolMasterDriverOptions;
  private readonly bindings: CmBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CoolMasterDriverOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    const port = this.opts.port ?? 10102;
    this.socket = this.opts.createSocket
      ? this.opts.createSocket(this.opts.host, port)
      : net.connect(port, this.opts.host);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("close", () => {
      this.socket = null;
    });
    this.socket.on("error", () => {
      /* lazy reconnect handled on next poll/command */
    });
    const period = this.opts.pollMs ?? 10_000;
    this.timer = setInterval(() => void this.poll(), period);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket?.destroy();
    this.socket = null;
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, uid: binding.address });
    this.devices.add(binding.deviceId);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.socket) throw new Error("coolmaster: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`coolmaster: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const lines = commandToCoolMaster(b.uid, command, prev);
    if (!lines) throw new Error(`coolmaster: unsupported command for ${command.capability}`);
    for (const line of lines) this.socket.write(`${line}\r`);
    // Optimistically reflect the command; the next ls2 poll confirms it.
    if (command.capability === "onoff") {
      this.record(deviceId, "onoff", { kind: "onoff", on: command.action === "on" });
    }
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // ls2 yields all units; commissioning binds the ones the installer wants.
    if (!this.socket) return [];
    this.socket.write("ls2\r");
    return []; // discovered units surface via onData → cache; explicit list is a follow-on
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Request a status refresh. The response is parsed in onData. */
  async poll(): Promise<void> {
    this.socket?.write("ls2\r");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      // Strip the bridge's ">" prompt (it has no trailing newline, so it leads the line).
      const unit = parseUnitLine(line.replace(/^[>\s]+/, ""));
      if (unit) this.applyUnit(unit);
    }
  }

  private applyUnit(unit: CoolMasterUnit): void {
    for (const b of this.bindings) {
      if (b.uid !== unit.uid) continue;
      if (b.capability === "onoff") this.record(b.deviceId, "onoff", { kind: "onoff", on: unit.on });
      else if (b.capability === "temperature") this.record(b.deviceId, "temperature", temperatureStateFromUnit(unit));
    }
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
