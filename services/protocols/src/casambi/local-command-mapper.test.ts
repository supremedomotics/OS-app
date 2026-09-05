import { describe, expect, it } from "vitest";
import { localCommandToUdpPacket } from "./local-command-mapper.js";
import { CASAMBI_TARGET_TYPE, encodeCasambiPacket } from "./local-transport/udp-codec.js";

describe("localCommandToUdpPacket", () => {
  it("onoff 'on' targets the device with level 255, always emitting the explicit Duration bytes", () => {
    const packet = localCommandToUdpPacket(0, 5, { capability: "onoff", action: "on" }, null);
    // § live-confirmed fix — Duration (0,0) is ALWAYS sent even though 0x20 documents it as
    // optional: a real Lithernet gateway parses this opcode positionally against the doc's own
    // full-length example, so the short form makes it read Target_Type/Target_ID as the duration
    // and fall back to Target_Type 0 / Target_ID 0 — broadcast, lighting the whole network.
    expect(packet).toEqual({ netId: 0, direction: "toCasambi", opcode: 0x20, args: [255, 0, 0, CASAMBI_TARGET_TYPE.device, 5] });
  });

  it("§ live-confirmed fix — every level command carries Target_Type/Target_ID in the last two bytes, never truncated into the Duration slot", () => {
    const cmds = [
      { capability: "onoff", action: "on" },
      { capability: "onoff", action: "off" },
      { capability: "brightness", action: "on" },
      { capability: "brightness", action: "off" },
      { capability: "brightness", action: "set", level: 50 },
    ] as const;
    for (const cmd of cmds) {
      const args = localCommandToUdpPacket(0, 5, cmd, null)!.args;
      expect(args).toHaveLength(5); // Level, Dur_low, Dur_high, Target_Type, Target_ID
      expect(args.slice(-2)).toEqual([CASAMBI_TARGET_TYPE.device, 5]);
    }
  });

  it("onoff 'off' targets the device with level 0", () => {
    const packet = localCommandToUdpPacket(0, 5, { capability: "onoff", action: "off" }, null);
    expect(packet?.args[0]).toBe(0);
  });

  it("onoff 'toggle' (no explicit action) flips the previous on/off state", () => {
    const toOn = localCommandToUdpPacket(0, 5, { capability: "onoff", action: "toggle" }, { kind: "onoff", on: false });
    expect(toOn?.args[0]).toBe(255);
    const toOff = localCommandToUdpPacket(0, 5, { capability: "onoff", action: "toggle" }, { kind: "onoff", on: true });
    expect(toOff?.args[0]).toBe(0);
  });

  it("brightness 'set' scales a 0-100 level to 0-255", () => {
    const packet = localCommandToUdpPacket(0, 5, { capability: "brightness", action: "set", level: 50 }, null);
    expect(packet?.args[0]).toBe(128); // round(50/100*255)
  });

  it("brightness 'on'/'off' map to full/zero level", () => {
    expect(localCommandToUdpPacket(0, 5, { capability: "brightness", action: "on" }, null)?.args[0]).toBe(255);
    expect(localCommandToUdpPacket(0, 5, { capability: "brightness", action: "off" }, null)?.args[0]).toBe(0);
  });

  it("color kelvin maps directly to opcode 0x48 with real Kelvin (no normalization ambiguity on SET)", () => {
    const packet = localCommandToUdpPacket(0, 5, { capability: "color", kelvin: 3000 }, null, 0);
    expect(packet?.opcode).toBe(0x48);
    // Tc is 2 bytes little-endian per p.309/p.310 ("0x400-0x4000: Value in Kelvin").
    expect(packet?.args[0]).toBe(3000 & 0xff);
    expect(packet?.args[1]).toBe((3000 >> 8) & 0xff);
  });

  it("color hue/saturation maps to opcode 0x3D with degree/percent scaling", () => {
    const packet = localCommandToUdpPacket(0, 5, { capability: "color", hue: 180, saturation: 50 }, null);
    expect(packet?.opcode).toBe(0x3d);
    const [hueHigh, hueLow] = [packet!.args[0], packet!.args[1]];
    expect((hueHigh << 8) | hueLow).toBe(Math.round((180 / 360) * 65535));
    expect(packet?.args[2]).toBe(Math.round((50 / 100) * 254));
  });

  it("color with neither kelvin nor hue/saturation is unsupported", () => {
    expect(localCommandToUdpPacket(0, 5, { capability: "color" }, null)).toBeNull();
  });

  describe("position (§ live-confirmed against a real Casambi curtain motor)", () => {
    // Element index 1 is the POSITION SLIDER, and a slider element's value is the position itself
    // on a 0-255 scale — live-confirmed: writing value 1 parked the curtain at 0.4% (1/255).
    const args = (action: "open" | "close" | "set", position?: number) =>
      localCommandToUdpPacket(0, 5, { capability: "position", action, ...(position === undefined ? {} : { position }) }, null)!.args;

    it("open drives the slider to full travel (255), not a flag value", () => {
      expect(args("open")).toEqual([CASAMBI_TARGET_TYPE.device, 5, 0, 0, 1, 255]);
    });

    it("close drives the slider to zero", () => {
      expect(args("close")).toEqual([CASAMBI_TARGET_TYPE.device, 5, 0, 0, 1, 0]);
    });

    it("set scales a 0-100 position onto the same 0-255 slider element", () => {
      expect(args("set", 50)).toEqual([CASAMBI_TARGET_TYPE.device, 5, 0, 0, 1, 128]); // round(.5*255)
      expect(args("set", 53.3)).toEqual([CASAMBI_TARGET_TYPE.device, 5, 0, 0, 1, 136]); // the app's own 53.3% → 136
    });

    it("clamps an out-of-range position rather than emitting a byte that would wrap", () => {
      expect(args("set", 140)).toEqual([CASAMBI_TARGET_TYPE.device, 5, 0, 0, 1, 255]);
      expect(args("set", -20)).toEqual([CASAMBI_TARGET_TYPE.device, 5, 0, 0, 1, 0]);
    });

    it("uses opcode 0x3F SetTargetElements", () => {
      expect(localCommandToUdpPacket(0, 5, { capability: "position", action: "open" }, null)!.opcode).toBe(0x3f);
    });

    it("stop stays unmapped — no documented element for it, never fabricated", () => {
      expect(localCommandToUdpPacket(0, 5, { capability: "position", action: "stop" }, null)).toBeNull();
    });
  });

  it("produces byte-exact wire text via the shared frame codec — the doc's own full-length 0x20 shape", () => {
    const packet = localCommandToUdpPacket(0, 5, { capability: "onoff", action: "on" }, null)!;
    // Length 6 (opcode + 5 args), matching the manual's worked example `0.72.6.20.ff.10.0.0.0`.
    expect(encodeCasambiPacket(packet, "hex-dot")).toBe("0.72.6.20.ff.0.0.1.5\r\n");
  });
});
