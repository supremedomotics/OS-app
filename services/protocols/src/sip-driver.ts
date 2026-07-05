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
 * SIP door-station driver (§3). SIP (RFC 3261) is real-time comms, not capability
 * control, so this driver maps only the parts of a video door intercom that fit the
 * Supreme model: **door release → `lock`** (unlock = open the door) and a **ring → a
 * `sensor` event** the homeowner can be notified on / automate against. Live audio/
 * video is out of scope here (that belongs to a media subsystem).
 *
 * The SIP user agent (registration, INVITE handling, DTMF door-open, BYE) is a full
 * stack, so it's an injectable seam: production wires a real UA (e.g. sip.js); tests
 * inject a fake station. The capability mapping itself is fully unit-tested.
 */
export interface SipRingEvent {
  /** The bound station id that is ringing. */
  stationId: string;
  /** Optional caller identity (SIP From). */
  caller?: string;
}

export interface SipDoorStation {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Open the door for a station (DTMF during the call, or the station's open API). */
  openDoor(stationId: string): Promise<void>;
  /** Subscribe to inbound ring/call events from any registered station. */
  onRing(handler: (event: SipRingEvent) => void): void;
}

export interface SipDriverOptions {
  /** SIP registrar/server, e.g. "sip:pbx.local". */
  server?: string;
  username?: string;
  password?: string;
  /** Injectable user agent (tests pass a fake; prod wires a real SIP UA). */
  createStation?: (opts: SipDriverOptions) => Promise<SipDoorStation>;
}

interface SipBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  stationId: string;
}

export class SipProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "sip";
  private station: SipDoorStation | null = null;
  private readonly opts: SipDriverOptions;
  private readonly bindings: SipBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();

  constructor(opts: SipDriverOptions = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.station) return;
    const factory = this.opts.createStation ?? defaultSipStation;
    this.station = await factory(this.opts);
    await this.station.start();
    this.station.onRing((event) => this.onRing(event));
  }

  async disconnect(): Promise<void> {
    await this.station?.stop();
    this.station = null;
  }

  isConnected(): boolean {
    return this.station !== null;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    if (binding.capability !== "lock" && binding.capability !== "sensor") {
      throw new Error(`sip: capability ${binding.capability} not supported (lock | sensor)`);
    }
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, stationId: binding.address });
    this.devices.add(binding.deviceId);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.station) throw new Error("sip: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`sip: ${deviceId} not bound for ${command.capability}`);
    if (command.capability !== "lock") throw new Error(`sip: unsupported command for ${command.capability}`);
    if (command.action === "unlock") {
      await this.station.openDoor(b.stationId);
      // Momentary release: reflect "unlocked" — a real station relatches shortly after.
      this.record(deviceId, "lock", { kind: "lock", locked: false, jammed: false });
    } else {
      this.record(deviceId, "lock", { kind: "lock", locked: true, jammed: false });
    }
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return []; // door stations are added by their SIP id
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onRing(event: SipRingEvent): void {
    // Surface a ring as a momentary sensor pulse on any sensor binding for the station.
    for (const b of this.bindings) {
      if (b.capability !== "sensor" || b.stationId !== event.stationId) continue;
      this.record(b.deviceId, "sensor", { kind: "sensor", value: 1, unit: "", measure: "ring" });
    }
  }

  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState): void {
    // A ring is an event, not a level — always emit it (don't dedupe sensor pulses).
    const k = bindingKey(deviceId, capability);
    const prev = this.states.get(k);
    if (capability !== "sensor" && prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId, capability, state, ts: new Date().toISOString() });
    }
  }
}

/** Default UA — a real hub wires a SIP user agent here (e.g. sip.js). */
async function defaultSipStation(_opts: SipDriverOptions): Promise<SipDoorStation> {
  throw new Error(
    "sip: no user agent configured — provide createStation (a registered SIP UA, e.g. sip.js)",
  );
}
