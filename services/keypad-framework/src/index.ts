/**
 * @supreme/keypad-framework — the Universal Keypad Framework (§ Universal Keypad
 * Framework, Phase 1): protocol-independent input normalization, feedback routing,
 * subscriptions, and input→action mapping. Any keypad-capable driver plugs in via
 * the optional `INativeProtocolDriver`/`IBackendAdapter` members (§ Driver SDK
 * Extension, `@supreme/integration-layer`); nothing in this package ever imports a
 * protocol-specific type.
 */
export { UniversalInputEngine, type UniversalInputEngineOptions } from "./input-engine.js";
export {
  UniversalFeedbackEngine,
  renderFeedback,
  type UniversalFeedbackEngineOptions,
  type DeviceStateEvent,
} from "./feedback-engine.js";
export {
  SubscriptionManager,
  InMemoryKeypadSubscriptionStore,
  type IKeypadSubscriptionStore,
  type CreateKeypadSubscriptionInput,
} from "./subscription-manager.js";
export {
  KeypadMappingEngine,
  type KeypadMappingEngineOptions,
  type KeypadMappingRun,
  type KeypadMappingRunAction,
} from "./mapping-engine.js";
export {
  KeypadMappingService,
  type CreateKeypadMappingInput,
  type UpdateKeypadMappingInput,
} from "./service.js";
export { InMemoryKeypadMappingStore, type IKeypadMappingStore } from "./store.js";
export { expandVariables } from "./variables.js";
