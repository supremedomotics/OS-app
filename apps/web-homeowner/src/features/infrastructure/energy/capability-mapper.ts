import type { Device } from "@supreme/domain-model";
import type { IconName } from "@supreme/aureon-web";

/**
 * Energy device classification (§ Infrastructure Design Language, first module). Mirrors the
 * Media/Security `capability-mapper.ts` pattern exactly: `device.metadata.energy.kind` is the
 * installer override and always wins; failing that, classification falls back to the real
 * capability shape the device already reports (never a guess dressed up as a protocol check —
 * there is no energy-specific protocol signal the way AVR/SIP are for Media/Security).
 */
export type EnergyDeviceKind =
  | "smart_plug" | "power_meter" | "solar_inverter" | "battery_storage" | "ev_charger" | "generator";

export interface EnergyKindMeta {
  kind: EnergyDeviceKind;
  label: string;
  /** Plain-text glyph — the one sanctioned use is a native <select><option>, which can't render SVG. */
  icon: string;
  iconName: IconName;
}

const KIND_META: Record<EnergyDeviceKind, EnergyKindMeta> = {
  smart_plug: { kind: "smart_plug", label: "Smart Plug", icon: "🔌", iconName: "plug" },
  power_meter: { kind: "power_meter", label: "Power Meter", icon: "⚡", iconName: "energy" },
  solar_inverter: { kind: "solar_inverter", label: "Solar Inverter", icon: "☀️", iconName: "sun" },
  battery_storage: { kind: "battery_storage", label: "Battery Storage", icon: "🔋", iconName: "battery" },
  ev_charger: { kind: "ev_charger", label: "EV Charger", icon: "🚗", iconName: "ev" },
  generator: { kind: "generator", label: "Generator", icon: "🛢", iconName: "generator-unit" },
};

function isEnergyDeviceKind(v: unknown): v is EnergyDeviceKind {
  return typeof v === "string" && Object.hasOwn(KIND_META, v);
}

/** `measure` on a `sensor` capability's config/state is a free string (§ domain-model
 * capabilities.ts — no dedicated energy CapabilityKind exists yet); this is the real signal a
 * device backs an energy reading, same honesty bar as every other module's classification. */
function isPowerMeasure(measure: unknown): boolean {
  return measure === "power" || measure === "energy";
}

export function energyDeviceKind(device: Device): EnergyDeviceKind {
  const override = (device.metadata as { energy?: { kind?: unknown } } | undefined)?.energy?.kind;
  if (isEnergyDeviceKind(override)) return override;
  const hasOnOff = device.capabilities.some((c) => c.kind === "onoff");
  return hasOnOff ? "smart_plug" : "power_meter";
}

export function energyKindMeta(kind: EnergyDeviceKind): EnergyKindMeta {
  return KIND_META[kind];
}

export const ENERGY_KIND_OPTIONS: EnergyKindMeta[] = Object.values(KIND_META);

/** Whether this module owns rendering the device at all: a real `sensor` capability reading
 * power/energy, or an installer-classified `device.metadata.energy.kind` even before a driver
 * backs a live reading (§ "the UI is the contract" — the device still gets a home in the UI). */
export function isEnergyDevice(device: Device): boolean {
  if (device.capabilities.some((c) => c.kind === "sensor" && isPowerMeasure((c.config as { measure?: unknown } | undefined)?.measure))) {
    return true;
  }
  return isEnergyDeviceKind((device.metadata as { energy?: { kind?: unknown } } | undefined)?.energy?.kind);
}

/** Live power/energy reading off `useLive()` state or the device's last-known state, whichever
 * the caller has on hand — same shape either way. */
export function energyReading(state: unknown): { value: number; unit: string; measure: string } | null {
  const sensor = (state as Record<string, unknown> | undefined)?.sensor as
    | { value?: number; unit?: string; measure?: string }
    | undefined;
  if (!sensor || typeof sensor.value !== "number" || !isPowerMeasure(sensor.measure)) return null;
  return { value: sensor.value, unit: sensor.unit ?? "", measure: sensor.measure! };
}
