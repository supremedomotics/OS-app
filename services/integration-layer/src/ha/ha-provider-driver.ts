import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import type { DiscoveredDevice, StateListener } from "../adapter.js";
import type { INativeProtocolDriver, ProtocolBinding } from "../protocols/driver.js";
import type { EntityRegistryMirror } from "../registry.js";
import type { HaAdapter } from "./ha-adapter.js";

/**
 * Home Assistant as an {@link INativeProtocolDriver} (ADR-0023 § Native Backend).
 *
 * HA's runtime adapter (`HaAdapter`) already speaks the same `IBackendAdapter` shape
 * every other backend does; this wrapper is the one piece missing to let it register
 * into the SAME driver registry Casambi/KNX/Matter/MQTT/DALI/Modbus register into —
 * `protocol = "homeassistant"`, nothing else. No routing code anywhere needs to know
 * HA exists as a special case: it's discovered, bound, commanded, and torn down
 * through the identical `INativeProtocolDriver` path as every other provider.
 *
 * `bind()`'s `ProtocolBinding.address` is the HA entity id (e.g. "light.kitchen") —
 * the domain is derived from it (`light.kitchen` → domain `light`), exactly how HA's
 * own entity ids are always shaped; no separate config field needed.
 */
export class HomeAssistantProviderDriver implements INativeProtocolDriver {
  readonly protocol = "homeassistant";
  private readonly managed = new Set<DeviceId>();

  constructor(
    private readonly ha: HaAdapter,
    private readonly registry: EntityRegistryMirror,
  ) {}

  connect(): Promise<void> {
    return this.ha.connect();
  }
  disconnect(): Promise<void> {
    return this.ha.disconnect();
  }
  isConnected(): boolean {
    return this.ha.isConnected();
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const domain = binding.address.split(".")[0] ?? binding.address;
    this.registry.map(binding.deviceId, binding.capability, { backendId: binding.address, backendDomain: domain });
    this.managed.add(binding.deviceId);
  }

  async unbind(deviceId: DeviceId): Promise<void> {
    this.registry.unmapDevice(deviceId);
    this.managed.delete(deviceId);
  }

  manages(deviceId: DeviceId): boolean {
    return this.managed.has(deviceId);
  }

  command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    return this.ha.command(deviceId, command);
  }
  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    // HaAdapter.getState is async (a live HA round-trip); the driver contract's
    // getState is synchronous (an in-memory read, matching every other driver).
    // HA's real live-state path is `command()`'s subsequent onState event, exactly
    // like every other driver — this synchronous getter has no cached copy to read
    // yet without a larger HaAdapter change, so it honestly returns null rather than
    // fabricating a value or blocking on a network call inside a sync signature.
    void deviceId;
    void capability;
    return null;
  }
  discover(): Promise<DiscoveredDevice[]> {
    return this.ha.discover();
  }
  onState(listener: StateListener): () => void {
    return this.ha.onState(listener);
  }
}
