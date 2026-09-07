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
/** A Universal Keypad Framework input→action mapping (§ Universal Keypad Framework). */
export const KeypadMappingId = idPattern("kpm").brand<"KeypadMappingId">();
/** A Universal Keypad Framework feedback subscription (§ Universal Keypad Framework). */
export const KeypadSubscriptionId = idPattern("kps").brand<"KeypadSubscriptionId">();

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
export type KeypadMappingId = z.infer<typeof KeypadMappingId>;
export type KeypadSubscriptionId = z.infer<typeof KeypadSubscriptionId>;

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
  keypadMapping: "kpm",
  keypadSubscription: "kps",
} as const;

export type IdKind = keyof typeof PREFIXES;

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** Per-process monotonic state for {@link newId} — see that function's doc comment for why this
 * exists. Keyed by nothing (one clock for every id kind, matching the ULID spec's own monotonic
 * factory, which shares one counter across all ids from one generator instance). */
let lastTs = -1;
let lastRand: number[] | null = null;

/**
 * Generate a prefixed, ULID-style identifier. The leading 48 bits encode the timestamp so IDs
 * sort roughly by creation time — convenient for cursor pagination and time-ordered audit logs,
 * and load-bearing for `DriverManager`'s multi-instance ordering (§ Multi-network Casambi,
 * Stage 2a/2b), which determines which installed instance is "primary" by earliest creation.
 *
 * Genuinely monotonic within the SAME millisecond, not merely "sorts roughly right": two ids
 * minted in the same `now` tick within this process increment the random suffix by 1 instead of
 * drawing fresh randomness, so `id2 > id1` is guaranteed whenever `id2` was minted after `id1` —
 * never a coin flip on their independently-random suffixes. Found by Stage 2b's own review: a
 * driver-instance ordering test failed intermittently because two instances created back-to-back
 * in a fast test legitimately shared one millisecond, and plain per-call randomness gives no
 * guarantee about their relative order in that case. Monotonicity resets on the next millisecond
 * (`now` advances), and is per-process only — this hub is a single process, so that's sufficient;
 * it makes no claim across machines or restarts, which no ULID scheme does.
 */
export function newId(kind: IdKind, now: number = Date.now()): string {
  let ts = now;
  const timeChars: string[] = [];
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(ULID_ALPHABET[ts % 32]!);
    ts = Math.floor(ts / 32);
  }
  let randDigits: number[];
  if (now === lastTs && lastRand) {
    randDigits = [...lastRand];
    for (let i = randDigits.length - 1; i >= 0; i--) {
      randDigits[i] = (randDigits[i]! + 1) % 32;
      if (randDigits[i] !== 0) break; // no carry needed
      // carried past 31 -> continues into the next (more significant) digit; on the vanishingly
      // unlikely case of overflowing all 16 digits within one millisecond, this wraps to zero
      // rather than throwing — still far more ids than one process mints in a millisecond.
    }
  } else {
    randDigits = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }
  lastTs = now;
  lastRand = randDigits;
  const rand = randDigits.map((d) => ULID_ALPHABET[d]).join("");
  return `${PREFIXES[kind]}_${timeChars.join("")}${rand}`;
}
