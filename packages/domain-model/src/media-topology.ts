import { z } from "zod";
import { DeviceId } from "./ids.js";

/**
 * Media Topology Engine (§ Universal AV Driver SDK) — the installer-declared graph of
 * what's physically connected to an AVR/AV processor's own inputs/outputs/zones:
 *
 *   Living Room AVR
 *   ├── HDMI1 → Apple TV
 *   ├── HDMI2 → PlayStation 5
 *   ├── HDMI3 → Blu-ray
 *   ├── HDMI OUT → Sony Projector
 *   └── Zone2 → Conference Speakers
 *
 * No AVR protocol in this fleet (Denon/Marantz Telnet, HEOS, Yamaha YXC — verified
 * against all three specs in ADR 0015) reports what's physically plugged into a given
 * HDMI port; a receiver's `SI`/`input_list` table names the CONNECTOR ("HDMI1"), never
 * the device on the other end of the cable. This is real-world cabling, not a
 * wire-discoverable fact — the graph is therefore always installer-declared, exactly
 * like Denon's Zone 2/tone-control config in `avr-capabilities.ts`. Never guessed,
 * never inferred from a heuristic.
 *
 * Storage: `device.metadata.avrTopology` (the existing free-form, installer-entered
 * `device.metadata` field — no persistence/migration change needed, same pattern as
 * `metadata.climate.kind`/`metadata.media.kind`). This schema exists purely for shared
 * compile-time typing + one runtime `parse()` call on read, so a malformed/legacy
 * metadata blob degrades to an empty topology rather than crashing the UI.
 */

export const MediaTopologyConnection = z.object({
  /** The AVR's own connector/zone id this entry describes — an `AvrInput.id` from the
   * device's `AudioCapabilityConfig` when one exists ("MPLAY", "hdmi1"), a zone id
   * ("zone2"), or a free installer-typed id when the device has no capability config
   * to pick from (e.g. "hdmiOut" — no AVR protocol here models a physical OUTPUT
   * connector, only inputs, so an installer names it directly). */
  output: z.string().min(1),
  /** Display label for `output`, e.g. "HDMI 1", "HDMI OUT", "Zone 2". */
  label: z.string().min(1),
  /** A real Supreme device on the other end of this connection, when one exists and is
   * commissioned (e.g. a Sony Projector that's itself a Supreme device). */
  connectedDeviceId: DeviceId.optional(),
  /** Free-text description of what's connected, always shown alongside/instead of
   * `connectedDeviceId` — most real sources (a PS5, a Blu-ray player) are never
   * Supreme devices at all, so this is the primary field, not a fallback. */
  connectedLabel: z.string().min(1),
});
export type MediaTopologyConnection = z.infer<typeof MediaTopologyConnection>;

export const MediaTopology = z.object({
  connections: z.array(MediaTopologyConnection).default([]),
});
export type MediaTopology = z.infer<typeof MediaTopology>;

const EMPTY_TOPOLOGY: MediaTopology = { connections: [] };

/** Parse `device.metadata.avrTopology` defensively — malformed or absent data becomes
 * an empty topology (never thrown, never a fabricated connection). */
export function parseMediaTopology(raw: unknown): MediaTopology {
  const result = MediaTopology.safeParse(raw);
  return result.success ? result.data : EMPTY_TOPOLOGY;
}
