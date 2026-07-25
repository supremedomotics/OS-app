import type { CapabilityCommand, CapabilityState, IntentDefinition, IntentTarget } from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";

/**
 * Intent Registry (§ Universal Intent & Capability Engine, Phase 2, deliverable
 * "Intent Registry"). The central, extensible-forever catalog: `register()` is
 * public API precisely so a future driver, marketplace template importer, or AI
 * module can add a new Intent at runtime without any change to this file or the
 * engine that executes it — the exact same "no architecture change to add a new
 * X" guarantee `DriverManifest`/the Driver Store already give protocols, applied
 * to intents.
 *
 * Every entry pairs a serializable {@link IntentDefinition} (safe to ship to a
 * client, store in a template, or hand to a future AI) with its EXECUTABLE
 * behavior, which can't be serialized and so never leaves the server:
 *   - `translate` — for capability-driven intents (`requiredCapabilities` is
 *     non-empty): turn params + a resolved device's current state/config into a
 *     concrete `CapabilityCommand`. The engine calls this once per resolved
 *     device; it never inspects protocol/driver identity.
 *   - `runSystem` — for system-level intents (`requiredCapabilities` is empty):
 *     the intent's entire behavior, dispatched directly against the engine's
 *     executors (activate a scene, run an automation, arm the panel, …).
 * Exactly one of the two is required, matching `requiredCapabilities` — enforced
 * at REGISTRATION time (`register()` throws immediately for a mismatched pair),
 * so a catalog bug is a boot-time failure, never a silent no-op discovered later
 * at the first real invocation.
 */

/** What a capability-driven intent needs to compute a concrete command. */
export interface IntentTranslateInput {
  params: Record<string, unknown>;
  /** The resolved device's current state for the required capability, or `null`
   * when the device has never reported one yet (a fresh commission). */
  state: CapabilityState | null;
  /** The resolved device's real driver-reported capability config (e.g. an AVR's
   * input list), when the owning driver has one to report — `null` otherwise.
   * Lets a translator make an honest decision (cycle a REAL input list) instead
   * of guessing, exactly like `getCapabilityConfig` already does above the SIL. */
  capabilityConfig: Record<string, unknown> | null;
}
export type IntentTranslator = (input: IntentTranslateInput) => CapabilityCommand;

/** What a system-level intent needs to run directly (no device/capability
 * resolution at all). `IntentEngineExecutors` is defined in `engine.ts`; imported
 * as a type-only reference here to avoid a circular runtime dependency. */
export interface IntentSystemInput<TExecutors> {
  target: IntentTarget;
  params: Record<string, unknown>;
  executors: TExecutors;
}
export type IntentSystemHandler<TExecutors> = (input: IntentSystemInput<TExecutors>) => Promise<void>;

export interface IntentRegistration<TExecutors = unknown> {
  definition: IntentDefinition;
  translate?: IntentTranslator;
  runSystem?: IntentSystemHandler<TExecutors>;
}

export class IntentRegistry<TExecutors = unknown> {
  private readonly entries = new Map<string, IntentRegistration<TExecutors>>();

  /**
   * Register (or replace) one Intent. Throws immediately if the handler doesn't
   * match `requiredCapabilities` (capability-driven intents need `translate`,
   * system intents need `runSystem`, never both/neither) — a catalog authoring
   * mistake fails at registration, not at the first real invocation.
   */
  register(definition: IntentDefinition, handlers: { translate?: IntentTranslator; runSystem?: IntentSystemHandler<TExecutors> }): void {
    const capabilityDriven = definition.requiredCapabilities.length > 0;
    if (capabilityDriven && !handlers.translate) {
      throw new SupremeError("conflict", `intent "${definition.id}" requires a capability but registered no translate handler`);
    }
    if (!capabilityDriven && !handlers.runSystem) {
      throw new SupremeError("conflict", `intent "${definition.id}" requires no capability but registered no runSystem handler`);
    }
    if (capabilityDriven && handlers.runSystem) {
      throw new SupremeError("conflict", `intent "${definition.id}" cannot have both a translate and a runSystem handler`);
    }
    this.entries.set(definition.id, { definition, ...handlers });
  }

  get(id: string): IntentRegistration<TExecutors> | null {
    return this.entries.get(id) ?? null;
  }

  list(): IntentDefinition[] {
    return [...this.entries.values()].map((e) => e.definition);
  }

  listByCategory(category: IntentDefinition["category"]): IntentDefinition[] {
    return this.list().filter((d) => d.category === category);
  }
}
