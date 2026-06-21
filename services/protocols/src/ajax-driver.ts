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
 * Ajax security-sensor driver (§3). Ajax is a PROPRIETARY system with no open local
 * protocol — integration is via Ajax's cloud/partner API. So this maps Ajax device
 * events to the Supreme `sensor` capability behind an injectable client seam; a real
 * deployment supplies an authenticated Ajax API client (it needs partner access). The
 * capability mapping itself is fully unit-tested.
 *
 * Sensors are read-only: motion / contact (door-window) / leak / smoke / tamper events
 * surface as `sensor` states (value 1 = active). Bind `address` = the Ajax device id.
 */
export interface AjaxEvent {
  /** Ajax device id (matches a binding's address). */
  deviceId: string;
  /** "motion" | "contact" | "leak" | "smoke" | "tamper" | … */
  kind: string;
  /** Active (true) / cleared (false). */
  active: boolean;
}
export interface AjaxClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Subscribe to device events from the Ajax cloud/hub. */
  onEvent(handler: (event: AjaxEvent) => void): void;
}
export type AjaxConnect = () => Promise<AjaxClient>;

export interface AjaxDriverOptions {
  connect?: AjaxConnect;
}

interface AjaxBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  ajaxId: string;
}

export class AjaxProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "ajax";
  private client: AjaxClient | null = null;
  private readonly opts: AjaxDriverOptions;
  private readonly bindings: AjaxBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();

  constructor(opts: AjaxDriverOptions = {}) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const factory = this.opts.connect ?? defaultAjaxConnect;
    this.client = await factory();
    await this.client.start();
    this.client.onEvent((e) => this.onEvent(e));
  }
  async disconnect(): Promise<void> {
    await this.client?.stop();
    this.client = null;
  }
  isConnected(): boolean {
    return this.client !== null;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    if (binding.capability !== "sensor") {
      throw new Error(`ajax: capability ${binding.capability} not supported (sensor only)`);
    }
    this.bindings.push({ deviceId: binding.deviceId, capability: "sensor", ajaxId: binding.address });
    this.devices.add(binding.deviceId);
  }
  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(_deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    throw new Error(`ajax: ${command.capability} is read-only (security sensors)`);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return []; // Ajax devices are enumerated via the cloud account (follow-on)
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onEvent(event: AjaxEvent): void {
    for (const b of this.bindings) {
      if (b.ajaxId !== event.deviceId) continue;
      const state: CapabilityState = {
        kind: "sensor",
        value: event.active ? 1 : 0,
        unit: "",
        measure: event.kind,
      };
      // Security events are momentary signals — always emit (don't dedupe).
      this.states.set(bindingKey(b.deviceId, "sensor"), state);
      for (const l of this.listeners) {
        l({ deviceId: b.deviceId, capability: "sensor", state, ts: new Date().toISOString() });
      }
    }
  }
}

async function defaultAjaxConnect(): Promise<AjaxClient> {
  throw new Error("ajax: no API client configured — provide connect() (an authenticated Ajax cloud/partner client)");
}
