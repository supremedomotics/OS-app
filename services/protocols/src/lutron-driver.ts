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
import { commandToLutron, parseLutronLine, stateFromLutronLevel } from "./lutron-codec.js";

export interface LutronDriverOptions {
  /** Bridge / main repeater host (RA2/HWQS or Caséta Smart Bridge Pro). */
  host: string;
  /** LIP Telnet port (default 23). */
  port?: number;
  /** Integration login (default "lutron"). */
  username?: string;
  /** Integration password (default "integration"). */
  password?: string;
  createSocket?: (host: string, port: number) => net.Socket;
}

interface LutronBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  id: string;
}

/**
 * Real Lutron driver (§3) over LIP/Telnet — covers WIRED RadioRA 2 / HomeWorks QS and
 * WIRELESS Caséta Smart Bridge Pro through the same integration protocol. Handles the
 * login/password handshake, drives outputs by integration ID, and parses `~OUTPUT`
 * level reports into onoff / brightness / position. Single bridge, many outputs.
 */
export class LutronProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "lutron";
  private socket: net.Socket | null = null;
  private buffer = "";
  private ready = false;
  private readonly opts: LutronDriverOptions;
  private readonly bindings: LutronBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();

  constructor(opts: LutronDriverOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    const port = this.opts.port ?? 23;
    this.socket = this.opts.createSocket
      ? this.opts.createSocket(this.opts.host, port)
      : net.connect(port, this.opts.host);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("close", () => {
      this.socket = null;
      this.ready = false;
    });
    this.socket.on("error", () => {
      /* lazy reconnect on next command */
    });
  }

  async disconnect(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.ready = false;
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, id: binding.address });
    this.devices.add(binding.deviceId);
    if (this.ready) this.query(binding.address);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.socket) throw new Error("lutron: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`lutron: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const line = commandToLutron(command, b.id, prev);
    if (!line) throw new Error(`lutron: unsupported command for ${command.capability}`);
    this.socket.write(`${line}\r\n`);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Output discovery needs the integration report / DbExportXML; commissioning binds
    // outputs by integration ID explicitly for now.
    return [];
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private query(id: string): void {
    this.socket?.write(`?OUTPUT,${id},1\r\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // The bridge prompts ("login:"/"password:"/"GNET>") arrive WITHOUT a newline, so
    // split on newlines AND treat each prompt token as a delimiter.
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? "";
    // The trailing fragment may itself be a prompt — handle it too without consuming.
    for (const line of [...lines, this.buffer]) this.onLine(line);
    if (parseLutronLine(this.buffer)) this.buffer = "";
  }

  private onLine(line: string): void {
    const parsed = parseLutronLine(line);
    if (!parsed) return;
    if (parsed.kind === "login") {
      this.socket?.write(`${this.opts.username ?? "lutron"}\r\n`);
    } else if (parsed.kind === "password") {
      this.socket?.write(`${this.opts.password ?? "integration"}\r\n`);
    } else if (parsed.kind === "ready") {
      if (!this.ready) {
        this.ready = true;
        for (const b of this.bindings) this.query(b.id);
      }
    } else if (parsed.kind === "output") {
      for (const b of this.bindings) {
        if (b.id !== parsed.id) continue;
        const state = stateFromLutronLevel(b.capability, parsed.level);
        if (state) this.record(b.deviceId, b.capability, state);
      }
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
