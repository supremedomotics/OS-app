/**
 * @supreme/voice — the cloud Voice service (blueprint §9).
 *
 * The cloud owns assistant LINKING and cloud-to-cloud; the hub owns EXECUTION. Home Assistant
 * is never exposed. One Supreme capability model maps onto every ecosystem, so a single mapping
 * serves Alexa, Google, and HomeKit:
 *   • link an assistant account to a Supreme account+home;
 *   • DISCOVERY: project a Supreme device's capabilities into each assistant's vocabulary;
 *   • DIRECTIVE routing: normalize an assistant directive into a Supreme capability command the
 *     Tunnel Broker forwards to the hub;
 *   • STATE reporting: project a hub state change into an assistant report.
 *
 * Pure mapping/registry logic — no I/O — so it's deterministic and unit-testable.
 */

export type Assistant = "alexa" | "google" | "homekit" | "siri";

/** The Supreme capability set (mirrors the SIL/domain-model capabilities). */
export type Capability =
  | "onoff"
  | "brightness"
  | "color"
  | "temperature"
  | "position"
  | "media"
  | "lock"
  | "fan"
  | "vacuum"
  | "sensor";

// ── Account linking ────────────────────────────────────────────────────────────────────────
export interface VoiceLink {
  assistant: Assistant;
  externalUserRef: string;
  accountId: string;
  homeId: string;
  scopes: string[];
  linkedAt: number;
}

export interface IVoiceLinkStore {
  put(link: VoiceLink): void;
  get(assistant: Assistant, externalUserRef: string): VoiceLink | undefined;
  delete(assistant: Assistant, externalUserRef: string): void;
}

export class InMemoryVoiceLinkStore implements IVoiceLinkStore {
  private links = new Map<string, VoiceLink>();
  private key(a: Assistant, ref: string) {
    return `${a}|${ref}`;
  }
  put(link: VoiceLink) {
    this.links.set(this.key(link.assistant, link.externalUserRef), link);
  }
  get(a: Assistant, ref: string) {
    return this.links.get(this.key(a, ref));
  }
  delete(a: Assistant, ref: string) {
    this.links.delete(this.key(a, ref));
  }
}

// ── Capability → assistant discovery vocabulary ─────────────────────────────────────────────
/** Per-assistant capability descriptors (Alexa interfaces / Google traits / HomeKit services). */
const VOCAB: Record<Assistant, Partial<Record<Capability, string>>> = {
  alexa: {
    onoff: "Alexa.PowerController",
    brightness: "Alexa.BrightnessController",
    color: "Alexa.ColorController",
    temperature: "Alexa.ThermostatController",
    position: "Alexa.RangeController",
    media: "Alexa.PlaybackController",
    lock: "Alexa.LockController",
    fan: "Alexa.PercentageController",
    vacuum: "Alexa.PowerController",
    sensor: "Alexa.TemperatureSensor",
  },
  google: {
    onoff: "action.devices.traits.OnOff",
    brightness: "action.devices.traits.Brightness",
    color: "action.devices.traits.ColorSetting",
    temperature: "action.devices.traits.TemperatureSetting",
    position: "action.devices.traits.OpenClose",
    media: "action.devices.traits.MediaState",
    lock: "action.devices.traits.LockUnlock",
    fan: "action.devices.traits.FanSpeed",
    vacuum: "action.devices.traits.StartStop",
    sensor: "action.devices.traits.TemperatureControl",
  },
  homekit: {
    onoff: "Switch",
    brightness: "Lightbulb",
    color: "Lightbulb",
    temperature: "Thermostat",
    position: "WindowCovering",
    media: "Television",
    lock: "LockMechanism",
    fan: "Fanv2",
    vacuum: "Switch",
    sensor: "TemperatureSensor",
  },
  siri: {
    // Siri rides HomeKit's vocabulary.
    onoff: "Switch",
    brightness: "Lightbulb",
    color: "Lightbulb",
    temperature: "Thermostat",
    position: "WindowCovering",
    media: "Television",
    lock: "LockMechanism",
    fan: "Fanv2",
    vacuum: "Switch",
    sensor: "TemperatureSensor",
  },
};

export interface SupremeDeviceView {
  deviceId: string;
  name: string;
  capabilities: Capability[];
}

export interface DiscoveryEndpoint {
  id: string;
  name: string;
  descriptors: string[];
}

/** A Supreme command the Tunnel Broker forwards to the hub for local execution. */
export interface SupremeCommand {
  deviceId: string;
  capability: Capability;
  value: unknown;
}

export class VoiceService {
  private readonly store: IVoiceLinkStore;
  private readonly now: () => number;

  constructor(opts: { store?: IVoiceLinkStore; now?: () => number } = {}) {
    this.store = opts.store ?? new InMemoryVoiceLinkStore();
    this.now = opts.now ?? (() => Date.now());
  }

  link(input: { assistant: Assistant; externalUserRef: string; accountId: string; homeId: string; scopes?: string[] }): VoiceLink {
    const link: VoiceLink = { ...input, scopes: input.scopes ?? ["control"], linkedAt: this.now() };
    this.store.put(link);
    return link;
  }

  resolve(assistant: Assistant, externalUserRef: string): VoiceLink | undefined {
    return this.store.get(assistant, externalUserRef);
  }

  unlink(assistant: Assistant, externalUserRef: string): void {
    this.store.delete(assistant, externalUserRef);
  }

  /** Project a device into an assistant's discovery vocabulary (drops unsupported caps). */
  discovery(assistant: Assistant, device: SupremeDeviceView): DiscoveryEndpoint {
    const vocab = VOCAB[assistant];
    const descriptors = device.capabilities.map((c) => vocab[c]).filter((d): d is string => Boolean(d));
    return { id: device.deviceId, name: device.name, descriptors: [...new Set(descriptors)] };
  }

  /**
   * Normalize an assistant directive into a Supreme capability command. Directives arrive in a
   * small canonical shape (the per-assistant webhook handlers translate into this first).
   */
  directiveToCommand(input: { deviceId: string; intent: string; arg?: unknown }): SupremeCommand {
    switch (input.intent) {
      case "TurnOn":
        return { deviceId: input.deviceId, capability: "onoff", value: true };
      case "TurnOff":
        return { deviceId: input.deviceId, capability: "onoff", value: false };
      case "SetBrightness":
        return { deviceId: input.deviceId, capability: "brightness", value: clampPct(input.arg) };
      case "SetColor":
        return { deviceId: input.deviceId, capability: "color", value: input.arg };
      case "SetTemperature":
        return { deviceId: input.deviceId, capability: "temperature", value: Number(input.arg) };
      case "SetPosition":
        return { deviceId: input.deviceId, capability: "position", value: clampPct(input.arg) };
      case "Lock":
        return { deviceId: input.deviceId, capability: "lock", value: true };
      case "Unlock":
        return { deviceId: input.deviceId, capability: "lock", value: false };
      default:
        throw new Error(`unsupported directive: ${input.intent}`);
    }
  }

  /** Project a hub state change into an assistant report payload (Alexa/Google/HomeKit shapes). */
  stateToReport(assistant: Assistant, state: { deviceId: string; capability: Capability; value: unknown }): {
    assistant: Assistant;
    endpointId: string;
    descriptor: string;
    value: unknown;
  } {
    const descriptor = VOCAB[assistant][state.capability] ?? "Unknown";
    return { assistant, endpointId: state.deviceId, descriptor, value: state.value };
  }
}

function clampPct(v: unknown): number {
  return Math.max(0, Math.min(100, Math.round(Number(v))));
}

// HTTP surface, OAuth2 IdP, assistant payload mappings, and hub routing (the certification layer).
export { OAuthProvider, OAuthError, type LinkIdentity, type LinkRecord, type OAuthClient } from "./oauth.js";
export {
  toHubCommand,
  BrokerHubRouter,
  HubUnavailableError,
  type HubRouter,
  type HubDevice,
  type HubCommand,
  type CanonicalIntent,
} from "./hub-router.js";
export { buildVoiceServer, type VoiceServerOptions } from "./server.js";
export {
  dispatchStateDelta,
  buildAlexaChangeReport,
  buildGoogleReportState,
  LoggingNotifier,
  type AssistantNotifier,
  type AssistantReport,
  type StateDelta,
} from "./reporting.js";
export {
  HttpAssistantNotifier,
  type HttpAssistantNotifierOptions,
  type AlexaNotifierConfig,
  type GoogleNotifierConfig,
} from "./notifier.js";
export * as alexa from "./alexa.js";
export * as google from "./google.js";
