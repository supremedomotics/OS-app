/**
 * (§ Matter Bridge Phase 3.2 — CoolMaster Thermostat) Pure value-translation only, the same
 * contract every other file in this directory follows (`matter-cluster-adapter.ts`'s doc
 * comment): no CoolMaster/ASCII_IF knowledge, no I/O, no UI logic — just SupremeOS
 * `TemperatureState`/`temperature` command shapes ↔ Matter `Thermostat` cluster attribute
 * values, backed by the approved Phase 3.1.1 decision record.
 *
 * Feature scope this adapter assumes (never enable more from real-server.ts without a new,
 * equally-audited decision record): `Thermostat.with("Heating", "Cooling")` only — no
 * `AutoMode`, no `Presets`, no `MatterScheduleConfiguration`, no `Events`, no `FanControl`.
 */
import type { CapabilityCommand } from "@supreme/domain-model";
import { Thermostat } from "@matter/main/clusters/thermostat";

/** Matter's Thermostat setpoint/localTemperature unit is hundredths of a degree Celsius
 * (live-confirmed against the real installed SDK — see Phase 3.1.1's reproduction: a
 * constructed endpoint's `localTemperature: 2200` meant 22.00°C). Lossless to 0.01°C. */
export function celsiusToMatter(celsius: number): number {
  return Math.round(celsius * 100);
}

export function matterToCelsius(matterValue: number): number {
  return matterValue / 100;
}

/**
 * SupremeOS `TemperatureState.mode` → Matter `SystemMode`, per the approved Phase 3.1.1
 * mapping (§9 of that record). `"auto"` deliberately returns `null` — it is NOT `SystemMode.
 * Auto` (that enum value is conformance-invalid without the `AutoMode` feature, live-confirmed
 * via the Phase 3.1.1 reproduction: "Matter does not allow enum value Auto (ID 1) here" — and
 * `AutoMode` is out of scope per Phase 3.1.1 §9, since it would require a `minSetpointDeadBand`
 * value CoolMaster has no honest source for). `null` tells the caller "do not write systemMode
 * for this state" (see real-server.ts's `setCapabilityState` thermostat case) — an intentional,
 * documented degradation (leave the attribute at its last-reported value) rather than a
 * fabricated guess at which single Matter mode best represents "auto".
 *
 * `"dry"` never reaches this function at all — `coolmaster-mapper.ts`'s
 * `supremeModeFromCoolMaster` already collapses CoolMaster's real "dry" mode into SupremeOS's
 * fixed 5-value `TemperatureState.mode` enum (which has no "dry") before this adapter ever sees
 * it; this is a pre-existing, documented SupremeOS-domain-model loss (Phase 3.1 §9), not
 * something this Matter adapter recovers or re-derives.
 */
export function systemModeFromSupremeMode(mode: "off" | "heat" | "cool" | "auto" | "fan_only"): Thermostat.SystemMode | null {
  switch (mode) {
    case "off":
      return Thermostat.SystemMode.Off;
    case "heat":
      return Thermostat.SystemMode.Heat;
    case "cool":
      return Thermostat.SystemMode.Cool;
    case "fan_only":
      return Thermostat.SystemMode.FanOnly;
    case "auto":
      return null;
  }
}

/**
 * Matter `SystemMode` (as written by a real controller) → the `mode` field of a SupremeOS
 * `temperature` capability command. Only the four modes this endpoint's feature set can ever
 * legally hold are handled — `Heating`+`Cooling` features (no `AutoMode`) constrain a real
 * Matter controller to Off/Cool/Heat/FanOnly (and any deprecated/reserved value the SDK's own
 * conformance validation would already have rejected before this function is ever called —
 * see real-server.ts's routed Thermostat server class, which only reacts to a value the SDK
 * itself already accepted). Returns `null` for anything else — a defensive no-op, never a
 * fabricated fallback mode — rather than assuming this can never happen.
 */
export function supremeModeFromSystemMode(systemMode: Thermostat.SystemMode): "off" | "heat" | "cool" | "fan_only" | null {
  switch (systemMode) {
    case Thermostat.SystemMode.Off:
      return "off";
    case Thermostat.SystemMode.Heat:
      return "heat";
    case Thermostat.SystemMode.Cool:
      return "cool";
    case Thermostat.SystemMode.FanOnly:
      return "fan_only";
    default:
      return null;
  }
}

/**
 * Builds the SupremeOS `temperature` command for a Matter `systemMode` write — routes through
 * the SAME capability command shape `climate-console.tsx`/automation already use, never a
 * second command path (§9 command authority). `null` if the mode has no honest translation
 * (see {@link supremeModeFromSystemMode}) — the caller must not emit anything in that case.
 *
 * § Phase 3.4A/3.4B — Heat/Cool route through `heatCool`, NOT `mode`. Phase 3.4A's semantic
 * investigation established that Matter Heat/Cool have an EXACT canonical match with
 * `TemperatureState.heatCool`/KNX DPT 1.100 (`DPT_Heat/Cool`: 0=cooling, 1=heating) — a
 * genuinely writable, already-implemented destination with real feedback and confirmed-state
 * authority (`KnxProtocolDriver.command()`'s existing `heatCool` handling, unchanged by this
 * fix). CoolMaster's `indoorUnitCommandLines()` already handles a `heatCool`-only command via
 * its native `cmdMode`/`cmdOn` path (see `coolmaster-driver.test.ts`), so this is safe for both
 * protocols — no protocol check was added here, none was needed.
 *
 * Off/FanOnly deliberately still route through `mode` (unchanged): Phase 3.4A established
 * NO honest, currently-writable KNX destination exists for either (DPT 20.105's matching enum
 * values are read-only-by-canonical-document; DPT 20.111 is a different concept — fan
 * run/interval cycling, not a system mode). This intentionally still lets 3.3D-FIX reject a
 * KNX-backed device's Off/FanOnly command with its existing descriptive error, rather than
 * inventing a mapping — and CoolMaster's native `mode` write path is untouched for them.
 */
export function temperatureCommandForSystemMode(systemMode: Thermostat.SystemMode): CapabilityCommand | null {
  const mode = supremeModeFromSystemMode(systemMode);
  if (!mode) return null;
  if (mode === "heat" || mode === "cool") return { capability: "temperature", heatCool: mode };
  return { capability: "temperature", mode };
}

/** Builds the SupremeOS `temperature` command for a Matter heating/cooling setpoint write.
 * Both `occupiedHeatingSetpoint` and `occupiedCoolingSetpoint` map onto the SAME single
 * `targetC` field (§10 — "do not invent separate heating and cooling targets", since
 * SupremeOS's `TemperatureState` has only one). */
export function temperatureCommandForSetpoint(matterSetpoint: number): CapabilityCommand {
  return { capability: "temperature", targetC: matterToCelsius(matterSetpoint) };
}
