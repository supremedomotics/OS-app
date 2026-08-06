import type { CanonicalIntent, HubDevice } from "./hub-router.js";

/**
 * Google Smart Home (Home Graph) fulfillment mapping (blueprint §9). Translates the
 * SYNC / QUERY / EXECUTE / DISCONNECT intents to/from the Supreme device model and our canonical
 * intent. Pure functions — the webhook (server.ts) supplies OAuth + hub forwarding.
 *
 * Ref: developers.home.google.com/cloud-to-cloud/intents
 */

export interface GoogleRequest {
  requestId: string;
  inputs: { intent: string; payload?: Record<string, unknown> }[];
}

const GOOGLE_TYPE: Record<string, string> = {
  light: "action.devices.types.LIGHT",
  switch: "action.devices.types.SWITCH",
  climate: "action.devices.types.THERMOSTAT",
  cover: "action.devices.types.BLINDS",
  lock: "action.devices.types.LOCK",
  fan: "action.devices.types.FAN",
  sensor: "action.devices.types.SENSOR",
};

function googleTraits(cap: string): string[] {
  switch (cap) {
    case "onoff":
      return ["action.devices.traits.OnOff"];
    case "brightness":
      return ["action.devices.traits.Brightness"];
    case "color":
      return ["action.devices.traits.ColorSetting"];
    case "temperature":
      return ["action.devices.traits.TemperatureSetting"];
    case "position":
      return ["action.devices.traits.OpenClose"];
    case "lock":
      return ["action.devices.traits.LockUnlock"];
    default:
      return [];
  }
}

// ── SYNC ──────────────────────────────────────────────────────────────────────────────────────
export function buildSyncResponse(requestId: string, agentUserId: string, devices: HubDevice[]): unknown {
  const out = devices
    .map((d) => {
      const caps = d.capabilities.map((c) => c.kind);
      const traits = [...new Set(caps.flatMap(googleTraits))];
      return { d, caps, traits };
    })
    // § Correctness Fix — a device whose capabilities map to zero real Google traits
    // (e.g. `fan`/`vacuum`/`media`/`sensor`-only) previously still got synced with a
    // device `type` (`GOOGLE_TYPE`) and an empty `traits` array: it showed up in
    // Google Home but had nothing operable at all — advertised, unusable (§ Never
    // advertise unsupported functionality). Omitted entirely, matching the Alexa
    // discovery fix's reasoning exactly.
    .filter(({ traits }) => traits.length > 0)
    .map(({ d, caps, traits }) => {
      const attributes: Record<string, unknown> = {};
      if (caps.includes("color")) attributes.colorModel = "hsv";
      if (caps.includes("color")) attributes.colorTemperatureRange = { temperatureMinK: 2000, temperatureMaxK: 6500 };
      if (caps.includes("temperature")) {
        attributes.availableThermostatModes = ["off", "heat", "cool", "auto"];
        attributes.thermostatTemperatureUnit = "C";
      }
      return {
        id: d.id,
        type: GOOGLE_TYPE[d.supremeType] ?? "action.devices.types.OUTLET",
        traits,
        name: { name: d.name },
        willReportState: true,
        attributes,
      };
    });
  return { requestId, payload: { agentUserId, devices: out } };
}

// ── QUERY ───────────────────────────────────────────────────────────────────────────────────────
export function googleDeviceState(device: HubDevice): Record<string, unknown> {
  const st = device.state ?? {};
  const state: Record<string, unknown> = { online: device.status !== "offline", status: "SUCCESS" };
  if (st.onoff) state.on = Boolean((st.onoff as { on?: boolean }).on);
  if (st.brightness) state.brightness = (st.brightness as { level?: number }).level ?? 0;
  if (st.lock) state.isLocked = Boolean((st.lock as { locked?: boolean }).locked);
  if (st.position) state.openPercent = (st.position as { position?: number }).position ?? 0;
  if (st.temperature) state.thermostatTemperatureSetpoint = (st.temperature as { targetC?: number }).targetC ?? 20;
  return state;
}

export function buildQueryResponse(requestId: string, states: Record<string, Record<string, unknown>>): unknown {
  return { requestId, payload: { devices: states } };
}

/** The Google state fragment for one capability's current state (used by proactive ReportState). */
export function googleStateFragment(capability: string, state: Record<string, unknown>): Record<string, unknown> | null {
  switch (capability) {
    case "onoff":
      return { on: Boolean(state.on) };
    case "brightness":
      return { brightness: Number(state.level ?? 0) };
    case "lock":
      return { isLocked: Boolean(state.locked) };
    case "position":
      return { openPercent: Number(state.position ?? 0) };
    case "temperature":
      return { thermostatTemperatureSetpoint: Number(state.targetC ?? 0) };
    default:
      return null;
  }
}

// ── EXECUTE ─────────────────────────────────────────────────────────────────────────────────────
/** Map a Google execution (command id + params) to our canonical intent. */
export function googleExecutionToCanonical(command: string, params: Record<string, unknown>): CanonicalIntent | null {
  switch (command) {
    case "action.devices.commands.OnOff":
      return params.on ? { intent: "TurnOn" } : { intent: "TurnOff" };
    case "action.devices.commands.BrightnessAbsolute":
      return { intent: "SetBrightness", brightnessPct: Number(params.brightness) };
    case "action.devices.commands.ColorAbsolute": {
      const color = params.color as { spectrumHSV?: { hue?: number; saturation?: number }; temperature?: number } | undefined;
      if (color?.temperature !== undefined) return { intent: "SetColorTemperature", kelvin: Number(color.temperature) };
      const hsv = color?.spectrumHSV;
      return { intent: "SetColor", hue: Number(hsv?.hue ?? 0), saturationPct: Math.round(Number(hsv?.saturation ?? 0) * 100) };
    }
    case "action.devices.commands.ThermostatTemperatureSetpoint":
      return { intent: "SetTargetTemperature", targetC: Number(params.thermostatTemperatureSetpoint) };
    case "action.devices.commands.OpenClose": {
      const pct = Number(params.openPercent);
      if (pct <= 0) return { intent: "Close" };
      if (pct >= 100) return { intent: "Open" };
      return { intent: "SetPosition", positionPct: pct };
    }
    case "action.devices.commands.LockUnlock":
      return params.lock ? { intent: "Lock" } : { intent: "Unlock" };
    default:
      return null;
  }
}

export interface GoogleCommandResult {
  ids: string[];
  status: "SUCCESS" | "ERROR" | "OFFLINE";
  states?: Record<string, unknown>;
  errorCode?: string;
}

export function buildExecuteResponse(requestId: string, commands: GoogleCommandResult[]): unknown {
  return { requestId, payload: { commands } };
}
