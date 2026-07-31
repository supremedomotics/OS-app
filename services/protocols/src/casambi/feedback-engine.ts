import type { CasambiWire } from "./cloud-transport.js";

/**
 * Casambi Feedback Engine (§ Casambi Driver Refactor — Foundation). The one place that actually
 * writes a resolved `targetControls` object to the live wire — the driver's `command()` only
 * resolves WHAT to send (via the Entity Mapper's `commandToTargetControls`); this decides HOW it
 * reaches the unit. Extracted verbatim from the working driver so Cloud behavior is unchanged;
 * Local's realtime feedback path (PR-3's UDP Engine) plugs in here later without this class's
 * callers needing to change.
 */
/** The single wire id this driver ever opens (Casambi supports multiple logical wires per
 * socket; Supreme only ever needs one). Shared by the driver's `openWire`/heartbeat and this
 * engine so the id is defined in exactly one place. */
export const WIRE_ID = 1;

export class CasambiFeedbackEngine {
  constructor(private readonly wire: () => CasambiWire | null) {}

  send(unitId: number, targetControls: Record<string, unknown>): void {
    const wire = this.wire();
    if (!wire?.connected) throw new Error("casambi: not connected");
    wire.controlUnit(WIRE_ID, unitId, targetControls);
  }
}
