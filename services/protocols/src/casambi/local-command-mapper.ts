import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";
import {
  CASAMBI_TARGET_TYPE,
  encodeSetColorHueSat,
  encodeSetColorTemperature,
  encodeSetTargetElements,
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
 * `position` open/close ARE mapped (§ live-confirmed against a real curtain motor — see the case
 * itself); setting a specific position is still deliberately unmapped, because the element index
 * needed to write the slider is not observable from anything the gateway reports. Returning `null`
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
      // § live-confirmed — a real Casambi curtain motor exposes its Open/Close buttons as custom
      // on/off ELEMENTS, captured from the gateway console while driving it from the Casambi app:
      //   close pressed → `4b.2d.90.00.01.01`  (long-form type 0x90 = on/off toggle, INDEX 0)
      //   open  pressed → `4b.2d.90.01.01.01`  (…INDEX 1)
      // so element 0 is Close and element 1 is Open, written back with 0x3F SetTargetElements
      // ([Index, Value] pairs, § System Manual 6.38 §5.12.2.2.18 — which also resolves the older
      // reference's 0x3E/0x3F contradiction in favour of 0x3F, see encodeSetTargetElements).
      if (command.action === "open") return encodeSetTargetElements(netId, CASAMBI_TARGET_TYPE.device, unitId, [{ index: 1, value: 1 }], fadeMs ?? 0);
      if (command.action === "close") return encodeSetTargetElements(netId, CASAMBI_TARGET_TYPE.device, unitId, [{ index: 0, value: 1 }], fadeMs ?? 0);
      // "set" (a specific position) and "stop" stay deliberately unmapped. The motor reports its
      // position as a SHORT-form slider (`0f.<lo>.<hi>`), which carries no element index, and the
      // Casambi app writes it over BLE — so the gateway never observes an index we could copy.
      // Guessing one would be fabricating a wire address; it needs a real on-site probe first.
      return null;
    }
    default:
      return null;
  }
}
