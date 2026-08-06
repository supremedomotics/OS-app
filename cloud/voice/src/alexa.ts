import { randomUUID } from "node:crypto";
import type { CanonicalIntent, HubDevice } from "./hub-router.js";

/**
 * Alexa Smart Home Skill payload mapping (blueprint §9). Translates the Smart Home message format
 * (directive.header namespace/name + endpoint + payload) to/from our canonical intent and the
 * Supreme device model. Pure functions — no I/O — so the skill contract is unit-testable to Amazon's
 * certification shape. The webhook (server.ts) supplies auth + hub forwarding around these.
 *
 * Ref: developer.amazon.com/docs/device-apis/smart-home-general-apis.html
 */

export interface AlexaDirective {
  directive: {
    header: { namespace: string; name: string; payloadVersion: string; messageId: string; correlationToken?: string };
    endpoint?: { endpointId: string; scope?: { type: string; token: string } };
    payload: Record<string, unknown> & { scope?: { type: string; token: string } };
  };
}

/** Bearer token Alexa presents — on the endpoint scope for control, payload scope for Discovery. */
export function alexaBearerToken(d: AlexaDirective): string | undefined {
  return d.directive.endpoint?.scope?.token ?? d.directive.payload.scope?.token;
}

const header = (namespace: string, name: string, correlationToken?: string) => ({
  namespace,
  name,
  payloadVersion: "3",
  messageId: randomUUID(),
  ...(correlationToken ? { correlationToken } : {}),
});

// ── Discovery ────────────────────────────────────────────────────────────────────────────────
/** Alexa capability interfaces a Supreme capability projects to. */
function alexaInterfaces(cap: string): { interface: string; properties: string[] }[] {
  switch (cap) {
    case "onoff":
      return [{ interface: "Alexa.PowerController", properties: ["powerState"] }];
    case "brightness":
      return [{ interface: "Alexa.BrightnessController", properties: ["brightness"] }];
    case "color":
      return [
        { interface: "Alexa.ColorController", properties: ["color"] },
        { interface: "Alexa.ColorTemperatureController", properties: ["colorTemperatureInKelvin"] },
      ];
    case "temperature":
      return [{ interface: "Alexa.ThermostatController", properties: ["targetSetpoint"] }];
    case "position":
      return [{ interface: "Alexa.RangeController", properties: ["rangeValue"] }];
    case "lock":
      return [{ interface: "Alexa.LockController", properties: ["lockState"] }];
    default:
      return [];
  }
}

const ALEXA_DISPLAY: Record<string, string> = {
  light: "LIGHT",
  switch: "SWITCH",
  climate: "THERMOSTAT",
  cover: "INTERIOR_BLIND",
  lock: "SMARTLOCK",
  fan: "FAN",
  sensor: "TEMPERATURE_SENSOR",
};

function capabilityResource(iface: { interface: string; properties: string[] }) {
  return {
    type: "AlexaInterface",
    interface: iface.interface,
    version: "3",
    properties: { supported: iface.properties.map((p) => ({ name: p })), proactivelyReported: true, retrievable: true },
  };
}

export function buildDiscoveryResponse(devices: HubDevice[]): unknown {
  const endpoints = devices
    .map((d) => {
      const caps = d.capabilities.map((c) => c.kind);
      const ifaces = [...new Map(caps.flatMap(alexaInterfaces).map((i) => [i.interface, i])).values()];
      return { d, ifaces };
    })
    // § Correctness Fix — a device whose capabilities map to zero real Alexa
    // interfaces (e.g. `fan`/`vacuum`/`media`/`sensor`-only) previously still got
    // discovered with a display category (`ALEXA_DISPLAY`) and only the mandatory
    // base `Alexa` interface: it showed up in the Alexa app but had no operable
    // control at all — advertised, unusable (§ Never advertise unsupported
    // functionality). Omitting it entirely is the honest choice the phase calls
    // for: a device with nothing Alexa can genuinely control is not discoverable.
    .filter(({ ifaces }) => ifaces.length > 0)
    .map(({ d, ifaces }) => ({
      endpointId: d.id,
      manufacturerName: "Supreme",
      friendlyName: d.name,
      description: `${d.name} by Supreme`,
      displayCategories: [ALEXA_DISPLAY[d.supremeType] ?? "OTHER"],
      capabilities: [
        { type: "AlexaInterface", interface: "Alexa", version: "3" },
        ...ifaces.map(capabilityResource),
      ],
    }));
  return { event: { header: header("Alexa.Discovery", "Discover.Response"), payload: { endpoints } } };
}

// ── Directive → canonical intent ───────────────────────────────────────────────────────────────
export function alexaDirectiveToCanonical(d: AlexaDirective): CanonicalIntent | null {
  const { namespace, name } = d.directive.header;
  const p = d.directive.payload;
  switch (`${namespace}.${name}`) {
    case "Alexa.PowerController.TurnOn":
      return { intent: "TurnOn" };
    case "Alexa.PowerController.TurnOff":
      return { intent: "TurnOff" };
    case "Alexa.BrightnessController.SetBrightness":
      return { intent: "SetBrightness", brightnessPct: Number(p.brightness) };
    case "Alexa.ColorController.SetColor": {
      const c = p.color as { hue?: number; saturation?: number } | undefined;
      return { intent: "SetColor", hue: Number(c?.hue ?? 0), saturationPct: Math.round(Number(c?.saturation ?? 0) * 100) };
    }
    case "Alexa.ColorTemperatureController.SetColorTemperature":
      return { intent: "SetColorTemperature", kelvin: Number(p.colorTemperatureInKelvin) };
    case "Alexa.ThermostatController.SetTargetTemperature": {
      const s = p.targetSetpoint as { value?: number } | undefined;
      return { intent: "SetTargetTemperature", targetC: Number(s?.value) };
    }
    case "Alexa.RangeController.SetRangeValue":
      return { intent: "SetPosition", positionPct: Number(p.rangeValue) };
    case "Alexa.LockController.Lock":
      return { intent: "Lock" };
    case "Alexa.LockController.Unlock":
      return { intent: "Unlock" };
    default:
      return null;
  }
}

// ── Responses ────────────────────────────────────────────────────────────────────────────────
/** A successful control response. Alexa wants the new state echoed back as context properties. */
export function buildControlResponse(d: AlexaDirective, properties: unknown[] = []): unknown {
  return {
    context: { properties },
    event: {
      header: header("Alexa", "Response", d.directive.header.correlationToken),
      endpoint: { endpointId: d.directive.endpoint?.endpointId },
      payload: {},
    },
  };
}

export function buildErrorResponse(d: AlexaDirective, type: string, message: string): unknown {
  return {
    event: {
      header: header("Alexa", "ErrorResponse", d.directive.header.correlationToken),
      endpoint: { endpointId: d.directive.endpoint?.endpointId },
      payload: { type, message },
    },
  };
}

/** Project a Supreme device's state into Alexa context properties (for ReportState / responses). */
export function alexaStateProperties(device: HubDevice, nowIso: string): unknown[] {
  const props: { namespace: string; name: string; value: unknown; timeOfSample: string; uncertaintyInMilliseconds: number }[] = [];
  const push = (namespace: string, propName: string, value: unknown) =>
    props.push({ namespace, name: propName, value, timeOfSample: nowIso, uncertaintyInMilliseconds: 500 });
  const st = device.state ?? {};
  if (st.onoff) push("Alexa.PowerController", "powerState", (st.onoff as { on?: boolean }).on ? "ON" : "OFF");
  if (st.brightness) push("Alexa.BrightnessController", "brightness", (st.brightness as { level?: number }).level ?? 0);
  if (st.lock) push("Alexa.LockController", "lockState", (st.lock as { locked?: boolean }).locked ? "LOCKED" : "UNLOCKED");
  if (st.position) push("Alexa.RangeController", "rangeValue", (st.position as { position?: number }).position ?? 0);
  return props;
}

/**
 * The property a directive changes, echoed optimistically in the control response (Alexa expects
 * the new state without a round-trip back to the device). Derived from the canonical intent.
 */
export function alexaOptimisticProperties(intent: CanonicalIntent, nowIso: string): unknown[] {
  const prop = (namespace: string, name: string, value: unknown) => [
    { namespace, name, value, timeOfSample: nowIso, uncertaintyInMilliseconds: 500 },
  ];
  switch (intent.intent) {
    case "TurnOn":
      return prop("Alexa.PowerController", "powerState", "ON");
    case "TurnOff":
      return prop("Alexa.PowerController", "powerState", "OFF");
    case "SetBrightness":
      return prop("Alexa.BrightnessController", "brightness", Math.round(intent.brightnessPct));
    case "SetColorTemperature":
      return prop("Alexa.ColorTemperatureController", "colorTemperatureInKelvin", Math.round(intent.kelvin));
    case "SetTargetTemperature":
      return prop("Alexa.ThermostatController", "targetSetpoint", { value: intent.targetC, scale: "CELSIUS" });
    case "SetPosition":
      return prop("Alexa.RangeController", "rangeValue", Math.round(intent.positionPct));
    case "Lock":
      return prop("Alexa.LockController", "lockState", "LOCKED");
    case "Unlock":
      return prop("Alexa.LockController", "lockState", "UNLOCKED");
    default:
      return [];
  }
}

/**
 * Build the single Alexa property for one capability's current state (used by proactive
 * ChangeReport when a device changes locally). `state` is the Supreme capability state object.
 */
export function alexaPropertyFor(capability: string, state: Record<string, unknown>, nowIso: string): unknown | null {
  const p = (namespace: string, name: string, value: unknown) => ({ namespace, name, value, timeOfSample: nowIso, uncertaintyInMilliseconds: 500 });
  switch (capability) {
    case "onoff":
      return p("Alexa.PowerController", "powerState", state.on ? "ON" : "OFF");
    case "brightness":
      return p("Alexa.BrightnessController", "brightness", Number(state.level ?? 0));
    case "lock":
      return p("Alexa.LockController", "lockState", state.locked ? "LOCKED" : "UNLOCKED");
    case "position":
      return p("Alexa.RangeController", "rangeValue", Number(state.position ?? 0));
    case "temperature":
      return p("Alexa.ThermostatController", "targetSetpoint", { value: Number(state.targetC ?? 0), scale: "CELSIUS" });
    default:
      return null;
  }
}

/** Response to the Alexa.Authorization AcceptGrant directive (proactive-reporting enrollment). */
export function buildAcceptGrantResponse(): unknown {
  return { event: { header: header("Alexa.Authorization", "AcceptGrant.Response"), payload: {} } };
}

export function buildReportStateResponse(d: AlexaDirective, device: HubDevice, nowIso: string): unknown {
  return {
    context: { properties: alexaStateProperties(device, nowIso) },
    event: {
      header: header("Alexa", "StateReport", d.directive.header.correlationToken),
      endpoint: { endpointId: device.id },
      payload: {},
    },
  };
}
