import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";
import {
  CASAMBI_TARGET_TYPE,
  encodeSetColorHueSat,
  encodeSetColorTemperature,
  encodeSetTargetLevel,
  type CasambiPacket,
} from "./local-transport/udp-codec.js";

/**
 * Casambi Local Command Mapper (§ Casambi Driver Refactor — PR-2, Local Gateway Foundation).
 * Translates a Supreme `CapabilityCommand` into a real UDP Casambi Command packet — the
 * Local-mode analogue of `entity-mapper.ts`'s `commandToTargetControls` (Cloud's JSON
 * `controlUnit` message body). Kept as a separate function rather than folded into that one:
 * Cloud's shape is a JSON control-value object, Local's is a byte-oriented wire packet — forcing
 * either transport through the other's intermediate representation would buy no real reuse.
 *
 * `position` is deliberately unmapped: no opcode in `Lithernet_UDP_Developer_Reference.pdf`
 * documents a shade/cover position control (0x31 SetTargetVerticalRatio is the direct/indirect
 * light-mix ratio of a luminaire, not a physical blind/shade position) — returning `null` here
 * surfaces as the driver's existing "unsupported command" error rather than a fabricated mapping.
 */
export function localCommandToUdpPacket(
  netId: number,
  unitId: number,
  command: CapabilityCommand,
  prev: CapabilityState | null,
  fadeMs?: number,
): CasambiPacket | null {
  switch (command.capability) {
    case "onoff": {
      const on = command.action === "on" ? true : command.action === "off" ? false : !(prev?.kind === "onoff" && prev.on);
      return encodeSetTargetLevel(netId, CASAMBI_TARGET_TYPE.device, unitId, on ? 255 : 0, fadeMs);
    }
    case "brightness": {
      if (command.action === "off") return encodeSetTargetLevel(netId, CASAMBI_TARGET_TYPE.device, unitId, 0, fadeMs);
      if (command.action === "on") return encodeSetTargetLevel(netId, CASAMBI_TARGET_TYPE.device, unitId, 255, fadeMs);
      const level = typeof command.level === "number" ? command.level : 100;
      return encodeSetTargetLevel(netId, CASAMBI_TARGET_TYPE.device, unitId, Math.round((level / 100) * 255), fadeMs);
    }
    case "color": {
      // 0x48's Tc field is real Kelvin in the 0x400-0x4000 range (1024K-16384K, p.310), which
      // fully covers ordinary lighting CCT (2700K-6500K) — no normalization ambiguity on SET,
      // unlike the NotifyControlValues *read-back* byte (see `local-discovery.ts`'s doc comment).
      if (typeof command.kelvin === "number") {
        return encodeSetColorTemperature(netId, CASAMBI_TARGET_TYPE.device, unitId, Math.round(command.kelvin), fadeMs ?? 0);
      }
      if (typeof command.hue === "number" || typeof command.saturation === "number") {
        const prevColor = prev?.kind === "color" ? prev : null;
        const hueDeg = typeof command.hue === "number" ? command.hue : prevColor?.hue ?? 0;
        const satPct = typeof command.saturation === "number" ? command.saturation : prevColor?.saturation ?? 100;
        const hue16 = Math.round(((hueDeg ?? 0) / 360) * 65535);
        const sat254 = Math.round(((satPct ?? 0) / 100) * 254);
        const level = typeof command.level === "number" ? Math.round((command.level / 100) * 254) : undefined;
        return encodeSetColorHueSat(netId, CASAMBI_TARGET_TYPE.device, unitId, { hue: hue16, sat: sat254, level });
      }
      return null;
    }
    default:
      return null;
  }
}
