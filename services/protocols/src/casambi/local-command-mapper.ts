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
 * Every `position` action is mapped (§ live-confirmed against a real curtain motor — see the
 * case itself); `stop` additionally needs a previously observed position, and without one it
 * returns `null`, which surfaces as the driver's existing "unsupported command" error rather
 * than a fabricated mapping.
 */
export function localCommandToUdpPacket(
  netId: number,
  unitId: number,
  command: CapabilityCommand,
  prev: CapabilityState | null,
  fadeMs?: number,
): CasambiPacket | null {
  switch (command.capability) {
    // § live-confirmed fix — `fadeMs ?? 0`, never a bare `fadeMs`, on every 0x20 call below.
    // 0x20's Duration field is *optional* per the doc (omit it and the packet length drops from
    // 6 to 4), but a real Lithernet gateway parses the opcode positionally against the full
    // layout the doc's own worked example uses (`0.72.6.20.ff.10.0.0.0`). Sent short, it reads
    // our Target_Type/Target_ID bytes as Duration_low/Duration_high and finds no target at all —
    // and an absent target is Target_Type 0 / Target_ID 0, i.e. BROADCAST. Live-confirmed on real
    // hardware: `c.72.4.20.ff.1.18` (level, short form) lit every fixture in the network, while
    // `0x48` colour commands — whose Duration is mandatory, so always full-length — targeted the
    // exact same unit correctly. Sending an explicit 0 fade keeps the behaviour identical
    // (instant) and puts the target bytes where the gateway actually looks for them.
    case "onoff": {
      const on = command.action === "on" ? true : command.action === "off" ? false : !(prev?.kind === "onoff" && prev.on);
      return encodeSetTargetLevel(netId, CASAMBI_TARGET_TYPE.device, unitId, on ? 255 : 0, fadeMs ?? 0);
    }
    case "brightness": {
      if (command.action === "off") return encodeSetTargetLevel(netId, CASAMBI_TARGET_TYPE.device, unitId, 0, fadeMs ?? 0);
      if (command.action === "on") return encodeSetTargetLevel(netId, CASAMBI_TARGET_TYPE.device, unitId, 255, fadeMs ?? 0);
      const level = typeof command.level === "number" ? command.level : 100;
      return encodeSetTargetLevel(netId, CASAMBI_TARGET_TYPE.device, unitId, Math.round((level / 100) * 255), fadeMs ?? 0);
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
    case "position": {
      // § live-confirmed on a real Casambi curtain motor — position is the ordinary LEVEL
      // channel (0x20 SetTargetLevel), exactly like a dimmable luminaire, NOT a custom element.
      // Proven on the wire: `c.72.6.20.bf.0.0.1.2d` (level 191 = 75%) drove the curtain to 75%.
      //
      // This supersedes two earlier element-based attempts, both disproved on real hardware:
      // writing 0x3F element 1 only jogged the motor to 0.4%, and writing a scaled position to an
      // on/off element was silently ignored (out of range). The motor's elements 0/1 are its
      // Close/Open buttons — a secondary control surface, not where the position lives.
      // "stop" halts travel by re-commanding the position the fixture is CURRENTLY at, read from
      // the live 0x4B type-15 slider feedback. There is no documented halt opcode — 0x20 only ever
      // commands an absolute target — but re-targeting the present position is the same absolute
      // command the motor is already honouring, so it has no new failure mode. If no position has
      // been observed yet there is nothing honest to send, so it stays an "unsupported command"
      // error rather than a guess at where the curtain is.
      const pct =
        command.action === "open"
          ? 100
          : command.action === "close"
            ? 0
            : command.action === "stop"
              ? prev?.kind === "position" && typeof prev.position === "number"
                ? prev.position
                : null
              : typeof command.position === "number"
                ? command.position
                : null;
      if (pct === null) return null;
      const clamped = Math.min(100, Math.max(0, pct));
      return encodeSetTargetLevel(netId, CASAMBI_TARGET_TYPE.device, unitId, Math.round((clamped / 100) * 255), fadeMs ?? 0);
    }
    default:
      return null;
  }
}
