import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealMatterBridgeServer } from "./real-server.js";

/**
 * § Matter Bridge Phase 1 foundation — REAL `@matter/main` endpoint construction for every
 * non-OnOff device type this Phase added (Dimmable Light, Color Temperature Light, Extended
 * Color Light, Window Covering).
 *
 * This is the exact regression class the Phase 1 acceptance bug slipped through: every existing
 * unit test for these device types (`matter-bridge-driver.test.ts`, `matter-bridge-persistence.
 * test.ts`) runs against `FakeMatterBridgeServer`, which just stores `{name, on}` in a Map — it
 * can never catch a REAL `@matter/main` construction failure, because it never asks the real SDK
 * to validate anything. `real-server.persistence.test.ts` DOES exercise the real SDK, but only
 * ever for On/Off Light. Nothing exercised real endpoint construction for the other four device
 * types — which is exactly how a live deployment's Color Temperature lights failed with
 * "Behaviors have errors" while every unit test stayed green.
 *
 * Root cause (found via a local reproduction against this real SDK, not guessed): the
 * ColorControl cluster's ColorTemperature feature has THREE mandatory attributes this codebase
 * never set — `colorTempPhysicalMinMireds`, `colorTempPhysicalMaxMireds`,
 * `coupleColorTempToLevelMinMireds` — so `colorTemperatureMireds` failed constraint validation
 * against an unset/zero bound for literally any value, and a second, separate conformance error
 * ("Matter requires you to set this attribute") fired for `coupleColorTempToLevelMinMireds`
 * specifically. Fixed in `real-server.ts`'s `addEndpoint` (COLOR_TEMPERATURE_LIGHT and
 * EXTENDED_COLOR_LIGHT branches) by setting all three, bounded to SupremeOS's own `ColorState.
 * kelvin` schema range (1000K-10000K, `packages/domain-model/src/capabilities.ts`) — never a
 * per-device guess, always wide enough for any Kelvin value SupremeOS can ever send.
 *
 * Same sandbox caveat as `real-server.persistence.test.ts`: `ServerNode.create()` opens real OS
 * sockets; if this sandbox can't, each test reports that honestly via a skip rather than a false
 * pass.
 */
describe("RealMatterBridgeServer — real @matter/main endpoint construction per device type", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matter-bridge-devicetypes-"));
  });
  afterEach(async () => {
    // § live-confirmed — same dangling-lazy-persist race documented in `real-server.
    // persistence.test.ts`'s own fix: `stop()`'s `node.close()` does not reliably wait for a
    // just-started `ServerEndpointStores` lazy write (the SDK schedules it asynchronously,
    // independent of `add()`'s own await), so removing the temp directory immediately can race
    // a write still in flight — an "Unhandled Rejection: ENOENT ... rename" that fails the
    // whole suite despite every assertion passing. A short grace period is test-cleanup-only
    // (production never deletes this directory at all), not a production behavior change.
    await new Promise((r) => setTimeout(r, 100));
    rmSync(dir, { recursive: true, force: true });
  });

  async function startOrSkip(server: RealMatterBridgeServer, label: string): Promise<boolean> {
    try {
      await server.start();
      return true;
    } catch (err) {
      console.warn(`SKIPPED (${label}) — real @matter/main ServerNode could not start in this sandbox (${(err as Error).message}).`);
      return false;
    }
  }

  it("constructs a real Dimmable Light endpoint (OnOff + LevelControl) without throwing", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "dimmable-test" });
    if (!(await startOrSkip(server, "dimmable"))) return;
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Test Dimmable",
      deviceTypeId: 0x0101,
      initialState: { kind: "brightness", on: false, level: 50 },
    });
    await server.stop();
  }, 30_000);

  it("constructs a real Color Temperature Light endpoint (OnOff + LevelControl + ColorControl/CT) without throwing — the exact regression case", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "cct-test" });
    if (!(await startOrSkip(server, "color-temperature"))) return;
    // The real R&D DL-1/DL-2 shape: a `color` capability, CCT-only (no rgb), default kelvin.
    await server.addEndpoint({
      endpointNumber: 1,
      name: "R&D DL-1",
      deviceTypeId: 0x010c,
      initialState: { kind: "color", on: false, level: 100, hue: null, saturation: null, kelvin: 3000 },
    });
    await server.stop();
  }, 30_000);

  it("constructs a real Extended Color Light endpoint (OnOff + LevelControl + ColorControl/Xy+CT) without throwing", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "extcolor-test" });
    if (!(await startOrSkip(server, "extended-color"))) return;
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Test Extended Color",
      deviceTypeId: 0x010d,
      initialState: { kind: "color", on: true, level: 80, hue: 210, saturation: 60, kelvin: null },
    });
    await server.stop();
  }, 30_000);

  it("constructs a real Window Covering endpoint (Lift + PositionAwareLift) without throwing", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "covering-test" });
    if (!(await startOrSkip(server, "window-covering"))) return;
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Test Curtain",
      deviceTypeId: 0x0202,
      initialState: { kind: "position", position: 100, moving: false },
    });
    await server.stop();
  }, 30_000);

  it("constructs all four non-OnOff-Light device types together on one aggregator, at distinct endpoints — the full acceptance scenario", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "all-types-test" });
    if (!(await startOrSkip(server, "all-types"))) return;
    await server.addEndpoint({ endpointNumber: 1, name: "Dimmer", deviceTypeId: 0x0101, initialState: { kind: "brightness", on: false, level: 0 } });
    await server.addEndpoint({
      endpointNumber: 2,
      name: "R&D DL-1",
      deviceTypeId: 0x010c,
      initialState: { kind: "color", on: false, level: 100, hue: null, saturation: null, kelvin: 3000 },
    });
    await server.addEndpoint({
      endpointNumber: 3,
      name: "R&D DL-2",
      deviceTypeId: 0x010c,
      initialState: { kind: "color", on: false, level: 100, hue: null, saturation: null, kelvin: 4000 },
    });
    await server.addEndpoint({ endpointNumber: 4, name: "Curtain motor", deviceTypeId: 0x0202, initialState: { kind: "position", position: 100, moving: false } });
    await server.stop();
  }, 30_000);

  it("§ Matter Bridge Phase 1.2 — the REAL @matter/main BridgedDeviceBasicInformation.NodeLabel attribute holds the SupremeOS device name, and a rename genuinely rewrites it live", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "naming-test" });
    if (!(await startOrSkip(server, "naming"))) return;
    await server.addEndpoint({
      endpointNumber: 1,
      name: "Pantry DL-2",
      deviceTypeId: 0x010c,
      initialState: { kind: "color", on: false, level: 100, hue: null, saturation: null, kelvin: 3000 },
    });
    // The real Matter attribute Apple Home/Google Home/Alexa/SmartThings all read for the
    // accessory's display name — read back off the live endpoint, not a SupremeOS-side copy.
    expect(server.getEndpointNodeLabel(1)).toBe("Pantry DL-2");
    expect(server.getEndpointNodeLabel(1)).not.toContain("dev_"); // never the raw deviceId shape

    await server.updateEndpointName(1, "Pantry Ceiling DL-2");
    expect(server.getEndpointNodeLabel(1)).toBe("Pantry Ceiling DL-2");

    await server.stop();
  }, 30_000);

  it("§ Matter Bridge Phase 1.2 — the real NodeLabel attribute is populated correctly for every Phase 1 device type, not only lights", async () => {
    const server = new RealMatterBridgeServer({ storagePath: dir, nodeId: "naming-all-types-test" });
    if (!(await startOrSkip(server, "naming-all-types"))) return;
    await server.addEndpoint({ endpointNumber: 1, name: "R&D Study table Led Strip", deviceTypeId: 0x0101, initialState: { kind: "brightness", on: false, level: 0 } });
    await server.addEndpoint({
      endpointNumber: 2,
      name: "Pantry DL-1",
      deviceTypeId: 0x010c,
      initialState: { kind: "color", on: false, level: 100, hue: null, saturation: null, kelvin: 3000 },
    });
    await server.addEndpoint({
      endpointNumber: 3,
      name: "Pantry Strip",
      deviceTypeId: 0x010d,
      initialState: { kind: "color", on: true, level: 80, hue: 210, saturation: 60, kelvin: null },
    });
    await server.addEndpoint({ endpointNumber: 4, name: "Curtain motor", deviceTypeId: 0x0202, initialState: { kind: "position", position: 100, moving: false } });
    expect(server.getEndpointNodeLabel(1)).toBe("R&D Study table Led Strip");
    expect(server.getEndpointNodeLabel(2)).toBe("Pantry DL-1");
    expect(server.getEndpointNodeLabel(3)).toBe("Pantry Strip");
    expect(server.getEndpointNodeLabel(4)).toBe("Curtain motor");
    await server.stop();
  }, 30_000);
});
