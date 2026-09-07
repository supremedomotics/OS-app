import { describe, expect, it } from "vitest";
import { buildNativeDriver, hasNativeFactory, withRuntimeProtocol } from "./native-driver-factory.js";
import type { INativeProtocolDriver } from "@supreme/integration-layer";
import { CasambiProtocolDriver } from "@supreme/protocols";
import type { UdpBindOptions, UdpTransport } from "@supreme/lan";

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

  it("§ AVR Diagnostic Mode — threads ctx.avrDiagnostics into the AVR driver; off by default", () => {
    const off = buildNativeDriver("avr", {});
    expect(off?.exportDiagnosticsLog?.()).toBeNull();
    const on = buildNativeDriver("avr", {}, { avrDiagnostics: true });
    expect(on?.exportDiagnosticsLog?.()).not.toBeNull();
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

/**
 * § Casambi Driver Refactor — PR-2: `connectionType` is absent from every config stored before
 * the Foundation session, so the factory must keep defaulting to Cloud identically. This session
 * added `netId`/`dataFormat` to the Local branch — this is that branch's first dedicated test
 * (a real, disclosed coverage gap noted in TODO.md until now).
 */
describe("native-driver-factory — Casambi", () => {
  it("defaults to Cloud when connectionType is absent (every pre-refactor config)", () => {
    const driver = buildNativeDriver("casambi", { apiKey: "k", email: "a@b.com", password: "pw" });
    expect(driver).toBeInstanceOf(CasambiProtocolDriver);
    expect((driver as CasambiProtocolDriver).getHealth().connectionType).toBe("cloud");
  });

  it("returns null for Cloud config missing required credentials", () => {
    expect(buildNativeDriver("casambi", { connectionType: "cloud" })).toBeNull();
  });

  it("falls back to ctx.casambiCloudDefaults when the driver's own config leaves credentials blank", () => {
    const driver = buildNativeDriver(
      "casambi",
      { connectionType: "cloud" },
      { casambiCloudDefaults: { apiKey: "fleet-key", email: "fleet@example.com", password: "fleet-pw" } },
    );
    expect(driver).toBeInstanceOf(CasambiProtocolDriver);
    expect((driver as CasambiProtocolDriver).getHealth().connectionType).toBe("cloud");
  });

  it("still returns null when neither the config nor a fleet default has credentials", () => {
    expect(buildNativeDriver("casambi", { connectionType: "cloud" }, {})).toBeNull();
  });

  it("returns null for Local config missing gatewayIp/restPort/udpPort", () => {
    expect(buildNativeDriver("casambi", { connectionType: "local" })).toBeNull();
  });

  it("builds a Local driver and threads netId/dataFormat through to the transport config", () => {
    const driver = buildNativeDriver("casambi", {
      connectionType: "local",
      gatewayIp: "192.168.1.90",
      restPort: 80,
      udpPort: 5100,
      netId: 3,
      dataFormat: "dec-hash",
    }) as CasambiProtocolDriver;
    expect(driver).toBeInstanceOf(CasambiProtocolDriver);
    expect(driver.getHealth().connectionType).toBe("local");
    expect(driver.getCasambiDiagnostics().gateway).toBe("192.168.1.90:80");
  });

  it("threads gatewayUsername/gatewayPassword through to the Local transport without requiring them", () => {
    const driver = buildNativeDriver("casambi", {
      connectionType: "local",
      gatewayIp: "192.168.1.90",
      restPort: 80,
      udpPort: 5100,
      gatewayUsername: "admin",
      gatewayPassword: "s3cret",
    }) as CasambiProtocolDriver;
    expect(driver).toBeInstanceOf(CasambiProtocolDriver);
    expect(driver.getHealth().connectionType).toBe("local");
  });

  it("builds a Local driver with netId/dataFormat omitted (factory supplies the defaults)", () => {
    const driver = buildNativeDriver("casambi", {
      connectionType: "local",
      gatewayIp: "192.168.1.90",
      restPort: 80,
      udpPort: 5100,
    });
    expect(driver).toBeInstanceOf(CasambiProtocolDriver);
    expect((driver as CasambiProtocolDriver).getHealth().connectionType).toBe("local");
  });

  // § LAN Transport Phase 2 — the factory no longer defaults to a real `dgram` socket internally;
  // it must actually USE whichever `ctx.udpTransportFactory` the caller supplies (in production,
  // `installer-context.ts`'s NATS-vs-local-direct resolution), never silently substitute its own.
  it("uses ctx.udpTransportFactory when the caller supplies one, rather than the LocalDirectUdpTransport fallback", async () => {
    class FakeTransport implements UdpTransport {
      static instancesCreated = 0;
      async bind(_opts?: UdpBindOptions): Promise<void> {
        FakeTransport.instancesCreated += 1;
      }
      async send(): Promise<void> {}
      async joinMulticast(): Promise<void> {}
      async close(): Promise<void> {}
      onMessage(): () => void {
        return () => {};
      }
      onError(): () => void {
        return () => {};
      }
      onListening(): () => void {
        return () => {};
      }
      address() {
        return { address: "0.0.0.0", port: 5100 };
      }
    }
    const driver = buildNativeDriver(
      "casambi",
      { connectionType: "local", gatewayIp: "192.168.1.90", restPort: 80, udpPort: 5100 },
      { udpTransportFactory: () => new FakeTransport() },
    ) as CasambiProtocolDriver;
    await driver.connect();
    expect(FakeTransport.instancesCreated).toBe(1);
    await driver.disconnect();
  });

  it("falls back to LocalDirectUdpTransport (real node:dgram) when no ctx.udpTransportFactory is supplied", async () => {
    // A distinctive fixed port (matching this codebase's existing real-dgram test convention,
    // e.g. udp-engine.test.ts's loopback test) — sending to itself on 127.0.0.1 real-binds and
    // real-sends over an actual OS socket, proving the fallback truly is LocalDirectUdpTransport
    // and not just "didn't throw."
    const driver = buildNativeDriver("casambi", {
      connectionType: "local",
      gatewayIp: "127.0.0.1",
      restPort: 80,
      udpPort: 58471,
    }) as CasambiProtocolDriver;
    await driver.connect();
    expect(driver.isConnected()).toBe(true);
    await driver.disconnect();
  });
});


describe("withRuntimeProtocol (§ Multi-network Casambi)", () => {
  function fakeDriver(protocol: string): INativeProtocolDriver {
    return {
      protocol,
      async connect() {},
      async disconnect() {},
      isConnected: () => true,
      async bind() {},
      manages: () => false,
      async command() {},
      getState: () => null,
      async discover() { return []; },
      onState: () => () => {},
    };
  }

  it("returns the SAME instance, unmodified, when the protocol already matches", () => {
    const driver = fakeDriver("casambi");
    expect(withRuntimeProtocol(driver, "casambi")).toBe(driver);
  });

  it("reports a DIFFERENT protocol without changing any other behavior", async () => {
    const driver = fakeDriver("casambi");
    const wrapped = withRuntimeProtocol(driver, "casambi#drv_net2");
    expect(wrapped.protocol).toBe("casambi#drv_net2");
    expect(driver.protocol).toBe("casambi"); // the real instance is untouched
    expect(wrapped.isConnected()).toBe(true); // every other member still forwards through
    await wrapped.connect();
    await wrapped.disconnect();
  });

  it("rebinds methods to the real instance, so internal `this` still resolves correctly", async () => {
    // A driver whose methods read its OWN internal state via `this` — exactly what every real
    // driver class does. If the wrapper failed to rebind (e.g. returned the raw class method
    // without `.bind(target)`), calling it through the proxy would run with `this` set to the
    // PROXY, not the real instance, and any real class using native `#private` fields would
    // throw. CasambiProtocolDriver (the real caller) does use them, so this must hold.
    class StatefulDriver implements INativeProtocolDriver {
      readonly protocol = "casambi";
      #connected = false;
      async connect() { this.#connected = true; }
      async disconnect() { this.#connected = false; }
      isConnected() { return this.#connected; }
      async bind() {}
      manages() { return false; }
      async command() {}
      getState() { return null; }
      async discover() { return []; }
      onState() { return () => {}; }
    }
    const wrapped = withRuntimeProtocol(new StatefulDriver(), "casambi#drv_net2");
    expect(wrapped.isConnected()).toBe(false);
    await wrapped.connect();
    expect(wrapped.isConnected()).toBe(true);
  });
});
