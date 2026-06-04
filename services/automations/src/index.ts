/**
 * @supreme/automations — the native Supreme automation engine + service (§10).
 * Executes the engine-agnostic DSL on the hub; can also compile to HA.
 */
export {
  AutomationEngine,
  type AutomationExecutors,
  type DeviceStateEvent,
  type EngineOptions,
} from "./engine.js";
export { AutomationService, type CreateAutomationInput } from "./service.js";
export { InMemoryAutomationStore, type IAutomationStore } from "./store.js";
export { compileToHa, type HaAutomationConfig } from "./compiler.js";
