import type { CapabilityKind } from "@supreme/domain-model";
import {
  characteristicsFromState,
  commandFromCharacteristic,
  hapServicesFor,
  type HapCommand,
  type HapService,
} from "./hap-mapping.js";

/**
 * Local HomeKit accessory bridge (blueprint §9). HomeKit is fundamentally LOCAL: the hub publishes a
 * single bridge accessory advertised over mDNS that Apple Home pairs with directly (no cloud). This
 * class is the orchestration — it maps Supreme devices to HAP accessories, turns HomeKit
 * characteristic writes into Supreme commands, and pushes Supreme state changes back to HomeKit —
 * sitting on top of a HapTransport seam so all of it is testable without the real HAP server.
 *
 * The real transport (pairing/SRP, mDNS, the accessory DB, persistent long-term keys) is provided by
 * a hap-nodejs-backed implementation at the hub boot edge; a fake transport drives the tests.
 */

export interface HapAccessory {
  id: string;
  name: string;
  services: HapService[];
}

/** What a HomeKit controller did: wrote a characteristic on one of our accessories. */
export interface CharacteristicWrite {
  accessoryId: string;
  characteristic: string;
  value: unknown;
}

export interface HapTransport {
  /** Publish (or replace) an accessory in the bridge's accessory database + mDNS advertisement. */
  publishAccessory(accessory: HapAccessory): void;
  /** Push a new characteristic value to subscribed HomeKit controllers. */
  updateCharacteristic(accessoryId: string, characteristic: string, value: number | boolean): void;
  /** Register the handler invoked when a HomeKit controller writes a characteristic. */
  onWrite(handler: (write: CharacteristicWrite) => void): void;
  /** Start/stop the HAP server + mDNS advertisement. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SupremeDeviceView {
  id: string;
  name: string;
  capabilities: CapabilityKind[];
}

export interface HapBridgeOptions {
  transport: HapTransport;
  /** Execute a Supreme command produced by a HomeKit write (the bridge stays I/O-free otherwise). */
  onCommand: (deviceId: string, command: HapCommand) => void | Promise<void>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export class HapBridge {
  private readonly devices = new Map<string, SupremeDeviceView>();
  /** characteristic → capability, per device, so a write resolves to the right capability command. */
  private readonly charCapability = new Map<string, Map<string, CapabilityKind>>();
  private started = false;

  constructor(private readonly opts: HapBridgeOptions) {
    this.opts.transport.onWrite((w) => void this.handleWrite(w));
  }

  /** Expose a Supreme device to HomeKit as an accessory (merging each capability's HAP services). */
  addDevice(device: SupremeDeviceView): HapAccessory {
    const merged = new Map<string, HapService>();
    const charMap = new Map<string, CapabilityKind>();
    for (const cap of device.capabilities) {
      for (const svc of hapServicesFor(cap)) {
        const existing = merged.get(svc.type);
        const chars = new Set([...(existing?.characteristics ?? []), ...svc.characteristics]);
        merged.set(svc.type, { type: svc.type, characteristics: [...chars] });
        for (const c of svc.characteristics) if (!charMap.has(c)) charMap.set(c, cap);
      }
    }
    const accessory: HapAccessory = { id: device.id, name: device.name, services: [...merged.values()] };
    this.devices.set(device.id, device);
    this.charCapability.set(device.id, charMap);
    this.opts.transport.publishAccessory(accessory);
    return accessory;
  }

  /** Remove a device's accessory (e.g. it was deleted). */
  removeDevice(deviceId: string): void {
    this.devices.delete(deviceId);
    this.charCapability.delete(deviceId);
  }

  /** Push a Supreme state change to HomeKit, updating every affected characteristic. */
  pushState(deviceId: string, capability: CapabilityKind, state: Record<string, unknown>): void {
    if (!this.devices.has(deviceId)) return;
    for (const [characteristic, value] of Object.entries(characteristicsFromState(capability, state))) {
      this.opts.transport.updateCharacteristic(deviceId, characteristic, value);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.opts.transport.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.opts.transport.stop();
    this.started = false;
  }

  accessoryCount(): number {
    return this.devices.size;
  }

  private async handleWrite(write: CharacteristicWrite): Promise<void> {
    if (!this.devices.has(write.accessoryId)) return;
    const command = commandFromCharacteristic(write.characteristic, write.value);
    if (!command) return; // read-only or unmapped characteristic
    try {
      await this.opts.onCommand(write.accessoryId, command);
    } catch (err) {
      this.opts.log?.("homekit command failed", { deviceId: write.accessoryId, error: (err as Error).message });
    }
  }
}
