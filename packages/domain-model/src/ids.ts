import { z } from "zod";

/**
 * Supreme identifiers.
 *
 * Every resource in the Supreme domain is addressed by a Supreme ID — never by a
 * Home Assistant entity ID. The mapping from a Supreme device to its underlying
 * HA entity lives ONLY inside the Supreme Integration Layer (SIL). Nothing above
 * the SIL is permitted to know that HA exists. See blueprint §2.2 / §7.
 *
 * IDs are opaque, prefixed, ULID-style strings (e.g. `dev_01J9...`). The prefix
 * makes logs and audit trails self-describing and prevents cross-type ID misuse.
 */

const idPattern = (prefix: string) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`),
      `expected a ${prefix}_<ULID> identifier`,
    );

export const HomeId = idPattern("home").brand<"HomeId">();
export const RoomId = idPattern("room").brand<"RoomId">();
export const DeviceId = idPattern("dev").brand<"DeviceId">();
export const SceneId = idPattern("scn").brand<"SceneId">();
export const AutomationId = idPattern("aut").brand<"AutomationId">();
export const UserId = idPattern("usr").brand<"UserId">();
export const SessionId = idPattern("ses").brand<"SessionId">();
export const GrantId = idPattern("grt").brand<"GrantId">();
export const DriverId = idPattern("drv").brand<"DriverId">();
export const NotificationId = idPattern("ntf").brand<"NotificationId">();
export const LicenseId = idPattern("lic").brand<"LicenseId">();
export const BackupId = idPattern("bak").brand<"BackupId">();

export type HomeId = z.infer<typeof HomeId>;
export type RoomId = z.infer<typeof RoomId>;
export type DeviceId = z.infer<typeof DeviceId>;
export type SceneId = z.infer<typeof SceneId>;
export type AutomationId = z.infer<typeof AutomationId>;
export type UserId = z.infer<typeof UserId>;
export type SessionId = z.infer<typeof SessionId>;
export type GrantId = z.infer<typeof GrantId>;
export type DriverId = z.infer<typeof DriverId>;
export type NotificationId = z.infer<typeof NotificationId>;
export type LicenseId = z.infer<typeof LicenseId>;
export type BackupId = z.infer<typeof BackupId>;

const PREFIXES = {
  home: "home",
  room: "room",
  device: "dev",
  scene: "scn",
  automation: "aut",
  user: "usr",
  session: "ses",
  grant: "grt",
  driver: "drv",
  notification: "ntf",
  license: "lic",
  backup: "bak",
  sample: "smp",
  audit: "aud",
  sie: "sie",
} as const;

export type IdKind = keyof typeof PREFIXES;

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/**
 * Generate a prefixed, ULID-style identifier. Monotonic-ish: the leading 48 bits
 * encode the timestamp so IDs sort roughly by creation time, which is convenient
 * for cursor pagination and time-ordered audit logs.
 */
export function newId(kind: IdKind, now: number = Date.now()): string {
  let ts = now;
  const timeChars: string[] = [];
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(ULID_ALPHABET[ts % 32]!);
    ts = Math.floor(ts / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += ULID_ALPHABET[Math.floor(Math.random() * 32)];
  }
  return `${PREFIXES[kind]}_${timeChars.join("")}${rand}`;
}
