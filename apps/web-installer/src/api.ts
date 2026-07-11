import { MemoryTokenStore, SupremeClient } from "@supreme/sdk";

/**
 * The single Supreme API client for the Installer Portal. The portal binds to the
 * Supreme contract only — it has no concept of Home Assistant. The hub base URL is
 * resolved from the environment (LAN-direct in the field; cloud relay when remote).
 */
const baseUrl = import.meta.env.VITE_SUPREME_API_URL ?? "http://127.0.0.1:8080";

// The SDK refreshes an expired access token silently and retries — a long commissioning session no
// longer breaks at the 15-minute access-token TTL. This only fires when the refresh token itself is
// dead (revoked / expired), i.e. the session is genuinely over.
const sessionExpiredListeners = new Set<() => void>();
export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export const client = new SupremeClient({
  baseUrl,
  tokenStore: new MemoryTokenStore(),
  onSessionExpired: () => { for (const l of sessionExpiredListeners) l(); },
});

export interface KnxImportResult {
  devices: number;
  roomsCreated: number;
  created: { name: string; room: string | null; capabilities: string[] }[];
}

export interface KnxImportBinding {
  capability: string;
  address: string;
  statusAddress: string | null;
  role: string;
  dpt: string | null;
}

/** The fine-grained device taxonomy the KNX Import Engine classifies against — see
 * services/commissioning/src/knx/types.ts `KNX_DEVICE_TYPES` for the authoritative list. */
export type KnxDeviceType =
  | "light_switch" | "light_dimmable" | "light_tunable_white" | "light_rgb" | "light_rgbw" | "light_rgbww" | "light_color_temp"
  | "curtain" | "blind" | "roller_shutter" | "garage_door"
  | "thermostat" | "hvac_vrf" | "hvac_split_ac" | "hvac_cassette_ac" | "hvac_duct_ac" | "fan_coil" | "fan"
  | "sensor_temperature" | "sensor_humidity" | "sensor_motion" | "sensor_presence" | "sensor_lux" | "sensor_pressure"
  | "sensor_co2" | "sensor_pm25" | "sensor_leak" | "sensor_smoke" | "sensor_door" | "sensor_window"
  | "energy_meter" | "scene" | "audio" | "gate" | "door_lock" | "irrigation" | "pool" | "ventilation" | "custom_device";

export const KNX_DEVICE_TYPE_LABELS: Record<KnxDeviceType, string> = {
  light_switch: "Light — On/Off", light_dimmable: "Light — Dimmable", light_tunable_white: "Light — Tunable White",
  light_rgb: "Light — RGB", light_rgbw: "Light — RGBW", light_rgbww: "Light — RGBWW", light_color_temp: "Light — Colour Temp",
  curtain: "Curtain", blind: "Blind", roller_shutter: "Roller Shutter", garage_door: "Garage Door",
  thermostat: "Thermostat", hvac_vrf: "HVAC — VRF", hvac_split_ac: "HVAC — Split AC", hvac_cassette_ac: "HVAC — Cassette AC",
  hvac_duct_ac: "HVAC — Duct AC", fan_coil: "Fan Coil", fan: "Fan",
  sensor_temperature: "Sensor — Temperature", sensor_humidity: "Sensor — Humidity", sensor_motion: "Sensor — Motion",
  sensor_presence: "Sensor — Presence", sensor_lux: "Sensor — Illuminance", sensor_pressure: "Sensor — Pressure",
  sensor_co2: "Sensor — CO₂", sensor_pm25: "Sensor — PM2.5", sensor_leak: "Sensor — Leak", sensor_smoke: "Sensor — Smoke",
  sensor_door: "Sensor — Door", sensor_window: "Sensor — Window",
  energy_meter: "Energy Meter", scene: "Scene", audio: "Audio", gate: "Gate", door_lock: "Door Lock",
  irrigation: "Irrigation", pool: "Pool", ventilation: "Ventilation", custom_device: "Custom Device",
};

/** A parsed-but-not-yet-saved device the installer reviews before {@link commitKnxImport}. */
export interface KnxPreviewDevice {
  fingerprint: string;
  name: string;
  sourceName: string;
  deviceType: KnxDeviceType;
  supremeType: string;
  room: string | null;
  floor: string | null;
  building: string | null;
  manufacturer: string | null;
  product: string | null;
  bindings: KnxImportBinding[];
  sourceGroupAddressIds: string[];
  sourceDeviceInstanceId: string | null;
  confidence: number;
}

export interface KnxImportWarning {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface KnxImportStats {
  groupAddressCount: number;
  deviceInstanceCount: number;
  recognizedDeviceCount: number;
  roomsFound: number;
  parseMs: number;
}

export interface KnxPreviewResult {
  devices: KnxPreviewDevice[];
  warnings: KnxImportWarning[];
  stats: KnxImportStats;
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${client.accessToken ?? ""}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ message: `${res.status}` }));
    throw new Error((msg as { message?: string }).message ?? "Request failed");
  }
  return res.json() as Promise<T>;
}

/** Import an ETS group-address export (CSV/XML text) → auto-created device cards (§4). */
export const importKnx = (content: string): Promise<KnxImportResult> =>
  postJson("/v1/commissioning/import/knx", { content });

/**
 * Import a `.knxproj` file (base64) → device cards placed in their ETS rooms (§4).
 * `password` is required only for ETS6 password-protected projects (WinZip-AES).
 */
export const importKnxProject = (base64: string, password?: string): Promise<KnxImportResult> =>
  postJson("/v1/commissioning/import/knx", password ? { knxproj: base64, password } : { knxproj: base64 });

/** Parse an ETS export, `.esf`, or `.knxproj` WITHOUT saving anything — runs the full KNX
 * Import Engine (device recognition, automatic room assignment, learned-rename recall)
 * and returns every recognized device plus non-fatal warnings to review before committing. */
export const previewKnx = (content: string): Promise<KnxPreviewResult> =>
  postJson("/v1/commissioning/import/knx/preview", { content });

/** `.knxproj` counterpart of {@link previewKnx}. */
export const previewKnxProject = (base64: string, password?: string): Promise<KnxPreviewResult> =>
  postJson("/v1/commissioning/import/knx/preview", password ? { knxproj: base64, password } : { knxproj: base64 });

/** Save a (possibly installer-edited) preview list — the "Save & Commission" step. */
export const commitKnxImport = (devices: (KnxPreviewDevice & { included?: boolean })[]): Promise<KnxImportResult> =>
  postJson("/v1/commissioning/import/knx/commit", { devices });
