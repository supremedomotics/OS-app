/**
 * Energy Intelligence as a registrable {@link IntelligenceModule}. Thin adapter: it pulls the energy
 * snapshot the host placed on the engine input (`input.energy`) and runs the pure decision core. The
 * gateway runner builds that snapshot from the hub's own device state, presence fusion and zone
 * occupancy — keeping all I/O out of this package.
 */
import type { EngineInput, IntelligenceModule, ModuleResult } from "../engine.js";
import { type EnergyIntelInput, evaluateEnergyIntelligence } from "./decision.js";

export class EnergyIntelligenceModule implements IntelligenceModule {
  readonly id = "energy";
  readonly title = "Energy Intelligence";

  evaluate(input: EngineInput): ModuleResult {
    const snapshot = input.energy as EnergyIntelInput | undefined;
    if (!snapshot) return { observations: [], suggestions: [] };
    return evaluateEnergyIntelligence({ ...snapshot, now: snapshot.now ?? input.now });
  }
}
