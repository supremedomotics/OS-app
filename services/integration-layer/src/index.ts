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
  DriverConnectionStatus,
  DriverDiagnosticsSnapshot,
  DriverTraceEntry,
  IBackendAdapter,
  MediaArtwork,
  MediaQueueItem,
  StateListener,
} from "./adapter.js";
export { EntityRegistryMirror, type BackendEntityRef } from "./registry.js";
export {
  type DeviceLifecycleState,
  DEVICE_LIFECYCLE_TRANSITIONS,
  canTransition,
} from "./device-lifecycle.js";
export {
  ProviderRegistry,
  InMemoryDeviceProviderStore,
  type DeviceProviderRecord,
  type IDeviceProviderStore,
} from "./provider-registry.js";
export {
  type ProviderAdapter,
  type ProviderMetadata,
  type ProviderHealth,
  type ProviderDiagnostics,
  type ProviderEvent,
} from "./provider-adapter.js";
export {
  DriverBindingEngine,
  type DriverHost,
  type BindingHealth,
} from "./driver-binding-engine.js";
export { SupremeIntegrationLayer, type SilOptions } from "./sil.js";
export { MockAdapter } from "./mock-adapter.js";
export {
  SupremeNativeAdapter,
  type SupremeNativeAdapterOptions,
} from "./native-adapter.js";
export {
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StoredProtocolBinding,
  type IProtocolBindingStore,
  type DiscoveredScene,
  InMemoryProtocolBindingStore,
  bindingKey,
} from "./protocols/driver.js";
export {
  DriverLifecycleController,
  InvalidLifecycleTransitionError,
  type CleanupFn,
  type DriverLifecycleState,
} from "./protocols/lifecycle.js";
export { ProviderRouter, type ProviderRouterOptions } from "./provider-router.js";
export { HomeAssistantProviderDriver } from "./ha/ha-provider-driver.js";
export { MigrationPolicy, type EngineKind, type IMigrationPolicyStore } from "./migration.js";
export { applyCommand } from "./apply.js";
export { HaAdapter, type HaTransport, type HaAdapterOptions } from "./ha/ha-adapter.js";
export { HaWsTransport, type HaWsTransportOptions } from "./ha/ha-ws-transport.js";
export { provisionHaToken, haHttpFromWsUrl, type HaProvisionerOptions } from "./ha/ha-provisioner.js";
export { commandToHaService, haStateToCapability, type HaServiceCall } from "./ha/capability-mapper.js";
