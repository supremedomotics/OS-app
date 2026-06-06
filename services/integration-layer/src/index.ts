/**
 * @supreme/integration-layer (SIL) — the crown jewel (blueprint §7).
 *
 * The ONLY component in the system permitted to know that Home Assistant exists.
 * Everything above binds to {@link SupremeIntegrationLayer} and the Supreme domain;
 * everything HA-specific is confined to `./ha/*` and the `HaAdapter`.
 */
export type {
  BackendStateEvent,
  DiscoveredDevice,
  IBackendAdapter,
  StateListener,
} from "./adapter.js";
export { EntityRegistryMirror, type BackendEntityRef } from "./registry.js";
export { SupremeIntegrationLayer, type SilOptions } from "./sil.js";
export { MockAdapter } from "./mock-adapter.js";
export {
  SupremeNativeAdapter,
  type SupremeNativeAdapterOptions,
} from "./native-adapter.js";
export {
  type INativeProtocolDriver,
  type ProtocolBinding,
  bindingKey,
} from "./protocols/driver.js";
export { RoutingBackendAdapter, type RoutingAdapterOptions } from "./routing-adapter.js";
export { MigrationPolicy, type EngineKind } from "./migration.js";
export { applyCommand } from "./apply.js";
export { HaAdapter, type HaTransport, type HaAdapterOptions } from "./ha/ha-adapter.js";
export { HaWsTransport, type HaWsTransportOptions } from "./ha/ha-ws-transport.js";
export { commandToHaService, haStateToCapability, type HaServiceCall } from "./ha/capability-mapper.js";
