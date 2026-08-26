/**
 * @supreme/drivers — the hub Driver Manager + Driver Store catalog (§9).
 * Verifies signatures and license entitlements before installing; supports
 * update/rollback/yank and the Matter opt-in toggle.
 */
export { DriverManager, type DriverManagerOptions, type DriverRegistryEntry } from "./driver-manager.js";
export {
  InMemoryCatalog,
  seedFirstPartyCatalog,
  type ICatalog,
} from "./catalog.js";
export {
  InMemoryInstalledDriverStore,
  type IInstalledDriverStore,
} from "./store.js";
export {
  createDriverSecretCrypto,
  withSecretEncryption,
  migrateDriverSecretsToEncrypted,
  type DriverSecretCrypto,
} from "./secret-store.js";
export { FIRST_PARTY_MANIFESTS } from "./manifests.js";
export { validateDriverConfig, defaultDriverConfig, isConfigComplete, SECRET_MASK, type ConfigValidation, type ConfigFallbacks } from "./config.js";
