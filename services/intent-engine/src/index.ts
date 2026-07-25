/**
 * @supreme/intent-engine — the Universal Intent & Capability Engine (§ Phase 2,
 * ADR 0017). Protocol-independent Intents resolved dynamically onto whichever
 * device capability satisfies them: `Physical Input → Universal Input Event →
 * Universal Intent → Capability Engine → Best Device Capability → Driver Adapter
 * → Physical Device`. Depends only on `@supreme/domain-model`/`@supreme/contracts`
 * — no protocol, no driver, no concrete service — exactly like
 * `@supreme/automations`/`@supreme/keypad-framework` before it.
 */
export { CapabilityIndex } from "./capability-index.js";
export {
  IntentRegistry,
  type IntentRegistration,
  type IntentSystemHandler,
  type IntentSystemInput,
  type IntentTranslateInput,
  type IntentTranslator,
} from "./registry.js";
export { validateIntentParams } from "./param-validation.js";
export { registerBuiltinIntents } from "./catalog.js";
export {
  IntentEngine,
  type IntentEngineExecutors,
  type IntentEngineOptions,
  type IntentRun,
} from "./engine.js";
