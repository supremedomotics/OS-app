/**
 * @supreme/automations — the native Supreme automation engine + service (§10).
 * Executes the engine-agnostic DSL on the hub; can also compile to HA.
 */
export {
  AutomationEngine,
  type AutomationExecutors,
  type DeviceStateEvent,
  type EngineOptions,
  type AutomationRun,
  type AutomationRunAction,
} from "./engine.js";
export { AutomationService, type CreateAutomationInput } from "./service.js";
export { InMemoryAutomationStore, type IAutomationStore } from "./store.js";
export { compileToHa, type HaAutomationConfig } from "./compiler.js";
export {
  circadianAt,
  circadianColorCommand,
  circadianForLocalTime,
  defaultCircadianProfile,
  CircadianError,
  type CircadianProfile,
  type CircadianKeyframe,
  type CircadianTarget,
} from "./circadian.js";
export { sunTimes, type SunTimes } from "./solar.js";
export {
  climateSetpointAt,
  validateClimateProgram,
  defaultClimateProgram,
  ClimateProgramError,
  type ClimateProgram,
  type ClimateBlock,
} from "./climate-program.js";
