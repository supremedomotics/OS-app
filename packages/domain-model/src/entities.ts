import { z } from "zod";
import { CapabilityKind, CapabilityState } from "./capabilities.js";
import {
  DeviceId,
  DriverId,
  HomeId,
  RoomId,
  SceneId,
  UserId,
} from "./ids.js";

/**
 * The canonical Supreme entities. These are decoupled from any backend: a
 * `Device` here is a Supreme device with Supreme capabilities, never an HA entity.
 * The bridge to HA (`ha_entity_map`) lives exclusively inside the SIL — see §5/§7.
 */

// ── Home & rooms ─────────────────────────────────────────────────────────────

export const Home = z.object({
  id: HomeId,
  name: z.string().min(1),
  address: z.string().nullable(),
  tier: z.enum(["essential", "signature", "estate"]).default("signature"),
  masterUserId: UserId,
  createdAt: z.string().datetime(),
});
export type Home = z.infer<typeof Home>;

export const AreaType = z.enum([
  "living",
  "bedroom",
  "kitchen",
  "bathroom",
  "office",
  "outdoor",
  "utility",
  "hallway",
  "other",
]);
export type AreaType = z.infer<typeof AreaType>;

export const Room = z.object({
  id: RoomId,
  homeId: HomeId,
  name: z.string().min(1),
  floor: z.number().int().default(0),
  areaType: AreaType.default("other"),
  sortOrder: z.number().int().default(0),
  icon: z.string().nullable(),
  /**
   * Photographic room hero used by the Aureon room-first UI (§11). Either an absolute URL or a
   * hub-relative path (e.g. `/v1/rooms/:id/hero-image`) when the hub has downloaded and stored the
   * photo locally — clients resolve a relative value against the active hub base URL.
   */
  heroImageUrl: z.string().min(1).nullable(),
  parentRoomId: RoomId.nullable(),
});
export type Room = z.infer<typeof Room>;

// ── Devices ──────────────────────────────────────────────────────────────────

export const SupremeDeviceType = z.enum([
  "light",
  "dimmer",
  "color_light",
  "thermostat",
  "cover",
  "media_player",
  "lock",
  "switch",
  "fan",
  "vacuum",
  "sensor",
  "camera",
]);
export type SupremeDeviceType = z.infer<typeof SupremeDeviceType>;

export const DeviceStatus = z.enum(["online", "offline", "unavailable"]);
export type DeviceStatus = z.infer<typeof DeviceStatus>;

export const DeviceCapability = z.object({
  kind: CapabilityKind,
  /** Capability-specific configuration (e.g. min/max kelvin for a color light). */
  config: z.record(z.unknown()).default({}),
});
export type DeviceCapability = z.infer<typeof DeviceCapability>;

export const Device = z.object({
  id: DeviceId,
  homeId: HomeId,
  roomId: RoomId.nullable(),
  name: z.string().min(1),
  supremeType: SupremeDeviceType,
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  driverId: DriverId.nullable(),
  status: DeviceStatus.default("online"),
  /** Controllable capabilities. Cameras are the legitimate 0-capability case
   * (view-only); commissioning still requires ≥1 for controllable devices. */
  capabilities: z.array(DeviceCapability),
  /** Last known normalized state per capability, keyed by capability kind. */
  state: z.record(CapabilityState).default({}),
  metadata: z.record(z.unknown()).default({}),
});
export type Device = z.infer<typeof Device>;

// ── Scenes & automations (definitions are Supreme-owned; §10) ────────────────

export const SceneStep = z.object({
  deviceId: DeviceId,
  capability: CapabilityKind,
  /** Target state values applied when the scene activates. */
  values: z.record(z.unknown()),
});
export type SceneStep = z.infer<typeof SceneStep>;

export const Scene = z.object({
  id: SceneId,
  homeId: HomeId,
  name: z.string().min(1),
  scope: z.enum(["room", "home"]).default("room"),
  roomId: RoomId.nullable(),
  ownerUserId: UserId.nullable(),
  icon: z.string().nullable(),
  aiGenerated: z.boolean().default(false),
  steps: z.array(SceneStep),
});
export type Scene = z.infer<typeof Scene>;

// Automations live in their own module (./automations-dsl.ts) — a typed,
// engine-agnostic DSL. Re-exported from the package index alongside these entities.
