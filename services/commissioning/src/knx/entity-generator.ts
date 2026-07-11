import type { RecognizedBinding } from "./types.js";

/**
 * Entity Generator (§ Entity Generation). Turns a classified, room-assigned
 * {@link RecognizedDevice} into the commissioning-ready shape the installer orchestrator
 * actually binds: each capability's KNX group address, its real DPT (so the driver frames
 * the bus telegram correctly), and — when the recognition engine found one — a separate
 * status/feedback address so live state reflects the real feedback telegram instead of
 * only an optimistic post-command guess.
 */

export interface CommissionableBinding {
  capability: string;
  address: string;
  /** Passed straight through as the KNX driver's per-binding `config` (see
   * services/gateway/src/installer-context.ts `bindProtocol`) — `dpt`/`statusAddress` are
   * read by `KnxProtocolDriver.bind()`; `unit`/`measure` are read by the "sensor"
   * capability's `stateFromValue` for a correctly-labeled reading. */
  config: Record<string, unknown>;
}

export interface CommissionableDevice {
  name: string;
  room: string | null;
  bindings: CommissionableBinding[];
}

/** The minimum shape `generateEntities` needs — deliberately narrower than the full
 * `RecognizedDevice` so the commit step (which receives this same shape back over the
 * wire from an installer-reviewed preview) doesn't need to reconstruct classification
 * fields (deviceType, confidence, …) it never touches. */
export interface EntitySource {
  name: string;
  room: string | null;
  bindings: RecognizedBinding[];
}

/** measure/unit label for a "sensor"-capability binding, derived from its recognized role
 * — never guessed from the raw DPT alone, so the reading is labeled honestly. */
const SENSOR_MEASURE_UNIT: Record<string, { measure: string; unit: string }> = {
  sensor_power: { measure: "power", unit: "W" },
  sensor_voltage: { measure: "voltage", unit: "V" },
  sensor_current: { measure: "current", unit: "A" },
  sensor_humidity: { measure: "humidity", unit: "%" },
  sensor_lux: { measure: "illuminance", unit: "lx" },
  sensor_co2: { measure: "co2", unit: "ppm" },
  sensor_pressure: { measure: "pressure", unit: "Pa" },
  sensor_generic: { measure: "value", unit: "" },
  presence: { measure: "occupancy", unit: "" },
  window_door: { measure: "window", unit: "" },
  leak: { measure: "leak", unit: "" },
  smoke: { measure: "smoke", unit: "" },
  alarm: { measure: "alarm", unit: "" },
};

/** "9.001" → "DPT9.001", matching the `DPTxxx.yyy` convention the KNX driver's
 * `defaultDpt()`/binding config already use. */
function toDptConfigValue(dpt: string | null): string | undefined {
  return dpt ? `DPT${dpt}` : undefined;
}

export function generateEntities(device: EntitySource): CommissionableDevice {
  const bindings: CommissionableBinding[] = device.bindings.map((b) => {
    const config: Record<string, unknown> = {};
    const dpt = toDptConfigValue(b.dpt);
    if (dpt) config.dpt = dpt;
    if (b.statusAddress) config.statusAddress = b.statusAddress;
    if (b.capability === "sensor") {
      const labeled = SENSOR_MEASURE_UNIT[b.role];
      if (labeled) {
        config.measure = labeled.measure;
        config.unit = labeled.unit;
      }
    }
    return { capability: b.capability, address: b.address, config };
  });
  return { name: device.name, room: device.room, bindings };
}
