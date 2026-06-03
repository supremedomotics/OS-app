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
  email: z.string().email(),
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

export const CommandResponse = z.object({
  /** Whether the command was accepted by the backend (optimistic clients reconcile via WSS). */
  accepted: z.boolean(),
  device: Device.optional(),
});
export type CommandResponse = z.infer<typeof CommandResponse>;

// ── Scenes ───────────────────────────────────────────────────────────────────

export const SceneList = z.object({ scenes: z.array(Scene) });
export type SceneList = z.infer<typeof SceneList>;

// ── Users ────────────────────────────────────────────────────────────────────

export const UserList = z.object({ users: z.array(User) });
export type UserList = z.infer<typeof UserList>;

export const CurrentUser = z.object({ user: User });
export type CurrentUser = z.infer<typeof CurrentUser>;
