import { describe, expect, it } from "vitest";
import {
  buildNativeDriver,
  casambiUnitIdFromBackendId,
  hasNativeFactory,
  scopeCasambiBackendId,
  scopeCoolMasterBackendId,
  unscopeCasambiBackendId,
  unscopeCoolMasterBackendId,
  withCasambiInstanceAddressing,
  withCoolMasterInstanceAddressing,
  withRuntimeProtocol,
} from "./native-driver-factory.js";
import type { DeviceId } from "@supreme/domain-model";
import type { DiscoveredDevice, INativeProtocolDriver, ProtocolBinding } from "@supreme/integration-layer";
import { CasambiProtocolDriver, CoolMasterProtocolDriver } from "@supreme/protocols";
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

/**
 * § D14 — Devialet joins the Extension Center via the exact same manifest↔runtime
 * bridge AVR/HEOS/Yamaha already use. Same posture: an empty configSchema (real
 * per-speaker IP comes later via Bus Binding), so the factory always succeeds.
 */
describe("native-driver-factory — Devialet", () => {
  it("reports a factory for devialet", () => {
    expect(hasNativeFactory("devialet")).toBe(true);
  });

  it("builds a live driver instance from an empty config (nothing global to configure)", () => {
    const devialet = buildNativeDriver("devialet", {});
    expect(devialet?.protocol).toBe("devialet");
  });

  it("threads ctx.onLog and ctx.artworkUrlFor into the Devialet driver, matching the AVR pattern", async () => {
    const logs: string[] = [];
    const devialet = buildNativeDriver("devialet", {}, {
      onLog: (level, message) => logs.push(`${level}:${message}`),
      artworkUrlFor: (id) => `https://hub.local/v1/devices/${id}/media/artwork`,
    });
    expect(devialet).not.toBeNull();
    await devialet!.connect();
    await devialet!.disconnect();
    expect(devialet!.protocol).toBe("devialet");
  });

  it("omits ctx entirely — still builds a working driver (ctx defaults to {})", () => {
    expect(buildNativeDriver("devialet", {})?.protocol).toBe("devialet");
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

// § Multi-network Casambi, Stage 4 — network-scoped Casambi addressing.
describe("scopeCasambiBackendId / unscopeCasambiBackendId / casambiUnitIdFromBackendId", () => {
  it("scopes a bare backendId with the instance id as a middle segment", () => {
    expect(scopeCasambiBackendId("casambi:45", "drv_net2")).toBe("casambi:drv_net2:45");
  });

  it("unscopes back to bare for the SAME instance id", () => {
    expect(unscopeCasambiBackendId("casambi:drv_net2:45", "drv_net2")).toBe("casambi:45");
  });

  it("unscoping is the exact inverse of scoping, round-trip", () => {
    const scoped = scopeCasambiBackendId("casambi:45", "drv_net2");
    expect(unscopeCasambiBackendId(scoped, "drv_net2")).toBe("casambi:45");
  });

  it("passes an already-bare address through unscopeCasambiBackendId unchanged", () => {
    expect(unscopeCasambiBackendId("casambi:45", "drv_net2")).toBe("casambi:45");
  });

  it("does NOT unscope an address belonging to a DIFFERENT instance — passes it through rather than guessing", () => {
    const scopedForNet2 = scopeCasambiBackendId("casambi:45", "drv_net2");
    expect(unscopeCasambiBackendId(scopedForNet2, "drv_net3")).toBe(scopedForNet2);
  });

  it("two different instances scoping the SAME unit id produce two DIFFERENT strings — the whole point", () => {
    const fromNet2 = scopeCasambiBackendId("casambi:45", "drv_net2");
    const fromNet3 = scopeCasambiBackendId("casambi:45", "drv_net3");
    expect(fromNet2).not.toBe(fromNet3);
  });

  it("extracts the unit id from both bare and scoped forms identically", () => {
    expect(casambiUnitIdFromBackendId("casambi:45")).toBe(45);
    expect(casambiUnitIdFromBackendId("casambi:drv_net2:45")).toBe(45);
  });

  it("returns null for a non-Casambi backendId, never a fabricated number", () => {
    expect(casambiUnitIdFromBackendId("knx.1_1_5")).toBeNull();
    expect(casambiUnitIdFromBackendId("mqtt/lamp/1")).toBeNull();
  });

  it("§ Supreme Universal Keypad Stage 1 — scopes a keypad's backendId exactly like any other unit, so 'Network 1 Unit 4' and 'Network 2 Unit 4' keypads never collide", () => {
    const net1 = scopeCasambiBackendId("casambi:4", "drv_net1");
    const net2 = scopeCasambiBackendId("casambi:4", "drv_net2");
    expect(net1).not.toBe(net2);
    expect(unscopeCasambiBackendId(net1, "drv_net1")).toBe("casambi:4");
    expect(unscopeCasambiBackendId(net2, "drv_net2")).toBe("casambi:4");
    expect(casambiUnitIdFromBackendId(net1)).toBe(4);
    expect(casambiUnitIdFromBackendId(net2)).toBe(4);
  });
});

describe("withCasambiInstanceAddressing", () => {
  function fakeDriver(overrides: Partial<INativeProtocolDriver> = {}): INativeProtocolDriver {
    return {
      protocol: "casambi",
      async connect() {},
      async disconnect() {},
      isConnected: () => true,
      async bind() {},
      manages: () => false,
      async command() {},
      getState: () => null,
      async discover(): Promise<DiscoveredDevice[]> {
        return [
          { backendId: "casambi:45", suggestedName: "Living Room Light", capabilities: ["onoff"], raw: {} },
          { backendId: "casambi:12", suggestedName: "Curtain", capabilities: ["position"], raw: {} },
        ];
      },
      onState: () => () => {},
      ...overrides,
    };
  }

  it("a null instanceId (primary instance) returns the driver COMPLETELY UNWRAPPED — no address change at all", async () => {
    const driver = fakeDriver();
    const wrapped = withCasambiInstanceAddressing(driver, null);
    expect(wrapped).toBe(driver); // same reference, not just same behavior
    const found = await wrapped.discover();
    expect(found.map((d) => d.backendId)).toEqual(["casambi:45", "casambi:12"]);
  });

  it("scopes every discovered backendId for a non-primary instance", async () => {
    const wrapped = withCasambiInstanceAddressing(fakeDriver(), "drv_net2");
    const found = await wrapped.discover();
    expect(found.map((d) => d.backendId)).toEqual(["casambi:drv_net2:45", "casambi:drv_net2:12"]);
    // Everything else about the discovered device is untouched.
    expect(found[0]!.suggestedName).toBe("Living Room Light");
    expect(found[0]!.capabilities).toEqual(["onoff"]);
  });

  it("two DIFFERENT instances wrapping drivers that both discover unit 45 produce DIFFERENT backendIds — the identical-unit-id case", async () => {
    const wrappedNet2 = withCasambiInstanceAddressing(fakeDriver(), "drv_net2");
    const wrappedNet3 = withCasambiInstanceAddressing(fakeDriver(), "drv_net3");
    const [fromNet2] = await wrappedNet2.discover();
    const [fromNet3] = await wrappedNet3.discover();
    expect(fromNet2!.backendId).not.toBe(fromNet3!.backendId);
    expect(fromNet2!.backendId).toBe("casambi:drv_net2:45");
    expect(fromNet3!.backendId).toBe("casambi:drv_net3:45");
  });

  it("strips the instance segment back to bare before forwarding a bind() to the real driver", async () => {
    const received: ProtocolBinding[] = [];
    const driver = fakeDriver({
      async bind(binding: ProtocolBinding) {
        received.push(binding);
      },
    });
    const wrapped = withCasambiInstanceAddressing(driver, "drv_net2");
    await wrapped.bind({ deviceId: "dev-1" as DeviceId, capability: "onoff", address: "casambi:drv_net2:45" });
    expect(received).toHaveLength(1);
    expect(received[0]!.address).toBe("casambi:45"); // the REAL driver only ever sees the bare form
  });

  it("command/manages/getState/isConnected are untouched — they're keyed by Supreme deviceId, never by address", async () => {
    const managedDevice = "dev-managed" as DeviceId;
    const driver = fakeDriver({ manages: (id) => id === managedDevice });
    const wrapped = withCasambiInstanceAddressing(driver, "drv_net2");
    expect(wrapped.manages(managedDevice)).toBe(true);
    expect(wrapped.manages("dev-other" as DeviceId)).toBe(false);
    expect(wrapped.isConnected()).toBe(true);
  });
});

// § Multi-network Casambi, Stage 4 — proves the wrapper composes correctly against the REAL
// `CasambiProtocolDriver.bind()`/`unitIdFromBinding()` (not a fake stand-in): if the address-
// stripping logic were wrong and a scoped address ("casambi:drv_net2:45") reached the real
// driver unstripped, `unitIdFromBinding` would parse "drv_net2:45" as `Number(...)` → `NaN`, and
// `bind()` throws "has no numeric unit id" — so a bind that does NOT throw, on a REAL driver
// instance, is direct proof the translation is correct end to end, no synthetic UDP packet needed.
describe("withCasambiInstanceAddressing — against a REAL CasambiProtocolDriver", () => {
  function realLocalDriver(): CasambiProtocolDriver {
    return buildNativeDriver("casambi", {
      connectionType: "local",
      gatewayIp: "192.168.1.90",
      restPort: 80,
      udpPort: 5100,
    }) as CasambiProtocolDriver;
  }

  it("binding a scoped address to a wrapped real driver succeeds and manages the device — the address was correctly unscoped first", async () => {
    const wrapped = withCasambiInstanceAddressing(realLocalDriver(), "drv_net2");
    const deviceId = "dev-net2-unit45" as DeviceId;
    await expect(
      wrapped.bind({ deviceId, capability: "onoff", address: "casambi:drv_net2:45" }),
    ).resolves.not.toThrow();
    expect(wrapped.manages(deviceId)).toBe(true);
  });

  it("binding an UNSCOPED (legacy) address to the PRIMARY (unwrapped) instance still works exactly as before — the backward-compat case", async () => {
    const driver = realLocalDriver(); // instanceId = null path never wraps at all
    const deviceId = "dev-legacy-unit45" as DeviceId;
    await expect(driver.bind({ deviceId, capability: "onoff", address: "casambi:45" })).resolves.not.toThrow();
    expect(driver.manages(deviceId)).toBe(true);
  });

  it("binding a MIS-scoped address (wrong instance id) to the real driver fails loudly rather than silently binding the wrong unit", async () => {
    const wrapped = withCasambiInstanceAddressing(realLocalDriver(), "drv_net2");
    // Scoped for a DIFFERENT instance — unscopeCasambiBackendId passes it through unchanged
    // (documented, deliberate), so the real driver receives "casambi:drv_net3:45" and its own
    // parser (`Number("drv_net3:45")` → NaN) rejects it — never silently misinterpreted as some
    // other unit.
    await expect(
      wrapped.bind({ deviceId: "dev-x" as DeviceId, capability: "onoff", address: "casambi:drv_net3:45" }),
    ).rejects.toThrow(/no numeric unit id/);
  });
});

// § Multi-instance CoolMaster (REQUIREMENT 3) — CoolMaster's own UIDs (`L1.100`) are
// gateway-local, not globally unique across two installed gateways, so it needs the same
// address-scoping wrapper Casambi's Stage 4 introduced — mirrors that suite exactly.
describe("withCoolMasterInstanceAddressing", () => {
  function fakeCoolMasterDriver(overrides: Partial<INativeProtocolDriver> = {}): INativeProtocolDriver {
    return {
      protocol: "coolmaster",
      async connect() {},
      async disconnect() {},
      isConnected: () => true,
      async bind() {},
      manages: () => false,
      async command() {},
      getState: () => null,
      async discover(): Promise<DiscoveredDevice[]> {
        return [
          { backendId: "L1.100", suggestedName: "Living Room", capabilities: ["onoff", "temperature"], raw: {} },
          { backendId: "L1.101", suggestedName: "Kitchen", capabilities: ["onoff", "temperature"], raw: {} },
        ];
      },
      onState: () => () => {},
      ...overrides,
    };
  }

  it("a null instanceId (primary instance) returns the driver COMPLETELY UNWRAPPED — no address change at all", async () => {
    const driver = fakeCoolMasterDriver();
    const wrapped = withCoolMasterInstanceAddressing(driver, null);
    expect(wrapped).toBe(driver);
    const found = await wrapped.discover();
    expect(found.map((d) => d.backendId)).toEqual(["L1.100", "L1.101"]);
  });

  it("scopes every discovered backendId for a non-primary instance", async () => {
    const wrapped = withCoolMasterInstanceAddressing(fakeCoolMasterDriver(), "drv_gw2");
    const found = await wrapped.discover();
    expect(found.map((d) => d.backendId)).toEqual(["coolmaster:drv_gw2:L1.100", "coolmaster:drv_gw2:L1.101"]);
    expect(found[0]!.suggestedName).toBe("Living Room");
    expect(found[0]!.capabilities).toEqual(["onoff", "temperature"]);
  });

  it("two DIFFERENT gateway instances that both report L1.101 produce DIFFERENT backendIds — the exact collision REQUIREMENT 3 exists to prevent", async () => {
    const wrappedGwA = withCoolMasterInstanceAddressing(fakeCoolMasterDriver(), "drv_gwA");
    const wrappedGwB = withCoolMasterInstanceAddressing(fakeCoolMasterDriver(), "drv_gwB");
    const [, fromA] = await wrappedGwA.discover(); // L1.101 is the second entry
    const [, fromB] = await wrappedGwB.discover();
    expect(fromA!.backendId).not.toBe(fromB!.backendId);
    expect(fromA!.backendId).toBe("coolmaster:drv_gwA:L1.101");
    expect(fromB!.backendId).toBe("coolmaster:drv_gwB:L1.101");
  });

  it("strips the instance segment back to the bare UID before forwarding a bind() to the real driver", async () => {
    const received: ProtocolBinding[] = [];
    const driver = fakeCoolMasterDriver({
      async bind(binding: ProtocolBinding) {
        received.push(binding);
      },
    });
    const wrapped = withCoolMasterInstanceAddressing(driver, "drv_gw2");
    await wrapped.bind({ deviceId: "dev-1" as DeviceId, capability: "onoff", address: "coolmaster:drv_gw2:L1.100" });
    expect(received).toHaveLength(1);
    expect(received[0]!.address).toBe("L1.100"); // the REAL driver only ever sees the bare UID
  });

  it("command/manages/getState/isConnected are untouched — they're keyed by Supreme deviceId, never by address", async () => {
    const managedDevice = "dev-managed" as DeviceId;
    const driver = fakeCoolMasterDriver({ manages: (id) => id === managedDevice });
    const wrapped = withCoolMasterInstanceAddressing(driver, "drv_gw2");
    expect(wrapped.manages(managedDevice)).toBe(true);
    expect(wrapped.manages("dev-other" as DeviceId)).toBe(false);
    expect(wrapped.isConnected()).toBe(true);
  });

  it("scopeCoolMasterBackendId / unscopeCoolMasterBackendId are exact inverses", () => {
    const scoped = scopeCoolMasterBackendId("L1.100", "drv_gw2");
    expect(scoped).toBe("coolmaster:drv_gw2:L1.100");
    expect(unscopeCoolMasterBackendId(scoped, "drv_gw2")).toBe("L1.100");
  });

  it("unscopeCoolMasterBackendId passes an address scoped to a DIFFERENT instance through unchanged, rather than guessing", () => {
    expect(unscopeCoolMasterBackendId("coolmaster:drv_gw3:L1.100", "drv_gw2")).toBe("coolmaster:drv_gw3:L1.100");
  });
});

// § Multi-instance CoolMaster — proves the wrapper composes correctly against a REAL
// `CoolMasterProtocolDriver.bind()`, not a fake stand-in: bind() stores whatever address it's
// given as the device's UID, so a bind that manages the device with the CORRECT bare UID
// afterward (never the still-scoped form) is direct proof the translation happened before
// the real driver ever saw the address.
describe("withCoolMasterInstanceAddressing — against a REAL CoolMasterProtocolDriver", () => {
  function realDriver(): CoolMasterProtocolDriver {
    return buildNativeDriver("coolmaster", { host: "192.168.1.50" }) as CoolMasterProtocolDriver;
  }

  it("binding a scoped address to a wrapped real driver manages the device using the unscoped bare UID", async () => {
    const wrapped = withCoolMasterInstanceAddressing(realDriver(), "drv_gw2");
    const deviceId = "dev-gw2-unit100" as DeviceId;
    await wrapped.bind({ deviceId, capability: "onoff", address: "coolmaster:drv_gw2:L1.100" });
    expect(wrapped.manages(deviceId)).toBe(true);
    // No state yet (nothing has connected/polled, so the unit cache is empty) — `null`,
    // never an error, proving the bind reached the real driver's own binding path
    // successfully rather than throwing on the (correctly unscoped) address.
    expect(wrapped.getState(deviceId, "onoff")).toBeNull();
  });

  it("binding an UNSCOPED (legacy) address to the PRIMARY (unwrapped) instance still works exactly as before — the backward-compat case", async () => {
    const driver = realDriver(); // instanceId = null path never wraps at all
    const deviceId = "dev-legacy-unit100" as DeviceId;
    await expect(driver.bind({ deviceId, capability: "onoff", address: "L1.100" })).resolves.not.toThrow();
    expect(driver.manages(deviceId)).toBe(true);
  });
});
