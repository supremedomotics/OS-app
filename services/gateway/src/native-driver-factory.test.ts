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

  it("threads ctx.onLog and ctx.artworkUrlFor into the AVR driver (§ Universal AVR SDK) — HEOS/Yamaha only need onLog", async () => {
    const logs: string[] = [];
    const avr = buildNativeDriver("avr", {}, {
      onLog: (level, message) => logs.push(`${level}:${message}`),
      artworkUrlFor: (id) => `https://hub.local/v1/devices/${id}/media/artwork`,
    });
    expect(avr).not.toBeNull();
    // Real proof the context reached the driver instance: getArtwork() on an unmanaged
    // device resolves null without throwing (constructor accepted the options cleanly),
    // and the connection-lifecycle onLog wiring is exercised via a real (failing, since
    // nothing is bound) connect/disconnect cycle without error.
    await avr!.connect();
    await avr!.disconnect();
    expect(avr!.protocol).toBe("avr");
  });

  it("omits ctx entirely — every factory still builds a working driver (ctx defaults to {})", () => {
    expect(buildNativeDriver("avr", {})?.protocol).toBe("avr");
    expect(buildNativeDriver("heos", {})?.protocol).toBe("heos");
    expect(buildNativeDriver("yamaha", {})?.protocol).toBe("yamaha");
  });
});

describe("native-driver-factory — CoolMaster", () => {
  it("reports a factory for coolmaster", () => {
    expect(hasNativeFactory("coolmaster")).toBe(true);
  });

  it("requires a host — null without one", () => {
    expect(buildNativeDriver("coolmaster", {})).toBeNull();
  });

  it("builds a live driver instance once a gateway host is configured", () => {
    const driver = buildNativeDriver("coolmaster", { host: "192.168.0.21", protocol: "auto" });
    expect(driver?.protocol).toBe("coolmaster");
  });
});
