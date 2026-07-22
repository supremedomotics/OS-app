import {
  CapabilityCommand,
  Device,
  Home,
  Room,
  Scene,
  User,
} from "@supreme/domain-model";
import { z } from "zod";

/**
 * REST contract for the Supreme API (`/v1`). Request/response schemas only — no
 * transport details. The TS and Dart SDKs are generated/derived from these so a
 * client can never hand-roll a backend (HA) call (§6).
 *
 * The representative surface mirrors blueprint §6.
 */

export const API_VERSION = "v1" as const;

// ── Auth ─────────────────────────────────────────────────────────────────────

export const LoginRequest = z.object({
  // Username OR email. Accounts set up with a bare username log in with that username; the gateway
  // normalizes a username to its `<username>@supreme.local` identifier. So this is a plain non-empty
  // string, not a strict email (which would reject valid usernames).
  email: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const TokenPair = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Access-token lifetime in seconds. */
  expiresIn: z.number().int().positive(),
  tokenType: z.literal("Bearer"),
});
export type TokenPair = z.infer<typeof TokenPair>;

/** Login may require a second factor before tokens are issued. */
export const LoginResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }).merge(TokenPair),
  z.object({ status: z.literal("mfa_required"), mfaToken: z.string() }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

export const RefreshRequest = z.object({ refreshToken: z.string() });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const MfaVerifyRequest = z.object({
  mfaToken: z.string(),
  code: z.string().regex(/^\d{6}$/),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequest>;

/** TOTP enrollment: the secret + provisioning URL to render as a QR code. */
export const MfaEnrollResponse = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type MfaEnrollResponse = z.infer<typeof MfaEnrollResponse>;

/** A bare 6-digit TOTP code (confirm enrollment / disable MFA). */
export const MfaCodeRequest = z.object({ code: z.string().regex(/^\d{6}$/) });
export type MfaCodeRequest = z.infer<typeof MfaCodeRequest>;

// ── Topology & devices ───────────────────────────────────────────────────────

export const RoomList = z.object({ rooms: z.array(Room) });
export type RoomList = z.infer<typeof RoomList>;

export const DeviceList = z.object({ devices: z.array(Device) });
export type DeviceList = z.infer<typeof DeviceList>;

export const HomeView = z.object({
  home: Home,
  rooms: z.array(Room),
});
export type HomeView = z.infer<typeof HomeView>;

/** The core control verb: POST /v1/devices/{id}/command. */
export const CommandRequest = z.object({ command: CapabilityCommand });
export type CommandRequest = z.infer<typeof CommandRequest>;

/** Move and/or rename a device: PATCH /v1/devices/{id}. At least one field is required.
 * `metadata` is a shallow MERGE into the device's existing metadata bag (e.g. installer-
 * entered fields like an HVAC unit's brand/type, never a driver-reported value) — never a
 * full replace, so unrelated keys another feature stored there survive untouched. */
export const UpdateDeviceRequest = z
  .object({
    name: z.string().min(1).max(120).optional(),
    roomId: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => v.name !== undefined || v.roomId !== undefined || v.metadata !== undefined, {
    message: "provide name, roomId, and/or metadata",
  });
export type UpdateDeviceRequest = z.infer<typeof UpdateDeviceRequest>;

/** Bulk operation over a device selection (§ Device Platform): move to a room, or remove. */
export const BulkDeviceRequest = z.object({
  ids: z.array(z.string()).min(1),
  action: z.enum(["move", "remove"]),
  roomId: z.string().optional(),
});
export type BulkDeviceRequest = z.infer<typeof BulkDeviceRequest>;

export const BulkDeviceResponse = z.object({ affected: z.number().int().nonnegative() });
export type BulkDeviceResponse = z.infer<typeof BulkDeviceResponse>;

export const DeviceResponse = z.object({ device: Device });
export type DeviceResponse = z.infer<typeof DeviceResponse>;

export const CommandResponse = z.object({
  /** Whether the command was accepted by the backend (optimistic clients reconcile via WSS). */
  accepted: z.boolean(),
  device: Device.optional(),
});
export type CommandResponse = z.infer<typeof CommandResponse>;

/** One item in a media device's play queue — GET /v1/devices/:id/media/queue. Only
 * populated for protocols with a real queue concept on the wire (e.g. HEOS); other
 * media devices return an empty list rather than a fabricated one. */
export const MediaQueueItem = z.object({
  id: z.string(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  artworkUrl: z.string().nullable(),
});
export type MediaQueueItem = z.infer<typeof MediaQueueItem>;

export const MediaQueueResponse = z.object({ items: z.array(MediaQueueItem) });
export type MediaQueueResponse = z.infer<typeof MediaQueueResponse>;

/** Real connection/traffic diagnostics from a device's owning driver (§ Diagnostics
 * Console, Universal AV Driver SDK) — GET /v1/devices/:id/diagnostics. `null` when the
 * device isn't bound to a driver that tracks this (e.g. HA-backed, or a protocol with
 * no diagnostics tracker). Every field is either a genuine counter/timestamp or `null`
 * when the owning protocol truly doesn't expose it — never a fabricated placeholder. */
export const DeviceDriverDiagnostics = z.object({
  connectionStatus: z.enum(["connected", "connecting", "disconnected"]),
  protocol: z.string(),
  driverVersion: z.string(),
  model: z.string().nullable(),
  firmware: z.string().nullable(),
  ip: z.string().nullable(),
  mac: z.string().nullable(),
  lastCommand: z.string().nullable(),
  lastCommandAt: z.string().nullable(),
  lastResponse: z.string().nullable(),
  lastResponseAt: z.string().nullable(),
  responseTimeMs: z.number().nullable(),
  packetsSent: z.number().int().nonnegative(),
  packetsReceived: z.number().int().nonnegative(),
  reconnectCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type DeviceDriverDiagnostics = z.infer<typeof DeviceDriverDiagnostics>;

export const DeviceDiagnosticsResponse = z.object({ diagnostics: DeviceDriverDiagnostics.nullable() });
export type DeviceDiagnosticsResponse = z.infer<typeof DeviceDiagnosticsResponse>;

/** POST /v1/devices/:id/capabilities/refresh (§ Capability Refresh) — re-query the
 * owning driver in place (never recreates the device, never touches its room
 * assignment/automations/history) and persist whatever fresh AudioCapabilityConfig it
 * reports. `refreshed: false` is an honest, non-error outcome — some protocols
 * genuinely have no live capability query (e.g. classic Denon/Marantz Telnet), so
 * "nothing new to apply" is the correct, expected result, not a failure. */
export const DeviceCapabilitiesRefreshResponse = z.object({
  refreshed: z.boolean(),
  config: z.record(z.unknown()).nullable(),
  /** The device as it stands after the refresh, so a caller can update its own local
   * copy in one round trip instead of a separate re-fetch. Same object `setCapability
   * Config` already returns at first-commission time — never a re-fetched/re-derived
   * shape. */
  device: Device.nullable(),
});
export type DeviceCapabilitiesRefreshResponse = z.infer<typeof DeviceCapabilitiesRefreshResponse>;

// ── Scenes ───────────────────────────────────────────────────────────────────

export const SceneList = z.object({ scenes: z.array(Scene) });
export type SceneList = z.infer<typeof SceneList>;

// ── Users ────────────────────────────────────────────────────────────────────

export const UserList = z.object({ users: z.array(User) });
export type UserList = z.infer<typeof UserList>;

export const CurrentUser = z.object({ user: User });
export type CurrentUser = z.infer<typeof CurrentUser>;
