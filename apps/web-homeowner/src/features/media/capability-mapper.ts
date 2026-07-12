import type { Device } from "@supreme/domain-model";

/**
 * The Media module's capability mapper (§ Premium Device Experience Library — Capability
 * Mapping: render UI from capabilities, never from protocol). Television, Projector, AVR,
 * Network Speaker, Media Player, Apple TV, and Nvidia Shield are NOT distinct SupremeOS
 * capabilities — there is only one real backend concept behind all seven, a device with a
 * `media` capability (`packages/domain-model/src/capabilities.ts`). Nothing here invents a
 * capability that doesn't exist; it only decides which premium presentation a real media
 * device gets, from two real signals:
 *
 *  1. An explicit installer classification (`device.metadata.media.kind`) — the same
 *     "installer-entered, not read from the driver" pattern climate-console.tsx already uses
 *     for HVAC brand/unit type. Always wins when present.
 *  2. Failing that, the driver-reported protocol, for the two ecosystems that actually have
 *     one: "avr" (multi-zone/tone/HDMI-switching receivers — avr-driver.ts) and "appletv"
 *     (apple-tv-driver.ts). Nothing else has a real distinguishing signal, so an unclassified
 *     device on any other protocol defaults to the conservative "speaker" label rather than
 *     guessing "television" or "nvidia_shield" with nothing behind it.
 */
export type MediaDeviceKind = "television" | "projector" | "avr" | "speaker" | "media_player" | "apple_tv" | "nvidia_shield";

export interface MediaKindMeta {
  kind: MediaDeviceKind;
  label: string;
  icon: string;
}

const KIND_META: Record<MediaDeviceKind, MediaKindMeta> = {
  television: { kind: "television", label: "Television", icon: "📺" },
  projector: { kind: "projector", label: "Projector", icon: "📽️" },
  avr: { kind: "avr", label: "AVR", icon: "📻" },
  speaker: { kind: "speaker", label: "Speaker", icon: "🔊" },
  media_player: { kind: "media_player", label: "Media Player", icon: "▶️" },
  apple_tv: { kind: "apple_tv", label: "Apple TV", icon: "🍎" },
  nvidia_shield: { kind: "nvidia_shield", label: "Nvidia Shield", icon: "🎮" },
};

function isMediaDeviceKind(v: unknown): v is MediaDeviceKind {
  return typeof v === "string" && v in KIND_META;
}

/** Resolve a media-capable device's premium presentation. `driverProtocol` is optional —
 * pass it when available (e.g. from a driver-registry lookup) for the best default; omit it
 * and the installer override is still respected, just with a plain "speaker" fallback. */
export function mediaDeviceKind(device: Device, driverProtocol?: string | null): MediaDeviceKind {
  const override = (device.metadata as { media?: { kind?: unknown } } | undefined)?.media?.kind;
  if (isMediaDeviceKind(override)) return override;
  if (driverProtocol === "avr") return "avr";
  if (driverProtocol === "appletv") return "apple_tv";
  return "speaker";
}

export function mediaKindMeta(kind: MediaDeviceKind): MediaKindMeta {
  return KIND_META[kind];
}

/** Television and Projector get the Media module's "simple consumer device" premium page
 * (Power/Volume/Source plus a set of capability-gated placeholder controls) rather than the
 * AVR console's multi-zone receiver UI, which is the wrong shape for either — a TV or
 * projector has no zones, no tone controls, no listening-mode DSP. */
export function usesSimpleMediaDetail(kind: MediaDeviceKind): boolean {
  return kind === "television" || kind === "projector";
}

/** Every classification an installer can set, for a "Device type" picker. */
export const MEDIA_KIND_OPTIONS: MediaKindMeta[] = [
  KIND_META.television,
  KIND_META.projector,
  KIND_META.avr,
  KIND_META.speaker,
  KIND_META.media_player,
  KIND_META.apple_tv,
  KIND_META.nvidia_shield,
];
