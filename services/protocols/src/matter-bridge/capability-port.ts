import type { CapabilityCommand, CapabilityState, DeviceId } from "@supreme/domain-model";

/**
 * The Matter Bridge's ONLY entry point into SupremeOS (§ Matter Bridge Phase 1).
 *
 * Deliberately NOT `INativeProtocolDriver` — that interface is shaped for a driver that owns
 * one wire protocol and gets `bind()`-ed to specific device/capability pairs by commissioning
 * (see `services/integration-layer/src/protocols/driver.ts`). The Bridge is the opposite
 * direction: it is a Matter *server* that re-exposes SupremeOS devices that some OTHER driver
 * already owns. It never touches a physical bus itself, so it has no cluster to bind, no wire
 * address to parse, and no discovery of its own — forcing it through `bind()`/`command()`-as-
 * driver would misrepresent it as a protocol driver when it is a capability consumer sitting
 * on the same seam the REST API and automations engine already use.
 *
 * This port is exactly `SupremeIntegrationLayer.command()`/`.getState()`/`.onState()`
 * (`services/integration-layer/src/sil.ts`) narrowed to the three calls the Bridge needs —
 * kept as its own minimal interface (not an import of the concrete SIL type) so the Bridge
 * stays unit-testable with a fake, exactly like `MatterController` already is for the Matter
 * Controller driver.
 */
export interface MatterBridgeCapabilityPort {
  /** Route a command through the SAME path the REST API/automations use — never write to a
   * driver directly. */
  command(deviceId: DeviceId, command: CapabilityCommand): Promise<void>;
  /** Last known Supreme state for a device+capability, if any. Async because the real seam
   * (`SupremeIntegrationLayer.getState`) is — this port must not force a synchronous cache
   * read that the real production wiring cannot actually provide (§ Phase 3 native wiring). */
  getState(deviceId: DeviceId, capability: CapabilityCommand["capability"]): Promise<CapabilityState | null>;
  /** Subscribe to every Supreme state change (physical feedback, automations, other
   * ecosystems) — the Bridge filters to the devices it has exposed. Returns an unsubscribe
   * function, mirroring every other `onState` seam in this codebase. */
  onState(listener: (event: { deviceId: DeviceId; capability: string; state: CapabilityState }) => void): () => void;
}
