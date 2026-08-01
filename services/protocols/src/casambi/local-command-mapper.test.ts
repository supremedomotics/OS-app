import { describe, expect, it } from "vitest";
import { localCommandToUdpPacket } from "./local-command-mapper.js";
import { CASAMBI_TARGET_TYPE, encodeCasambiPacket } from "./local-transport/udp-codec.js";

describe("localCommandToUdpPacket", () => {
  it("onoff 'on' targets the device with level 255", () => {
    const packet = localCommandToUdpPacket(0, 5, { capability: "onoff", action: "on" }, null);
    expect(packet).toEqual({ netId: 0, direction: "toCasambi", opcode: 0x20, args: [255, CASAMBI_TARGET_TYPE.device, 5] });
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

  it("position is deliberately unmapped — no documented shade/cover opcode exists", () => {
    expect(localCommandToUdpPacket(0, 5, { capability: "position", action: "open" }, null)).toBeNull();
  });

  it("produces byte-exact wire text via the shared frame codec", () => {
    const packet = localCommandToUdpPacket(0, 5, { capability: "onoff", action: "on" }, null)!;
    expect(encodeCasambiPacket(packet, "hex-dot")).toBe("0.72.4.20.ff.1.5\r\n");
  });
});
