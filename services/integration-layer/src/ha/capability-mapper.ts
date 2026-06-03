import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
} from "@supreme/domain-model";

/**
 * HA capability mapper (§7).
 *
 * Translates between Supreme capabilities and Home Assistant's service/state model.
 * This file — and only this file plus the HA adapter — encodes HA-specific
 * knowledge. The mapping is deliberately exhaustive per capability so a future
 * native engine can be validated against the same expectations.
 *
 * NOTE: HA shapes are typed loosely (Record<string, unknown>) on purpose; the SIL
 * never lets these types escape upward.
 */

export interface HaServiceCall {
  domain: string;
  service: string;
  data: Record<string, unknown>;
}

/** Map a Supreme command to an HA service call for a given HA entity id. */
export function commandToHaService(
  entityId: string,
  command: CapabilityCommand,
): HaServiceCall {
  switch (command.capability) {
    case "onoff":
      return {
        domain: domainOf(entityId),
        service: command.action === "off" ? "turn_off" : command.action === "on" ? "turn_on" : "toggle",
        data: { entity_id: entityId },
      };
    case "brightness": {
      if (command.action === "off") {
        return { domain: "light", service: "turn_off", data: { entity_id: entityId } };
      }
      const data: Record<string, unknown> = { entity_id: entityId };
      if (command.level !== undefined) data.brightness_pct = command.level;
      return { domain: "light", service: "turn_on", data };
    }
    case "color": {
      const data: Record<string, unknown> = { entity_id: entityId };
      if (command.level !== undefined) data.brightness_pct = command.level;
      if (command.kelvin !== undefined) data.color_temp_kelvin = command.kelvin;
      if (command.hue !== undefined && command.saturation !== undefined) {
        data.hs_color = [command.hue, command.saturation];
      }
      return { domain: "light", service: "turn_on", data };
    }
    case "temperature": {
      const data: Record<string, unknown> = { entity_id: entityId };
      if (command.targetC !== undefined) data.temperature = command.targetC;
      if (command.targetLowC !== undefined) data.target_temp_low = command.targetLowC;
      if (command.targetHighC !== undefined) data.target_temp_high = command.targetHighC;
      if (command.mode !== undefined) {
        return { domain: "climate", service: "set_hvac_mode", data: { entity_id: entityId, hvac_mode: command.mode } };
      }
      return { domain: "climate", service: "set_temperature", data };
    }
    case "position": {
      if (command.action === "open") return { domain: "cover", service: "open_cover", data: { entity_id: entityId } };
      if (command.action === "close") return { domain: "cover", service: "close_cover", data: { entity_id: entityId } };
      if (command.action === "stop") return { domain: "cover", service: "stop_cover", data: { entity_id: entityId } };
      return {
        domain: "cover",
        service: "set_cover_position",
        data: { entity_id: entityId, position: command.position ?? 0 },
      };
    }
    case "media": {
      const map: Record<string, string> = {
        play: "media_play",
        pause: "media_pause",
        stop: "media_stop",
        next: "media_next_track",
        previous: "media_previous_track",
        mute: "volume_mute",
        unmute: "volume_mute",
        volume: "volume_set",
      };
      const data: Record<string, unknown> = { entity_id: entityId };
      if (command.action === "volume" && command.volume !== undefined) {
        data.volume_level = command.volume / 100;
      }
      if (command.action === "mute") data.is_volume_muted = true;
      if (command.action === "unmute") data.is_volume_muted = false;
      return { domain: "media_player", service: map[command.action]!, data };
    }
    case "lock":
      return {
        domain: "lock",
        service: command.action === "lock" ? "lock" : "unlock",
        data: { entity_id: entityId },
      };
  }
}

/** Normalize an HA state object into a Supreme capability state. */
export function haStateToCapability(
  capability: CapabilityKind,
  ha: { state: string; attributes: Record<string, unknown> },
): CapabilityState | null {
  const attrs = ha.attributes;
  const on = ha.state === "on";
  switch (capability) {
    case "onoff":
      return { kind: "onoff", on };
    case "brightness":
      return { kind: "brightness", on, level: pct(num(attrs.brightness), 255) };
    case "color":
      return {
        kind: "color",
        on,
        level: pct(num(attrs.brightness), 255),
        hue: hs(attrs.hs_color, 0),
        saturation: hs(attrs.hs_color, 1),
        kelvin: numOrNull(attrs.color_temp_kelvin),
      };
    case "temperature":
      return {
        kind: "temperature",
        ambientC: num(attrs.current_temperature) ?? 0,
        targetC: numOrNull(attrs.temperature),
        mode: hvacMode(ha.state),
        humidity: numOrNull(attrs.current_humidity),
      };
    case "position":
      return {
        kind: "position",
        position: num(attrs.current_position) ?? (ha.state === "open" ? 100 : 0),
        moving: ha.state === "opening" || ha.state === "closing",
      };
    case "media":
      return {
        kind: "media",
        playback: mediaPlayback(ha.state),
        volume: pct(num(attrs.volume_level), 1),
        muted: attrs.is_volume_muted === true,
        title: strOrNull(attrs.media_title),
        artist: strOrNull(attrs.media_artist),
        source: strOrNull(attrs.source),
        artworkUrl: strOrNull(attrs.entity_picture),
      };
    case "lock":
      return { kind: "lock", locked: ha.state === "locked", jammed: ha.state === "jammed" };
    case "sensor":
      return {
        kind: "sensor",
        value: num(ha.state) ?? 0,
        unit: String(attrs.unit_of_measurement ?? ""),
        measure: String(attrs.device_class ?? "value"),
      };
  }
}

// ── helpers (kept private to the SIL) ────────────────────────────────────────

function domainOf(entityId: string): string {
  return entityId.split(".")[0] ?? "homeassistant";
}
function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}
function numOrNull(v: unknown): number | null {
  return num(v) ?? null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function pct(v: number | undefined, max: number): number {
  if (v === undefined) return 0;
  return Math.round((v / max) * 100);
}
function hs(v: unknown, idx: 0 | 1): number | null {
  return Array.isArray(v) && typeof v[idx] === "number" ? (v[idx] as number) : null;
}
function hvacMode(state: string): "off" | "heat" | "cool" | "auto" | "fan_only" {
  return (["off", "heat", "cool", "auto", "fan_only"] as const).includes(state as never)
    ? (state as "off")
    : "off";
}
function mediaPlayback(state: string): "playing" | "paused" | "stopped" | "idle" {
  if (state === "playing" || state === "paused") return state;
  if (state === "idle" || state === "off") return "idle";
  return "stopped";
}
