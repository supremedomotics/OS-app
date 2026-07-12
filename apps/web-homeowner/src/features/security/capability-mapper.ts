import type { Device } from "@supreme/domain-model";
import type { IconName } from "@supreme/aureon-web";

/**
 * The Security module's capability mapper (§ Premium Device Experience Library — Capability
 * Mapping). Door Lock and Furniture Lock are both the same real backend concept — a device
 * with a `lock` capability (`packages/domain-model/src/capabilities.ts`) — there is no
 * protocol signal that tells them apart (unlike Media's AVR/Apple TV), so the only honest
 * distinction is an explicit installer classification (`device.metadata.security.kind`), the
 * same pattern climate-console.tsx and the Media module already use. Furniture Lock is never
 * guessed; an unclassified lock device defaults to the far more common "door lock".
 *
 * SIP Video Door Phone shares the same `lock` capability (a real SIP door station releases
 * the door latch — see `services/protocols/src/sip-driver.ts`) plus, when the driver reports
 * ring events, a `sensor` capability. Unlike Furniture Lock, this DOES have a real driver
 * signal: `driverProtocol === "sip"`.
 */
export type SecurityLockKind = "door_lock" | "furniture_lock" | "sip_door_phone";

export interface SecurityLockKindMeta {
  kind: SecurityLockKind;
  label: string;
  /** A plain-text glyph — the ONLY context this is for is a native `<select><option>`, which
   * cannot render SVG. Every other surface (hero, badges, cards) uses {@link iconName}. */
  icon: string;
  /** The premium SVG icon (§ Design Polish — "replace every emoji with proper SVG
   * illustrations") for the hero plate, badges, and cards. */
  iconName: IconName;
}

const KIND_META: Record<SecurityLockKind, SecurityLockKindMeta> = {
  door_lock: { kind: "door_lock", label: "Door Lock", icon: "🔒", iconName: "lock-locked" },
  furniture_lock: { kind: "furniture_lock", label: "Furniture Lock", icon: "🗄️", iconName: "cabinet" },
  sip_door_phone: { kind: "sip_door_phone", label: "Video Door Phone", icon: "🔔", iconName: "notifications" },
};

function isSecurityLockKind(v: unknown): v is SecurityLockKind {
  return typeof v === "string" && v in KIND_META;
}

/** Resolve a lock-capable device's premium presentation. `driverProtocol` is optional — pass
 * it when available (e.g. from a driver-registry lookup) so a real SIP door station is
 * recognized without needing an installer override; omit it and the installer override is
 * still respected, just with a plain "door lock" fallback. */
export function securityLockKind(device: Device, driverProtocol?: string | null): SecurityLockKind {
  const override = (device.metadata as { security?: { kind?: unknown } } | undefined)?.security?.kind;
  if (isSecurityLockKind(override)) return override;
  if (driverProtocol === "sip") return "sip_door_phone";
  return "door_lock";
}

export function securityLockKindMeta(kind: SecurityLockKind): SecurityLockKindMeta {
  return KIND_META[kind];
}

/** Every classification an installer can set, for a "Device type" picker. */
export const SECURITY_LOCK_KIND_OPTIONS: SecurityLockKindMeta[] = [
  KIND_META.door_lock,
  KIND_META.furniture_lock,
  KIND_META.sip_door_phone,
];
