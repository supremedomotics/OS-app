import type { CapabilityCommand, CapabilityKind, CapabilityState } from "@supreme/domain-model";

/**
 * Zigbee (ZCL) capability codec (§3). Native Zigbee via zigbee-herdsman talks ZCL
 * clusters directly to a coordinator radio — no MQTT broker, no Zigbee2MQTT. This maps
 * Supreme capabilities to ZCL cluster commands (outbound) and attribute reports
 * (inbound). The driver confines all ZCL detail and emits pure Supreme capabilities.
 */

const ZCL_MAX_LEVEL = 254;

function pct(level: number): number {
  return Math.max(0, Math.min(100, Math.round((level / ZCL_MAX_LEVEL) * 100)));
}
function toLevel(p: number): number {
  return Math.max(0, Math.min(ZCL_MAX_LEVEL, Math.round((p / 100) * ZCL_MAX_LEVEL)));
}

/** Which ZCL cluster backs a Supreme capability. */
export function zclClusterForCapability(capability: CapabilityKind): string | null {
  switch (capability) {
    case "onoff":
      return "genOnOff";
    case "brightness":
      return "genLevelCtrl";
    case "color":
      return "lightingColorCtrl";
    case "lock":
      return "closuresDoorLock";
    case "position":
      return "closuresWindowCovering";
    case "sensor":
      return "msTemperatureMeasurement";
    default:
      return null;
  }
}

/** Map a device's input ZCL clusters to Supreme capabilities. */
export function capabilitiesFromZclClusters(clusters: string[]): CapabilityKind[] {
  const set = new Set<CapabilityKind>();
  for (const c of clusters) {
    if (c === "genOnOff") set.add("onoff");
    else if (c === "genLevelCtrl") set.add("brightness");
    else if (c === "lightingColorCtrl") set.add("color");
    else if (c === "closuresDoorLock") set.add("lock");
    else if (c === "closuresWindowCovering") set.add("position");
    else if (c === "msTemperatureMeasurement" || c === "msRelativeHumidity" || c === "msOccupancySensing")
      set.add("sensor");
  }
  const order: CapabilityKind[] = ["onoff", "brightness", "color", "position", "lock", "sensor"];
  return order.filter((c) => set.has(c));
}

export interface ZclCommand {
  cluster: string;
  command: string;
  payload: Record<string, unknown>;
}

/** Translate a Supreme command into a ZCL cluster command (null = unsupported). */
export function commandToZcl(command: CapabilityCommand, prev: CapabilityState | null): ZclCommand | null {
  switch (command.capability) {
    case "onoff": {
      const cmd = command.action === "on" ? "on" : command.action === "off" ? "off" : "toggle";
      return { cluster: "genOnOff", command: cmd, payload: {} };
    }
    case "brightness": {
      if (command.action === "off") return { cluster: "genOnOff", command: "off", payload: {} };
      const level = typeof command.level === "number" ? toLevel(command.level) : ZCL_MAX_LEVEL;
      return { cluster: "genLevelCtrl", command: "moveToLevelWithOnOff", payload: { level, transtime: 0 } };
    }
    case "color": {
      if (typeof command.kelvin === "number") {
        return {
          cluster: "lightingColorCtrl",
          command: "moveToColorTemp",
          payload: { colortemp: Math.round(1_000_000 / command.kelvin), transtime: 0 },
        };
      }
      const base = prev?.kind === "color" ? prev : null;
      const hue = command.hue ?? base?.hue ?? 0;
      const sat = command.saturation ?? base?.saturation ?? 0;
      return {
        cluster: "lightingColorCtrl",
        command: "moveToHueAndSaturation",
        payload: { hue: Math.round((hue / 360) * ZCL_MAX_LEVEL), saturation: toLevel(sat), transtime: 0 },
      };
    }
    case "lock":
      return { cluster: "closuresDoorLock", command: command.action === "lock" ? "lockDoor" : "unlockDoor", payload: {} };
    case "position": {
      const p =
        command.action === "open"
          ? 100
          : command.action === "close"
            ? 0
            : (command.position ?? (prev?.kind === "position" ? prev.position : 0));
      return { cluster: "closuresWindowCovering", command: "goToLiftPercentage", payload: { percentageliftvalue: p } };
    }
    default:
      return null;
  }
}

/** Translate a ZCL attribute report (a {attribute: value} bag) into a Supreme state. */
export function stateFromZclReport(
  capability: CapabilityKind,
  cluster: string,
  data: Record<string, unknown>,
  prev: CapabilityState | null,
  config: Record<string, unknown> = {},
): CapabilityState | null {
  if (capability === "onoff" && cluster === "genOnOff" && "onOff" in data) {
    return { kind: "onoff", on: Boolean(data.onOff) };
  }
  if (capability === "brightness") {
    if (cluster === "genLevelCtrl" && typeof data.currentLevel === "number") {
      const level = pct(data.currentLevel);
      return { kind: "brightness", on: level > 0, level };
    }
    if (cluster === "genOnOff" && "onOff" in data) {
      const level = prev?.kind === "brightness" ? prev.level : 100;
      return { kind: "brightness", on: Boolean(data.onOff), level };
    }
  }
  if (capability === "color" && cluster === "lightingColorCtrl") {
    const base = prev?.kind === "color" ? prev : null;
    if (typeof data.colorTemperature === "number") {
      const mireds = data.colorTemperature;
      return { kind: "color", on: base?.on ?? true, level: base?.level ?? 100, hue: null, saturation: null, kelvin: mireds > 0 ? Math.round(1_000_000 / mireds) : null };
    }
    if (typeof data.currentHue === "number" || typeof data.currentSaturation === "number") {
      const hue = typeof data.currentHue === "number" ? Math.round((data.currentHue / ZCL_MAX_LEVEL) * 360) : (base?.hue ?? null);
      const sat = typeof data.currentSaturation === "number" ? pct(data.currentSaturation) : (base?.saturation ?? null);
      return { kind: "color", on: base?.on ?? true, level: base?.level ?? 100, hue, saturation: sat, kelvin: null };
    }
  }
  if (capability === "lock" && cluster === "closuresDoorLock" && typeof data.lockState === "number") {
    // ZCL DoorLock lockState: 1 = Locked, 2 = Unlocked.
    return { kind: "lock", locked: data.lockState === 1, jammed: false };
  }
  if (capability === "position" && cluster === "closuresWindowCovering" && typeof data.currentPositionLiftPercentage === "number") {
    return { kind: "position", position: Math.max(0, Math.min(100, Math.round(data.currentPositionLiftPercentage))), moving: false };
  }
  if (capability === "sensor" && typeof data.measuredValue === "number") {
    if (cluster === "msTemperatureMeasurement") return { kind: "sensor", value: data.measuredValue / 100, unit: "°C", measure: "temperature" };
    if (cluster === "msRelativeHumidity") return { kind: "sensor", value: data.measuredValue / 100, unit: "%", measure: "humidity" };
    const scale = typeof config.scale === "number" ? config.scale : 1;
    return {
      kind: "sensor",
      value: data.measuredValue * scale,
      unit: typeof config.unit === "string" ? config.unit : "",
      measure: typeof config.measure === "string" ? config.measure : "value",
    };
  }
  return null;
}
