import type { DeviceId } from "@supreme/domain-model";
import type { INativeProtocolDriver, ProtocolBinding } from "./protocols/driver.js";
import { ProviderRegistry } from "./provider-registry.js";

/** The slice of {@link SupremeNativeAdapter} the binding engine needs — kept minimal
 * and structural (not importing the class itself) so this engine has no dependency
 * on native-adapter's in-process simulation concerns, only real driver lifecycle. */
export interface DriverHost {
  bind(binding: ProtocolBinding, protocol: string): Promise<void>;
  /** Release a device's driver-held resources — named to match
   * {@link SupremeNativeAdapter.unbindDevice} exactly, since that's the real host
   * this engine drives in production. */
  unbindDevice?(deviceId: DeviceId): Promise<void>;
  driverFor(protocol: string): INativeProtocolDriver | null;
}

export interface BindingHealth {
  bound: boolean;
  connected: boolean;
  error: string | null;
}

/**
 * Driver Binding Engine (ADR-0023). The ONLY code path allowed to call a protocol
 * driver's bind()/unbind() — `SupremeIntegrationLayer.bindNative()` and
 * `InstallerServices.bindProtocol()` become thin callers into this, not independent
 * implementations. Every transition writes a {@link ProviderRegistry} lifecycle state;
 * no caller can bind a driver without the state machine reflecting it.
 */
export class DriverBindingEngine {
  constructor(
    private readonly host: DriverHost,
    private readonly registry: ProviderRegistry,
  ) {}

  /** Assign the provider (if not already assigned) then bind the real driver.
   * On failure the device is left in ERROR, never silently UNBOUND-forever with no
   * signal, never silently simulated. */
  async bind(binding: ProtocolBinding, provider: string): Promise<void> {
    if (!this.registry.get(binding.deviceId)) {
      await this.registry.assign(binding.deviceId, provider);
    }
    await this.registry.transition(binding.deviceId, "BINDING");
    try {
      await this.host.bind(binding, provider);
    } catch (err) {
      await this.registry.transition(binding.deviceId, "ERROR");
      throw err;
    }
    await this.registry.transition(binding.deviceId, "BOUND");
    await this.registry.transition(binding.deviceId, "ONLINE");
  }

  /** Release a device from its driver and return it to UNBOUND. Idempotent —
   * unbinding a device already UNBOUND/without a record is a safe no-op, mirroring
   * `INativeProtocolDriver.unbind`'s own idempotency contract. */
  async unbind(deviceId: DeviceId): Promise<void> {
    const record = this.registry.get(deviceId);
    if (!record || record.state === "UNBOUND") return;
    if (this.host.unbindDevice) await this.host.unbindDevice(deviceId);
    await this.registry.transition(deviceId, "UNBOUND");
  }

  /** Unbind then bind again onto the (possibly same) provider/address — the explicit
   * rebind workflow the audit found missing (A-3), rather than installers having to
   * manually unbind+bind through two separate call sites. */
  async rebind(binding: ProtocolBinding, provider: string): Promise<void> {
    await this.unbind(binding.deviceId);
    await this.bind(binding, provider);
  }

  /** Confirm the device's assigned provider actually has a live driver registered —
   * catches "provider assigned but driver never configured" before a bind attempt
   * produces a less specific error. */
  validate(deviceId: DeviceId): { valid: boolean; reason?: string } {
    const record = this.registry.get(deviceId);
    if (!record) return { valid: false, reason: "no provider assigned" };
    const driver = this.host.driverFor(record.provider);
    if (!driver) return { valid: false, reason: `"${record.provider}" has no driver configured on this hub` };
    return { valid: true };
  }

  /** Real health for a bound device — never fabricated. UNBOUND devices report
   * `bound: false` with no connection claim, exactly per ADR-0023's diagnostics rule
   * (never collapse UNBOUND into OFFLINE/ERROR). */
  health(deviceId: DeviceId): BindingHealth {
    const record = this.registry.get(deviceId);
    if (!record || record.state === "UNBOUND") return { bound: false, connected: false, error: null };
    const driver = this.host.driverFor(record.provider);
    if (!driver) return { bound: false, connected: false, error: `"${record.provider}" has no driver configured` };
    return { bound: true, connected: driver.isConnected(), error: null };
  }

  /** Attempt to recover a device stuck in ERROR/OFFLINE by rebinding it onto its
   * already-recorded provider — used by the "recovery attempts" diagnostics counter,
   * never called automatically/silently; a caller (health monitor, installer action)
   * decides when recovery is appropriate. */
  async recover(binding: ProtocolBinding): Promise<void> {
    const record = this.registry.get(binding.deviceId);
    if (!record) throw new Error(`device ${binding.deviceId} has no provider record to recover`);
    await this.rebind(binding, record.provider);
  }
}
