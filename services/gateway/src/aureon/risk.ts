import type { AureonRiskLevel } from "@supreme/domain-model";
import type { ProposedCommand } from "@supreme/ai";

/**
 * Aureon risk classification (§ AUREON-ARCHITECTURE.md §3.7 / brief Step 9).
 *
 * A static, auditable table keyed on (capability, action) — deliberately NOT a
 * learned or context-sensitive score for this phase. `lock` and any `position`
 * action are always treated as at least HIGH_RISK/MODERATE respectively per the
 * brief's explicit examples; every other capability defaults to LOW_RISK since the
 * only capabilities that exist today (§ AUREON-ARCHITECTURE.md §1.2) are all
 * environmental. `sensor` never appears here — it is read-only at the SIL boundary
 * already (`READONLY_CAPABILITIES`), so it can only ever be a READ-level query, not
 * a command Aureon would risk-classify.
 */
export function classifyCommand(command: ProposedCommand["command"]): AureonRiskLevel {
  switch (command.capability) {
    case "lock":
      // Unlocking a door is the brief's canonical HIGH_RISK example; locking it is
      // reversible-in-spirit but still security-adjacent, so both actions of this
      // capability are classified identically rather than trying to guess intent.
      return 3;
    case "position":
      // Covers/blinds/gates share one capability; a gate is high-risk and a blind is
      // low-risk, and nothing in the domain model distinguishes them today (no
      // `device.metadata` convention for "this cover is a gate" exists yet — see
      // AUREON-ARCHITECTURE.md §1.15). Classifying the whole capability as MODERATE
      // is the honest middle ground until that metadata convention exists.
      return 2;
    case "onoff":
    case "brightness":
    case "color":
    case "temperature":
    case "fan":
    case "media":
    case "vacuum":
      return 1;
  }
}

/** The overall risk of a proposed set of commands is the maximum of its parts. */
export function maxRisk(commands: readonly ProposedCommand[]): AureonRiskLevel {
  let max: AureonRiskLevel = 0;
  for (const c of commands) {
    const r = classifyCommand(c.command);
    if (r > max) max = r;
  }
  return max;
}
