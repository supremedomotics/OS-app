import { connectAsync, type MqttClient } from "mqtt";
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
import { payloadFromCommand, stateFromPayload } from "./mqtt-codec.js";

export interface MqttDriverOptions {
  /** Broker URL, e.g. "mqtt://mqtt:1883". */
  url: string;
  /** Topic suffix a command is published to (Zigbee2MQTT: "/set"). */
  commandSuffix?: string;
  username?: string;
  password?: string;
  /** Injectable client factory (tests pass an embedded-broker connector). */
  connect?: (url: string, opts: Record<string, unknown>) => Promise<MqttClient>;
}

interface BoundCapability {
  deviceId: DeviceId;
  capability: CapabilityKind;
  baseTopic: string;
  config: Record<string, unknown>;
}

/**
 * Real MQTT protocol driver (§3, §7). Speaks the **Zigbee2MQTT/Tasmota** convention:
 * subscribes to each bound device's base topic for state and publishes commands to
 * `{base}/set`. This is the only component that knows MQTT framing — it emits pure
 * Supreme {@link CapabilityState} upward, so the SIL and everything above stay
 * protocol-agnostic. Connects to a real broker (the hub's Mosquitto); tests run it
 * against an embedded broker.
 */
export class MqttProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "mqtt";
  private client: MqttClient | null = null;
  private readonly opts: MqttDriverOptions;
  private readonly commandSuffix: string;
  /** base topic → the capabilities bound on it (one topic can carry on/off + brightness). */
  private readonly byTopic = new Map<string, BoundCapability[]>();
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();

  constructor(opts: MqttDriverOptions) {
    this.opts = opts;
    this.commandSuffix = opts.commandSuffix ?? "/set";
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const connector = this.opts.connect ?? connectAsync;
    this.client = await connector(this.opts.url, {
      username: this.opts.username,
      password: this.opts.password,
    });
    this.client.on("message", (topic: string, payload: Buffer) =>
      this.onMessage(topic, payload),
    );
    // Re-subscribe anything bound before connect (idempotent).
    for (const topic of this.byTopic.keys()) this.client.subscribe(topic);
  }

  async disconnect(): Promise<void> {
    await this.client?.endAsync();
    this.client = null;
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const entry: BoundCapability = {
      deviceId: binding.deviceId,
      capability: binding.capability,
      baseTopic: binding.address,
      config: binding.config ?? {},
    };
    const list = this.byTopic.get(binding.address) ?? [];
    list.push(entry);
    this.byTopic.set(binding.address, list);
    this.devices.add(binding.deviceId);
    if (this.client) this.client.subscribe(binding.address);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const entry = this.findBinding(deviceId, command.capability);
    if (!entry) throw new Error(`mqtt: ${deviceId} not bound for ${command.capability}`);
    if (!this.client) throw new Error("mqtt: not connected");
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const payload = payloadFromCommand(command, prev);
    if (!payload) throw new Error(`mqtt: unsupported command for ${command.capability}`);
    await this.client.publishAsync(`${entry.baseTopic}${this.commandSuffix}`, JSON.stringify(payload));
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // Active MQTT discovery (homeassistant/-style config topics) is a follow-on; for
    // now devices are commissioned explicitly via bind().
    return [];
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onMessage(topic: string, payload: Buffer): void {
    const bound = this.byTopic.get(topic);
    if (!bound) return;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload.toString()) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON retained/status payloads
    }
    for (const entry of bound) {
      const state = stateFromPayload(
        entry.capability as CapabilityState["kind"],
        json,
        entry.config,
      );
      if (!state) continue;
      this.states.set(bindingKey(entry.deviceId, entry.capability), state);
      for (const l of this.listeners) {
        l({ deviceId: entry.deviceId, capability: entry.capability, state, ts: new Date().toISOString() });
      }
    }
  }

  private findBinding(deviceId: DeviceId, capability: CapabilityKind): BoundCapability | undefined {
    for (const list of this.byTopic.values()) {
      const hit = list.find((b) => b.deviceId === deviceId && b.capability === capability);
      if (hit) return hit;
    }
    return undefined;
  }
}
