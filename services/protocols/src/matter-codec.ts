import type { CapabilityCommand, CapabilityKind, CapabilityState } from "@supreme/domain-model";

/**
 * Matter capability ↔ cluster codec (§3, §9). Matter devices expose functionality as
 * **clusters** on **endpoints** (OnOff, LevelControl, ColorControl, DoorLock,
 * WindowCovering, measurement clusters). This maps Supreme capabilities to cluster
 * commands (outbound) and cluster attribute reports (inbound), so the driver confines
 * all Matter detail and emits pure Supreme capabilities upward. Matter is the
 * blueprint's opt-in local controller — disabled until the owner enables it.
 */

const MATTER_MAX_LEVEL = 254;

function pct(level: number): number {
  return Math.max(0, Math.min(100, Math.round((level / MATTER_MAX_LEVEL) * 100)));
}
function toLevel(p: number): number {
  return Math.max(0, Math.min(MATTER_MAX_LEVEL, Math.round((p / 100) * MATTER_MAX_LEVEL)));
}

/** Which Matter cluster backs a Supreme capability. */
export function clusterForCapability(capability: CapabilityKind): string | null {
  switch (capability) {
    case "onoff":
      return "OnOff";
    case "brightness":
      return "LevelControl";
    case "color":
      return "ColorControl";
    case "lock":
      return "DoorLock";
    case "position":
      return "WindowCovering";
    case "sensor":
      return "TemperatureMeasurement";
    default:
      return null;
  }
}

/** Map device-type clusters present on an endpoint to Supreme capabilities. */
export function capabilitiesFromClusters(clusters: string[]): CapabilityKind[] {
  const set = new Set<CapabilityKind>();
  for (const c of clusters) {
    if (c === "OnOff") set.add("onoff");
    else if (c === "LevelControl") set.add("brightness");
    else if (c === "ColorControl") set.add("color");
    else if (c === "DoorLock") set.add("lock");
    else if (c === "WindowCovering") set.add("position");
    else if (c === "TemperatureMeasurement" || c === "RelativeHumidityMeasurement" || c === "OccupancySensing")
      set.add("sensor");
  }
  const order: CapabilityKind[] = ["onoff", "brightness", "color", "position", "lock", "sensor"];
  return order.filter((c) => set.has(c));
}

export interface MatterInvocation {
  cluster: string;
  command: string;
  fields: Record<string, unknown>;
}

/** Translate a Supreme command into a Matter cluster invocation (null = unsupported). */
export function invocationFromCommand(
  command: CapabilityCommand,
  prev: CapabilityState | null,
): MatterInvocation | null {
  switch (command.capability) {
    case "onoff": {
      const cmd = command.action === "on" ? "On" : command.action === "off" ? "Off" : "Toggle";
      return { cluster: "OnOff", command: cmd, fields: {} };
    }
    case "brightness": {
      if (command.action === "off") return { cluster: "OnOff", command: "Off", fields: {} };
      const level = typeof command.level === "number" ? toLevel(command.level) : MATTER_MAX_LEVEL;
      return { cluster: "LevelControl", command: "MoveToLevel", fields: { level, transitionTime: 0 } };
    }
    case "color": {
      if (typeof command.kelvin === "number") {
        return {
          cluster: "ColorControl",
          command: "MoveToColorTemperature",
          fields: { colorTemperatureMireds: Math.round(1_000_000 / command.kelvin), transitionTime: 0 },
        };
      }
      const base = prev?.kind === "color" ? prev : null;
      const hue = command.hue ?? base?.hue ?? 0;
      const sat = command.saturation ?? base?.saturation ?? 0;
      return {
        cluster: "ColorControl",
        command: "MoveToHueAndSaturation",
        fields: {
          hue: Math.round((hue / 360) * MATTER_MAX_LEVEL),
          saturation: toLevel(sat),
          transitionTime: 0,
        },
      };
    }
    case "lock":
      return { cluster: "DoorLock", command: command.action === "lock" ? "LockDoor" : "UnlockDoor", fields: {} };
    case "position": {
      const p =
        command.action === "open"
          ? 100
          : command.action === "close"
            ? 0
            : (command.position ?? (prev?.kind === "position" ? prev.position : 0));
      return {
        cluster: "WindowCovering",
        command: "GoToLiftPercentage",
        fields: { liftPercent100thsValue: Math.round(p * 100) },
      };
    }
    default:
      return null; // temperature/media not mapped to Matter commands here
  }
}

/** Translate a Matter attribute report into a Supreme capability state (null = ignore). */
export function stateFromAttribute(
  capability: CapabilityKind,
  cluster: string,
  attribute: string,
  value: unknown,
  prev: CapabilityState | null,
  config: Record<string, unknown> = {},
): CapabilityState | null {
  if (capability === "onoff" && cluster === "OnOff" && attribute === "OnOff") {
    return { kind: "onoff", on: Boolean(value) };
  }
  if (capability === "brightness") {
    if (cluster === "LevelControl" && attribute === "CurrentLevel") {
      const level = pct(Number(value));
      return { kind: "brightness", on: level > 0, level };
    }
    if (cluster === "OnOff" && attribute === "OnOff") {
      const level = prev?.kind === "brightness" ? prev.level : 100;
      return { kind: "brightness", on: Boolean(value), level };
    }
  }
  if (capability === "color" && cluster === "ColorControl") {
    const base = prev?.kind === "color" ? prev : null;
    if (attribute === "ColorTemperatureMireds") {
      const mireds = Number(value);
      return {
        kind: "color",
        on: base?.on ?? true,
        level: base?.level ?? 100,
        hue: null,
        saturation: null,
        kelvin: mireds > 0 ? Math.round(1_000_000 / mireds) : null,
      };
    }
    if (attribute === "CurrentHue") {
      return { kind: "color", on: base?.on ?? true, level: base?.level ?? 100, hue: Math.round((Number(value) / MATTER_MAX_LEVEL) * 360), saturation: base?.saturation ?? null, kelvin: null };
    }
    if (attribute === "CurrentSaturation") {
      return { kind: "color", on: base?.on ?? true, level: base?.level ?? 100, hue: base?.hue ?? null, saturation: pct(Number(value)), kelvin: null };
    }
  }
  if (capability === "lock" && cluster === "DoorLock" && attribute === "LockState") {
    // Matter LockState: 0 NotFullyLocked, 1 Locked, 2 Unlocked.
    return { kind: "lock", locked: Number(value) === 1, jammed: false };
  }
  if (capability === "position" && cluster === "WindowCovering" && attribute === "CurrentPositionLiftPercent100ths") {
    return { kind: "position", position: Math.max(0, Math.min(100, Math.round(Number(value) / 100))), moving: false };
  }
  if (capability === "sensor") {
    if (cluster === "TemperatureMeasurement" && attribute === "MeasuredValue") {
      return { kind: "sensor", value: Number(value) / 100, unit: "°C", measure: "temperature" };
    }
    if (cluster === "RelativeHumidityMeasurement" && attribute === "MeasuredValue") {
      return { kind: "sensor", value: Number(value) / 100, unit: "%", measure: "humidity" };
    }
    if (cluster === "OccupancySensing" && attribute === "Occupancy") {
      return { kind: "sensor", value: Number(value) ? 1 : 0, unit: "", measure: "occupancy" };
    }
    // A configured generic measured value.
    if (attribute === "MeasuredValue") {
      const scale = typeof config.scale === "number" ? config.scale : 1;
      return {
        kind: "sensor",
        value: Number(value) * scale,
        unit: typeof config.unit === "string" ? config.unit : "",
        measure: typeof config.measure === "string" ? config.measure : "value",
      };
    }
  }
  return null;
}
