import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";

/**
 * Capability ↔ MQTT payload codec. The wire convention is **Zigbee2MQTT-compatible**
 * (the dominant real-world MQTT smart-home bridge): device state is a JSON object on
 * the device's base topic (`{"state":"ON","brightness":0..254}`), and commands are
 * JSON published to `{base}/set`. Driving a real Zigbee2MQTT/Tasmota light therefore
 * needs no shim. Per-binding `config` tunes the sensor mapping.
 */

const Z2M_MAX_BRIGHTNESS = 254;

function pct(z2m: number): number {
  return Math.max(0, Math.min(100, Math.round((z2m / Z2M_MAX_BRIGHTNESS) * 100)));
}
function toZ2m(level: number): number {
  return Math.max(0, Math.min(Z2M_MAX_BRIGHTNESS, Math.round((level / 100) * Z2M_MAX_BRIGHTNESS)));
}

/** Map an inbound MQTT JSON payload to a Supreme capability state (null = no update). */
export function stateFromPayload(
  capability: CapabilityState["kind"],
  payload: Record<string, unknown>,
  config: Record<string, unknown> = {},
): CapabilityState | null {
  switch (capability) {
    case "onoff": {
      if (typeof payload.state !== "string") return null;
      return { kind: "onoff", on: payload.state.toUpperCase() === "ON" };
    }
    case "brightness": {
      const on =
        typeof payload.state === "string" ? payload.state.toUpperCase() === "ON" : undefined;
      const level = typeof payload.brightness === "number" ? pct(payload.brightness) : undefined;
      if (on === undefined && level === undefined) return null;
      return { kind: "brightness", on: on ?? (level ?? 0) > 0, level: level ?? (on ? 100 : 0) };
    }
    case "sensor": {
      // The reading field is configurable (e.g. "temperature", "humidity", "power").
      const field = typeof config.field === "string" ? config.field : "value";
      const raw = payload[field];
      if (typeof raw !== "number") return null;
      return {
        kind: "sensor",
        value: raw,
        unit: typeof config.unit === "string" ? config.unit : "",
        measure: typeof config.measure === "string" ? config.measure : field,
      };
    }
    default:
      return null;
  }
}

/** Build the JSON to publish to `{base}/set` for a Supreme command (null = no write). */
export function payloadFromCommand(
  command: CapabilityCommand,
  prev: CapabilityState | null,
): Record<string, unknown> | null {
  switch (command.capability) {
    case "onoff": {
      const on =
        command.action === "on"
          ? true
          : command.action === "off"
            ? false
            : !(prev?.kind === "onoff" ? prev.on : false);
      return { state: on ? "ON" : "OFF" };
    }
    case "brightness": {
      if (command.action === "off") return { state: "OFF" };
      const out: Record<string, unknown> = { state: "ON" };
      if (typeof command.level === "number") out.brightness = toZ2m(command.level);
      return out;
    }
    default:
      // Other capabilities (color/position/lock/temperature) are not yet mapped to the
      // Z2M convention here; commissioning won't bind them to the MQTT driver.
      return null;
  }
}
