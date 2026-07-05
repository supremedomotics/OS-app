import type { CapabilityCommand, CapabilityKind, CapabilityState } from "@supreme/domain-model";

/**
 * Shelly Gen2+ codec (§3). Shelly Plus/Pro devices expose an openly-documented JSON-RPC
 * API over HTTP (`POST /rpc`): components like `Switch`, `Light`, `Cover` are driven by
 * `*.Set` calls and read from `Shelly.GetStatus`. This maps Supreme capabilities to those
 * RPC calls + parses the status back. (Gen1 REST is a follow-on.)
 */
export interface ShellyRpcCall {
  method: string;
  params: Record<string, unknown>;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Translate a Supreme command into a Shelly RPC call (null = unsupported). `id` = component index. */
export function commandToShellyRpc(
  command: CapabilityCommand,
  id: number,
  prev: CapabilityState | null,
): ShellyRpcCall | null {
  switch (command.capability) {
    case "onoff": {
      if (command.action === "toggle") return { method: "Switch.Toggle", params: { id } };
      return { method: "Switch.Set", params: { id, on: command.action === "on" } };
    }
    case "brightness": {
      if (command.action === "off") return { method: "Light.Set", params: { id, on: false } };
      const level = typeof command.level === "number" ? command.level : prev?.kind === "brightness" ? prev.level : 100;
      return { method: "Light.Set", params: { id, on: true, brightness: clampPct(level) } };
    }
    case "position": {
      if (command.action === "stop") return { method: "Cover.Stop", params: { id } };
      const pos =
        command.action === "open"
          ? 100
          : command.action === "close"
            ? 0
            : (command.position ?? (prev?.kind === "position" ? prev.position : 0));
      return { method: "Cover.GoToPosition", params: { id, pos: clampPct(pos) } };
    }
    default:
      return null;
  }
}

/** Read a capability's state out of a `Shelly.GetStatus` result. */
export function stateFromShellyStatus(
  capability: CapabilityKind,
  status: Record<string, unknown>,
  id: number,
): CapabilityState | null {
  if (capability === "onoff") {
    const sw = status[`switch:${id}`] as { output?: boolean } | undefined;
    return sw ? { kind: "onoff", on: Boolean(sw.output) } : null;
  }
  if (capability === "brightness") {
    const li = status[`light:${id}`] as { output?: boolean; brightness?: number } | undefined;
    if (!li) return null;
    const level = typeof li.brightness === "number" ? clampPct(li.brightness) : 0;
    return { kind: "brightness", on: Boolean(li.output), level };
  }
  if (capability === "position") {
    const cv = status[`cover:${id}`] as { current_pos?: number } | undefined;
    if (!cv || typeof cv.current_pos !== "number") return null;
    return { kind: "position", position: clampPct(cv.current_pos), moving: false };
  }
  if (capability === "sensor") {
    const sw = status[`switch:${id}`] as { apower?: number } | undefined;
    if (!sw || typeof sw.apower !== "number") return null;
    return { kind: "sensor", value: sw.apower, unit: "W", measure: "power" };
  }
  return null;
}

/** Infer a device's Supreme capabilities from the components in its GetStatus result. */
export function capabilitiesFromShellyStatus(status: Record<string, unknown>): CapabilityKind[] {
  const caps = new Set<CapabilityKind>();
  for (const key of Object.keys(status)) {
    if (key.startsWith("switch:")) {
      caps.add("onoff");
      if (typeof (status[key] as { apower?: number }).apower === "number") caps.add("sensor");
    } else if (key.startsWith("light:")) caps.add("brightness");
    else if (key.startsWith("cover:")) caps.add("position");
  }
  const order: CapabilityKind[] = ["onoff", "brightness", "position", "sensor"];
  return order.filter((c) => caps.has(c));
}
