import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";
import type { DiscoveredDevice } from "@supreme/integration-layer";
import type { ClimateAdvancedControl, ClimateCapabilityConfig } from "./coolmaster-capabilities.js";
import {
  cmdFanSpeed,
  cmdFilterReset,
  cmdInhibit,
  cmdLock,
  cmdMode,
  cmdOff,
  cmdOn,
  cmdSwing,
  cmdTemp,
} from "./coolmaster-commands.js";
import { supremeModeFromCoolMaster } from "./coolmaster-parser.js";
import type {
  CoolMasterGatewayInfo,
  CoolMasterMainControllerStatus,
  CoolMasterModeWord,
  CoolMasterUnitStatus,
  CoolMasterVentilationStatus,
  CoolMasterWaterHeaterStatus,
} from "./coolmaster-types.js";

/**
 * Translates between CoolMaster wire models and Supreme's capability model — the ONLY
 * file in this driver that imports @supreme/domain-model, so protocol detail never
 * leaks past this boundary (§ "Confines all CoolMaster detail; emits pure Supreme
 * capabilities" — the same architectural rule the prior driver followed).
 */

// ── Indoor unit → Supreme state ─────────────────────────────────────────────────

export function unitOnOffState(unit: CoolMasterUnitStatus): CapabilityState {
  return { kind: "onoff", on: unit.on };
}

export function unitTemperatureState(unit: CoolMasterUnitStatus): CapabilityState {
  const advanced: Record<string, unknown> = {};
  if (unit.fanSpeed != null) advanced.fanSpeed = unit.fanSpeed;
  if (unit.swing != null) advanced.swing = unit.swing;
  if (unit.filterWarning != null) advanced.filterWarning = unit.filterWarning;
  if (unit.demand != null) advanced.demand = unit.demand;
  if (unit.faultCode != null) advanced.faultCode = unit.faultCode;
  if (unit.locked != null) advanced.locked = unit.locked;
  if (unit.inhibited != null) advanced.inhibited = unit.inhibited;
  return {
    kind: "temperature",
    ambientC: unit.roomC ?? unit.setpointC ?? 21,
    targetC: unit.setpointC,
    mode: supremeModeFromCoolMaster(unit.mode, unit.on),
    advanced: Object.keys(advanced).length > 0 ? advanced : null,
  };
}

// ── Water heater / ventilation / main controller → Supreme state ───────────────

/** A water heater is fundamentally a heat-only climate device (on/off + setpoint +
 * ambient) — reusing the `temperature` capability rather than inventing a new Supreme
 * capability kind, the same reuse-over-proliferation choice the domain model already
 * makes for e.g. dry mode reusing "cool". */
export function waterHeaterTemperatureState(wh: CoolMasterWaterHeaterStatus): CapabilityState {
  return {
    kind: "temperature",
    ambientC: wh.roomC ?? wh.setpointC ?? 45,
    targetC: wh.setpointC,
    mode: wh.on ? "heat" : "off",
    advanced: wh.faultCode != null ? { faultCode: wh.faultCode } : null,
  };
}

export function waterHeaterOnOffState(wh: CoolMasterWaterHeaterStatus): CapabilityState {
  return { kind: "onoff", on: wh.on };
}

/** Ventilation (VAM) maps to Supreme's `fan` capability. LIMITATION: FanState.preset is
 * a fixed 3-value enum ("auto"|"sleep"|"turbo") that doesn't match VAM's real fan-speed
 * vocabulary (typically Auto/Low/Med/High, same as an indoor unit) — the closest
 * available preset is used (see mapVentilationPreset). Supreme's `sensor` capability
 * can't represent the real word losslessly either (its `value` is strictly numeric, and
 * "fan speed" isn't a stable measurement category) so it is NOT force-fit into one; the
 * approximation here is the documented, honest limitation — see
 * docs/coolmaster/README.md Limitations rather than a fabricated numeric encoding. */
export function ventilationFanState(vam: CoolMasterVentilationStatus): CapabilityState {
  return { kind: "fan", on: vam.on, preset: mapVentilationPreset(vam.fanSpeed), direction: "forward" };
}

function mapVentilationPreset(speed: string | null): "auto" | "sleep" | "turbo" {
  const s = (speed ?? "").toLowerCase();
  if (s === "high" || s === "top" || s === "turbo") return "turbo";
  if (s === "low") return "sleep";
  return "auto";
}

export function mainControllerOnOffState(main: CoolMasterMainControllerStatus): CapabilityState {
  return { kind: "onoff", on: main.on };
}

// ── DiscoveredDevice construction ───────────────────────────────────────────────

const ADVANCED_CONTROLS: ClimateAdvancedControl[] = [
  { key: "fanSpeed", label: "Fan Speed", kind: "select", icon: "fan" },
  { key: "swing", label: "Swing", kind: "select", icon: "swing" },
  { key: "locked", label: "Remote Lock", kind: "toggle", icon: "lock" },
  { key: "inhibited", label: "Inhibit", kind: "toggle", icon: "block" },
  { key: "filterReset", label: "Reset Filter Warning", kind: "action", icon: "filter" },
];

export function indoorUnitCapabilityConfig(
  unit: CoolMasterUnitStatus,
  knownFanSpeeds: string[],
  knownSwingPositions: string[],
): ClimateCapabilityConfig {
  return {
    source: "device_reported",
    modes: ["heat", "cool", "auto", "fan_only"],
    fanSpeeds: knownFanSpeeds.length > 0 ? (knownFanSpeeds as ClimateCapabilityConfig["fanSpeeds"]) : undefined,
    swingPositions: knownSwingPositions.length > 0 ? knownSwingPositions : undefined,
    filterSupported: unit.filterWarning !== null,
    demandSupported: unit.demand !== null,
    faultSupported: true,
    lockSupported: unit.locked !== null,
    inhibitSupported: unit.inhibited !== null,
    line: unit.line,
    manufacturer: null,
    advancedControls: ADVANCED_CONTROLS.filter((c) => {
      if (c.key === "locked") return unit.locked !== null;
      if (c.key === "inhibited") return unit.inhibited !== null;
      if (c.key === "swing") return unit.swing !== null || knownSwingPositions.length > 0;
      if (c.key === "fanSpeed") return unit.fanSpeed !== null || knownFanSpeeds.length > 0;
      return true; // filterReset is always offered — a no-op if the unit has no filter sensor
    }),
  };
}

export function indoorUnitDiscoveredDevice(unit: CoolMasterUnitStatus, gateway: CoolMasterGatewayInfo): DiscoveredDevice {
  return {
    backendId: unit.uid,
    suggestedName: `HVAC ${unit.line} · ${unit.uid}`,
    capabilities: ["onoff", "temperature"],
    raw: { coolmaster: { uid: unit.uid, line: unit.line, gatewaySerial: gateway.serial, deviceKind: "indoor_unit" } },
  };
}

export function waterHeaterDiscoveredDevice(wh: CoolMasterWaterHeaterStatus, gateway: CoolMasterGatewayInfo): DiscoveredDevice {
  return {
    backendId: wh.uid,
    suggestedName: `Water Heater ${wh.uid}`,
    capabilities: ["onoff", "temperature"],
    raw: { coolmaster: { uid: wh.uid, gatewaySerial: gateway.serial, deviceKind: "water_heater" } },
  };
}

export function ventilationDiscoveredDevice(vam: CoolMasterVentilationStatus, gateway: CoolMasterGatewayInfo): DiscoveredDevice {
  return {
    backendId: vam.uid,
    suggestedName: `Ventilation ${vam.uid}`,
    capabilities: ["fan"],
    raw: { coolmaster: { uid: vam.uid, gatewaySerial: gateway.serial, deviceKind: "ventilation" } },
  };
}

export function mainControllerDiscoveredDevice(main: CoolMasterMainControllerStatus, gateway: CoolMasterGatewayInfo): DiscoveredDevice {
  return {
    backendId: main.uid,
    suggestedName: `HVAC Controller ${main.uid}`,
    capabilities: ["onoff"],
    raw: { coolmaster: { uid: main.uid, gatewaySerial: gateway.serial, deviceKind: "main_controller" } },
  };
}

export function groupDiscoveredDevice(groupId: string, label: string, memberUids: string[], gateway: CoolMasterGatewayInfo): DiscoveredDevice {
  return {
    backendId: groupId,
    suggestedName: label || `HVAC Group ${groupId}`,
    capabilities: ["onoff", "temperature"],
    raw: { coolmaster: { uid: groupId, gatewaySerial: gateway.serial, deviceKind: "group", memberUids } },
  };
}

// ── Supreme command → ASCII_IF command lines ────────────────────────────────────

/** Translates a Supreme command into one or more ASCII_IF command lines for an indoor
 * unit. Returns null for a command this capability doesn't accept (mirrors every other
 * driver's commandToX() convention in this codebase). */
export function indoorUnitCommandLines(uid: string, command: CapabilityCommand): string[] | null {
  if (command.capability === "onoff") {
    if (command.action === "toggle") return null; // caller resolves toggle from cached state first
    return [command.action === "on" ? cmdOn(uid) : cmdOff(uid)];
  }
  if (command.capability !== "temperature") return null;
  const lines: string[] = [];
  if (command.mode) {
    if (command.mode === "off") lines.push(cmdOff(uid));
    else if (command.mode === "fan_only") lines.push(cmdMode(uid, "fan"));
    else lines.push(cmdMode(uid, command.mode as CoolMasterModeWord));
  }
  if (typeof command.targetC === "number") lines.push(cmdTemp(uid, command.targetC));
  const adv = command.advanced;
  if (adv) {
    if (typeof adv.fanSpeed === "string") lines.push(cmdFanSpeed(uid, adv.fanSpeed));
    if (typeof adv.swing === "string") lines.push(cmdSwing(uid, adv.swing));
    if (typeof adv.locked === "boolean") lines.push(cmdLock(uid, adv.locked));
    if (typeof adv.inhibited === "boolean") lines.push(cmdInhibit(uid, adv.inhibited));
    if (adv.filterReset === true) lines.push(cmdFilterReset(uid));
  }
  return lines.length > 0 ? lines : null;
}
