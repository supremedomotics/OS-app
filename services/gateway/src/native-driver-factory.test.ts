import { describe, expect, it } from "vitest";
import { buildNativeDriver, hasNativeFactory } from "./native-driver-factory.js";

/**
 * The manifest↔runtime bridge for the Universal AVR Framework extensions (§ ADR 0015).
 * Installing + enabling "Supreme AVR"/"Supreme HEOS"/"Supreme Yamaha" from the
 * Extension Center has nothing to configure (each has an empty configSchema — real
 * per-device host/zone/pid comes later via Bus Binding), so the factory must always
 * succeed rather than requiring a global host/credentials like KNX/MQTT/Modbus.
 */
describe("native-driver-factory — AVR/HEOS/Yamaha", () => {
  it("reports factories for avr/heos/yamaha", () => {
    expect(hasNativeFactory("avr")).toBe(true);
    expect(hasNativeFactory("heos")).toBe(true);
    expect(hasNativeFactory("yamaha")).toBe(true);
  });

  it("builds a live driver instance from an empty config (nothing global to configure)", () => {
    const avr = buildNativeDriver("avr", {});
    const heos = buildNativeDriver("heos", {});
    const yamaha = buildNativeDriver("yamaha", {});
    expect(avr?.protocol).toBe("avr");
    expect(heos?.protocol).toBe("heos");
    expect(yamaha?.protocol).toBe("yamaha");
  });

  it("returns null for an unknown protocol", () => {
    expect(buildNativeDriver("not-a-real-protocol", {})).toBeNull();
  });
});
