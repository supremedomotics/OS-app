/**
 * @supreme/integration-layer (SIL) — the crown jewel (blueprint §7).
 *
 * SupremeOS is local-first and native-only: every client binds to
 * {@link SupremeIntegrationLayer} and the Supreme domain, which routes straight to
 * native protocol drivers via {@link ProviderRouter} — no external home-automation
 * backend is ever in the runtime path.
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
export { MigrationPolicy, type EngineKind, type IMigrationPolicyStore } from "./migration.js";
export { applyCommand } from "./apply.js";
