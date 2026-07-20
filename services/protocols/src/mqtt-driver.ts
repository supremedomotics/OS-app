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
import { discoveredFromZ2mBridge } from "./mqtt-discovery.js";
import { removeDeviceStates } from "./binding-cleanup.js";

export interface MqttDriverOptions {
  /** Broker URL, e.g. "mqtt://mqtt:1883". */
  url: string;
  /** Topic suffix a command is published to (Zigbee2MQTT: "/set"). */
  commandSuffix?: string;
  /** Zigbee2MQTT base topic for discovery (default "zigbee2mqtt"); "" disables it. */
  discoveryBaseTopic?: string;
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
  private readonly discoveryBaseTopic: string;
  private readonly discoveryTopic: string;
  /** base topic → the capabilities bound on it (one topic can carry on/off + brightness). */
  private readonly byTopic = new Map<string, BoundCapability[]>();
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  /** Latest Zigbee2MQTT bridge device list, mapped to Supreme discovery hints. */
  private discovered: DiscoveredDevice[] = [];

  constructor(opts: MqttDriverOptions) {
    this.opts = opts;
    this.commandSuffix = opts.commandSuffix ?? "/set";
    this.discoveryBaseTopic = opts.discoveryBaseTopic ?? "zigbee2mqtt";
    this.discoveryTopic = this.discoveryBaseTopic ? `${this.discoveryBaseTopic}/bridge/devices` : "";
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
    // Subscribe to the Zigbee2MQTT bridge device list (retained → arrives at once).
    if (this.discoveryTopic) this.client.subscribe(this.discoveryTopic);
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

  /** § Driver Lifecycle Completion — releases this one device's topic subscriptions
   * (unsubscribing a base topic only once no other device's capability still uses
   * it) and cached state, without touching the shared MQTT client. Idempotent. */
  async unbind(deviceId: DeviceId): Promise<void> {
    for (const [topic, list] of [...this.byTopic]) {
      const remaining = list.filter((b) => b.deviceId !== deviceId);
      if (remaining.length === list.length) continue;
      if (remaining.length === 0) {
        this.byTopic.delete(topic);
        if (this.client) await this.client.unsubscribeAsync(topic);
      } else {
        this.byTopic.set(topic, remaining);
      }
    }
    this.devices.delete(deviceId);
    removeDeviceStates(this.states, deviceId);
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
    // Populated from the retained Zigbee2MQTT bridge device list (see onMessage).
    return this.discovered;
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onMessage(topic: string, payload: Buffer): void {
    // The Zigbee2MQTT bridge device list → Supreme discovery hints.
    if (topic === this.discoveryTopic) {
      try {
        this.discovered = discoveredFromZ2mBridge(JSON.parse(payload.toString()), this.discoveryBaseTopic);
      } catch {
        // Ignore a malformed bridge payload.
      }
      return;
    }
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
