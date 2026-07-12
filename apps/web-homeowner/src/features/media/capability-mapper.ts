import type { Device } from "@supreme/domain-model";

/**
 * The Media feature module's capability mapper (§ Premium Device Experience Library —
 * Capability Mapping: render UI from capabilities, never from protocol).
 *
 * Television, Network Speaker, AVR, and Projector are NOT distinct SupremeOS capabilities —
 * there is only one real backend concept behind all four, a device with a `media` capability
 * (`packages/domain-model/src/capabilities.ts`). Nothing in this module invents a capability
 * that doesn't exist; it only decides which of the four premium presentations a real media
 * device gets, from two real signals:
 *
 *  1. An explicit installer classification (`device.metadata.media.kind`) — the same
 *     "installer-entered, not read from the driver" pattern climate-console.tsx already uses
 *     for HVAC brand/unit type. Always wins when present.
 *  2. Failing that, the one real driver-reported signal that actually distinguishes anything:
 *     the "avr" protocol (multi-zone/tone/HDMI-switching receivers — avr-driver.ts) vs.
 *     everything else. There is no real signal that distinguishes a television from a
 *     projector from a generic zone, so unclassified devices default to the more
 *     conservative "speaker" label rather than guessing "television".
 */
export type MediaDeviceKind = "television" | "speaker" | "avr" | "projector";

export interface MediaKindMeta {
  kind: MediaDeviceKind;
  label: string;
  icon: string;
}

const KIND_META: Record<MediaDeviceKind, MediaKindMeta> = {
  television: { kind: "television", label: "Television", icon: "📺" },
  speaker: { kind: "speaker", label: "Speaker", icon: "🔊" },
  avr: { kind: "avr", label: "AVR", icon: "📻" },
  projector: { kind: "projector", label: "Projector", icon: "📽️" },
};

function isMediaDeviceKind(v: unknown): v is MediaDeviceKind {
  return v === "television" || v === "speaker" || v === "avr" || v === "projector";
}

/** Resolve a media-capable device's premium presentation. `driverProtocol` is optional —
 * pass it when available (e.g. from a driver-registry lookup) for the best default; omit it
 * and the installer override is still respected, just with a plain "speaker" fallback. */
export function mediaDeviceKind(device: Device, driverProtocol?: string | null): MediaDeviceKind {
  const override = (device.metadata as { media?: { kind?: unknown } } | undefined)?.media?.kind;
  if (isMediaDeviceKind(override)) return override;
  if (driverProtocol === "avr") return "avr";
  return "speaker";
}

export function mediaKindMeta(kind: MediaDeviceKind): MediaKindMeta {
  return KIND_META[kind];
}

/** Every classification an installer can set, for a "Device type" picker. */
export const MEDIA_KIND_OPTIONS: MediaKindMeta[] = [
  KIND_META.television,
  KIND_META.speaker,
  KIND_META.avr,
  KIND_META.projector,
];
