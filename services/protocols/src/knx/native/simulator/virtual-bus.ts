/**
 * SIMULATION INFRASTRUCTURE — a virtual KNX line: devices with individual addresses,
 * group telegram delivery, actuator models and injectable device faults.
 *
 * Everything here is a MODEL. A passing test against it proves driver logic, not that a
 * real actuator, coupler or gateway behaves this way; hardware-in-the-loop validation is a
 * separate, still-outstanding release gate.
 */
import { decodeDpt, encodeDpt } from "../dpt.js";
import type { GroupData, GroupService } from "../cemi.js";
import type { KnxValue } from "../../../knx-codec.js";
import type { Clock } from "../transport.js";

export interface BusTelegram {
  source: number;
  destination: number;
  service: GroupService;
  data: GroupData | null;
}

export interface VirtualDevice {
  readonly individualAddress: number;
  online: boolean;
  receive(t: BusTelegram, bus: VirtualKnxBus): void;
}

export class VirtualKnxBus {
  private readonly devices = new Map<number, VirtualDevice>();
  private readonly monitors = new Set<(t: BusTelegram) => void>();
  private readonly ring: BusTelegram[] = [];
  /** When set, `transmit` reports a bus-level failure (no actuator ACK on the line). */
  lineFault = false;

  constructor(readonly clock: Clock, private readonly historyLimit = 256) {}

  addDevice(d: VirtualDevice): void {
    if (this.devices.has(d.individualAddress)) throw new Error(`duplicate individual address 0x${d.individualAddress.toString(16)}`);
    this.devices.set(d.individualAddress, d);
  }

  device(ia: number): VirtualDevice | undefined { return this.devices.get(ia); }

  /** Observes every telegram placed on the line (tunnel interfaces use this to relay). */
  monitor(fn: (t: BusTelegram) => void): () => void { this.monitors.add(fn); return () => { this.monitors.delete(fn); }; }

  get history(): readonly BusTelegram[] { return this.ring; }

  /** Places a telegram on the line. Returns false if the line is faulted (nothing is
   * delivered, mirroring a frame no device acknowledged). */
  transmit(t: BusTelegram): boolean {
    if (this.lineFault) return false;
    this.ring.push(t);
    if (this.ring.length > this.historyLimit) this.ring.shift();
    for (const m of [...this.monitors]) m(t);
    for (const d of [...this.devices.values()]) {
      if (d.individualAddress !== t.source && d.online) d.receive(t, this);
    }
    return true;
  }
}

export interface ActuatorFaults {
  /** Ignores command writes entirely (e.g. channel locked/overridden at the actuator). */
  stuck?: boolean;
  /** Never emits status writes or answers reads. */
  noFeedback?: boolean;
  /** Status write is delayed by this many ms. */
  feedbackDelayMs?: number;
  /** Reports the opposite of its true state (wrong object flag / inverted mapping). */
  invertFeedback?: boolean;
  /** Publishes status on this GA instead of the configured one (ETS mapping error). */
  feedbackWrongGa?: number;
  /** Sends a status payload of the wrong size for the DPT. */
  malformedFeedback?: boolean;
  /** PHYSICAL fault: the load does not light although the actuator reports ON. Invisible to
   * KNX by design — exists so tests prove the diagnosis engine never asserts it from data. */
  loadFailed?: boolean;
}

export interface ActuatorConfig {
  individualAddress: number;
  commandGa: number;
  feedbackGa: number | null;
  dpt: string;
  initial: KnxValue;
}

export class VirtualActuator implements VirtualDevice {
  online = true;
  faults: ActuatorFaults = {};
  private _state: KnxValue;
  readonly received: BusTelegram[] = [];

  constructor(private readonly cfg: ActuatorConfig, private readonly clock: Clock) {
    this._state = cfg.initial;
  }

  get individualAddress(): number { return this.cfg.individualAddress; }
  /** The state the actuator believes it is in. */
  get state(): KnxValue { return this._state; }
  /** Ground truth about the physical load — NOT derivable from any bus telegram. */
  get physicalLoadActive(): boolean {
    const on = typeof this._state === "boolean" ? this._state : typeof this._state === "number" && this._state > 0;
    return this.online && on && !this.faults.loadFailed;
  }

  receive(t: BusTelegram, bus: VirtualKnxBus): void {
    this.received.push(t);
    if (this.received.length > 64) this.received.shift();
    if (t.destination === this.cfg.commandGa && t.service === "write" && t.data) {
      if (this.faults.stuck) return;
      try { this._state = decodeDpt(this.cfg.dpt, t.data); } catch { return; }
      this.publish(bus, "write");
    } else if (this.cfg.feedbackGa !== null && t.destination === this.cfg.feedbackGa && t.service === "read") {
      this.publish(bus, "response");
    }
  }

  private publish(bus: VirtualKnxBus, service: "write" | "response"): void {
    if (this.cfg.feedbackGa === null || this.faults.noFeedback) return;
    const send = (): void => {
      if (!this.online) return;
      let value = this._state;
      if (this.faults.invertFeedback && typeof value === "boolean") value = !value;
      let data = encodeDpt(this.cfg.dpt, value);
      if (this.faults.malformedFeedback) data = { kind: "bytes", bytes: Buffer.from([0xde, 0xad, 0xbe]) };
      bus.transmit({ source: this.cfg.individualAddress, destination: this.faults.feedbackWrongGa ?? this.cfg.feedbackGa!, service, data });
    };
    const delay = this.faults.feedbackDelayMs ?? 0;
    if (delay > 0) this.clock.setTimeout(send, delay); else send();
  }
}

/** A device that only originates telegrams (wall switch, keypad, sensor). */
export class VirtualSender implements VirtualDevice {
  online = true;
  constructor(readonly individualAddress: number) {}
  receive(): void { /* senders ignore the line */ }
  emit(bus: VirtualKnxBus, destination: number, dpt: string, value: KnxValue): boolean {
    if (!this.online) return false;
    return bus.transmit({ source: this.individualAddress, destination, service: "write", data: encodeDpt(dpt, value) });
  }
}
