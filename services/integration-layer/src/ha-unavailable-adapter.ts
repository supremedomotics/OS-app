import { SupremeError } from "@supreme/contracts";
import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import type { DiscoveredDevice, IBackendAdapter, StateListener } from "./adapter.js";

/**
 * Home Assistant compatibility placeholder (§ Native Backend Implementation).
 *
 * Wired into RoutingBackendAdapter's `ha` slot whenever the hub is NOT
 * configured with `SUPREME_BACKEND=ha` — i.e. on every production hub by default, now
 * that Home Assistant is an OPTIONAL compatibility plugin rather than a boot
 * requirement. This class is what "the plugin isn't installed" honestly looks like:
 * it never connects (there's nothing to connect to), `discover()` reports zero devices
 * (there's nothing to discover), and every command/read is refused with a clear,
 * typed `backend_unavailable` error naming the reason.
 *
 * This deliberately replaces `MockAdapter`'s old role as the implicit non-"ha"
 * fallback: a device genuinely owned by "ha" (only possible when HA was the
 * configured backend at commissioning time) must fail loudly if HA compatibility is
 * later disabled, never silently succeed against a fabricated in-memory device that
 * was never real (§ Never fabricate data or capabilities).
 */
export class HaUnavailableAdapter implements IBackendAdapter {
  readonly kind = "ha-unavailable";

  isConnected(): boolean {
    return false;
  }

  async connect(): Promise<void> {
    /* nothing to connect to */
  }

  async disconnect(): Promise<void> {
    /* nothing to disconnect from */
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return [];
  }

  async command(deviceId: DeviceId, _command: CapabilityCommand): Promise<void> {
    throw new SupremeError(
      "backend_unavailable",
      `device ${deviceId} is owned by Home Assistant, but the Home Assistant compatibility plugin is not enabled on this hub (set SUPREME_BACKEND=ha to enable it)`,
    );
  }

  async getState(_deviceId: DeviceId, _capability: CapabilityKind): Promise<CapabilityState | null> {
    return null;
  }

  onState(_listener: StateListener): () => void {
    return () => {};
  }
}
