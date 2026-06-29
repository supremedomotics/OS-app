/**
 * Presence source seam. Presence is NEVER trusted from a single source — every detection method is
 * just a `PresenceSignal` with its own reliability and freshness, and the fuser (./fusion.ts) blends
 * them into one confidence score per user. Today the hub emits wifi_ap / app_heartbeat /
 * local_network; tomorrow's bluetooth, BLE beacons, ESP32 nodes, mmWave, PIR, door sensors, camera
 * AI, phone location, UWB, smart watches, vehicle presence and voice recognition slot in by emitting
 * the same signal shape and (optionally) declaring a weight here — no fuser changes required.
 */

export type PresenceSourceKind =
  // Available now.
  | "wifi_ap"
  | "app_heartbeat"
  | "local_network"
  // Future-ready (architecture supports them today; emitters land later).
  | "bluetooth"
  | "ble_beacon"
  | "esp32_node"
  | "mmwave"
  | "pir"
  | "door_sensor"
  | "camera_ai"
  | "phone_location"
  | "uwb"
  | "smart_watch"
  | "vehicle"
  | "voice";

/**
 * Baseline reliability of each source (0..1), used as its weight in fusion. Precise room-level
 * sensors (UWB, mmWave, camera AI) outrank coarse "somewhere on the LAN" signals. A deployment can
 * override these per-home; absent override, these defaults apply. A source not listed defaults to 0.5.
 */
export const SOURCE_WEIGHTS: Record<PresenceSourceKind, number> = {
  uwb: 1.0,
  mmwave: 0.95,
  camera_ai: 0.9,
  ble_beacon: 0.85,
  voice: 0.85,
  esp32_node: 0.8,
  bluetooth: 0.75,
  smart_watch: 0.7,
  wifi_ap: 0.7,
  phone_location: 0.65,
  app_heartbeat: 0.6,
  pir: 0.6,
  local_network: 0.55,
  vehicle: 0.5,
  door_sensor: 0.4,
};

/** Sources whose emitters exist in the current build; the rest are reserved for future modules. */
export const ACTIVE_SOURCES: readonly PresenceSourceKind[] = ["wifi_ap", "app_heartbeat", "local_network"];

export interface PresenceSignal {
  source: PresenceSourceKind;
  userId: string;
  /**
   * Best room this source places the user in. null = the source knows the user is in the home but
   * not which room (e.g. local_network); undefined/omitted = no room information.
   */
  roomId?: string | null;
  /** Does this source believe the user is present in the home at all? */
  present: boolean;
  /** This source's own certainty in THIS reading, 0..1 (e.g. RSSI strength, match score). */
  strength: number;
  /** Observation time (ms epoch); older signals are decayed and eventually ignored. */
  ts: number;
}

export const sourceWeight = (source: PresenceSourceKind): number => SOURCE_WEIGHTS[source] ?? 0.5;
