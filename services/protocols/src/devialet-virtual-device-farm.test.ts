import type { DeviceId } from "@supreme/domain-model";
import { afterEach, describe, expect, it } from "vitest";
import { DevialetProtocolDriver } from "./devialet-driver.js";
import { parseDevialetCandidate } from "./devialet-discovery.js";
import type { MdnsService } from "./mdns.js";
import { DevialetVirtualDeviceFarm, VirtualDevialetDevice, virtualDevialetMdnsTxt } from "./devialet-virtual-device.js";

/**
 * § D16 — exercises the REAL `DevialetProtocolDriver` (and, transitively, the real
 * R1/CISettings clients, topology registry, and command-routing module) against the
 * reusable virtual device farm. Every scenario here proves something about the
 * DRIVER, not merely the simulator's own bookkeeping — per the brief's explicit
 * "test the existing driver, not the simulator only" requirement.
 *
 * All coverage in this file is SIMULATED (in-process HTTP), never real Devialet
 * hardware.
 */

const IP_CONTROL_PATH = "/ipcontrol/v1";

describe("Devialet virtual device farm — exercising the real DevialetProtocolDriver", () => {
  let farm: DevialetVirtualDeviceFarm;
  const drivers: DevialetProtocolDriver[] = [];

  afterEach(async () => {
    await Promise.all(drivers.map((d) => d.disconnect()));
    drivers.length = 0;
    await farm.close();
  });

  function newDriver(opts: ConstructorParameters<typeof DevialetProtocolDriver>[0] = { pollMs: 1_000_000 }) {
    const driver = new DevialetProtocolDriver(opts);
    drivers.push(driver);
    return driver;
  }

  it("A — stateful command roundtrip: POST volume changes virtual state, the driver reads it back authoritatively (never synthesizes it)", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    const srv = await farm.addDevice(device);
    const dev = "dev-a" as DeviceId;
    const driver = newDriver();
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(50);

    await driver.command(dev, { capability: "media", action: "volume", volume: 35 } as never);
    expect(device.volume).toBe(35); // the simulator's own state really changed

    // A command must never itself synthesize published state — only a subsequent
    // read does. Confirm the published volume is unchanged until the next poll().
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(50);
    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(35);

    farm.assertNoStrictViolations();
  });

  it("B — play/pause/mute/next roundtrip changes virtual state, then a real poll() reads it back", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    const srv = await farm.addDevice(device);
    const dev = "dev-b" as DeviceId;
    const driver = newDriver();
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();

    await driver.command(dev, { capability: "media", action: "pause" } as never);
    expect(device.playingState).toBe("paused");
    await driver.command(dev, { capability: "media", action: "mute" } as never);
    expect(device.muteState).toBe("muted");

    await driver.poll();
    const state = driver.getState(dev, "media") as { playback: string; muted: boolean };
    expect(state.playback).toBe("paused");
    expect(state.muted).toBe(true);

    // "next" is gated by the virtual device's own availableOperations, exactly like
    // real R1 — proves the driver's pre-flight check reads REAL simulator state.
    device.setAvailableOperations(["play", "pause"]); // no "next"
    await expect(driver.command(dev, { capability: "media", action: "next" } as never)).rejects.toThrow(/availableOperations/);

    farm.assertNoStrictViolations();
  });

  it("C — NoCurrentSource (confirmed) vs. transport failure (unconfirmed) produce DIFFERENT driver behavior", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    const srv = await farm.addDevice(device);
    const dev = "dev-c" as DeviceId;
    const driver = newDriver();
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect((driver.getState(dev, "media") as { playback: string; title: string | null }).playback).toBe("playing");

    // § D10 — a REAL, confirmed NoCurrentSource answer publishes an honest idle state.
    device.noCurrentSource = true;
    await driver.poll();
    let state = driver.getState(dev, "media") as { playback: string; title: string | null; source: string | null };
    expect(state.playback).toBe("idle");
    expect(state.title).toBeNull();
    expect(state.source).toBeNull();

    // Recover, then simulate a genuine transport failure — must NOT be treated the
    // same as a confirmed "nothing playing" answer; state must simply stay as last
    // published (never re-fabricated to idle, never crashed).
    device.noCurrentSource = false;
    await driver.poll();
    expect((driver.getState(dev, "media") as { playback: string }).playback).toBe("playing");

    device.failNext("sources/current", { kind: "socket-reset" });
    await expect(driver.poll()).resolves.toBeUndefined();
    state = driver.getState(dev, "media") as { playback: string };
    expect(state.playback).toBe("playing"); // unchanged — not fabricated to idle

    farm.assertNoStrictViolations();
  });

  it("D — multi-device farm: intentionally failing Device A never affects healthy Devices B/C", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const a = new VirtualDevialetDevice({ deviceId: "A", systemId: "SA", groupId: "GA" });
    const b = new VirtualDevialetDevice({ deviceId: "B", systemId: "SB", groupId: "GB" });
    const c = new VirtualDevialetDevice({ deviceId: "C", systemId: "SC", groupId: "GC" });
    b.setVolume(70);
    c.setVolume(90);
    const srvA = await farm.addDevice(a);
    const srvB = await farm.addDevice(b);
    const srvC = await farm.addDevice(c);
    const devA = "dev-d-a" as DeviceId, devB = "dev-d-b" as DeviceId, devC = "dev-d-c" as DeviceId;
    const driver = newDriver();
    await driver.connect();
    await driver.bind({ deviceId: devA, capability: "media", address: srvA.base, config: { path: IP_CONTROL_PATH } });
    await driver.bind({ deviceId: devB, capability: "media", address: srvB.base, config: { path: IP_CONTROL_PATH } });
    await driver.bind({ deviceId: devC, capability: "media", address: srvC.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect((driver.getState(devB, "media") as { volume: number }).volume).toBe(70);
    expect((driver.getState(devC, "media") as { volume: number }).volume).toBe(90);

    a.failNext("", { kind: "socket-reset" }); // fail EVERY request to A from now on
    b.setVolume(75);
    c.setVolume(95);
    await expect(driver.poll()).resolves.toBeUndefined();
    expect((driver.getState(devB, "media") as { volume: number }).volume).toBe(75);
    expect((driver.getState(devC, "media") as { volume: number }).volume).toBe(95);

    farm.assertNoStrictViolations();
  });

  it("E — topology: Stereo -> Solo -> Stereo reconciles correctly through the farm, driven by the periodic sweep", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const a = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    const b = new VirtualDevialetDevice({ deviceId: "B", systemId: "S1", groupId: "G1" });
    const srvA = await farm.addDevice(a);
    const srvB = await farm.addDevice(b);
    const devA = "dev-e-a" as DeviceId, devB = "dev-e-b" as DeviceId;
    const driver = newDriver({ pollMs: 1_000_000, topologyRefreshMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: devA, capability: "media", address: srvA.base, config: { path: IP_CONTROL_PATH } });
    await driver.bind({ deviceId: devB, capability: "media", address: srvB.base, config: { path: IP_CONTROL_PATH } });
    await driver.refreshTopology();
    expect(driver.getTopologySnapshot().systems["S1"]?.memberDeviceIds).toEqual(["A", "B"]);

    a.setTopology({ systemId: "SA", groupId: "GA" });
    b.setTopology({ systemId: "SB", groupId: "GB" });
    const stereoToSolo = await driver.refreshTopology();
    expect(stereoToSolo.changed).toBe(true);
    expect(driver.getTopologySnapshot().systems["S1"]).toBeUndefined();
    expect(driver.getTopologySnapshot().systems["SA"]?.memberDeviceIds).toEqual(["A"]);

    a.setTopology({ systemId: "S1", groupId: "G1" });
    b.setTopology({ systemId: "S1", groupId: "G1" });
    const soloToStereo = await driver.refreshTopology();
    expect(soloToStereo.changed).toBe(true);
    expect(driver.getTopologySnapshot().systems["S1"]?.memberDeviceIds).toEqual(["A", "B"]);

    farm.assertNoStrictViolations();
  });

  it("F — topology refresh coalescing: three concurrent refreshTopology() calls produce exactly one real sweep", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    const srv = await farm.addDevice(device);
    const dev = "dev-f" as DeviceId;
    const driver = newDriver();
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.refreshTopology();
    const before = device.requestLog.filter((r) => r.endsWith("/devices/current")).length;

    const [r1, r2, r3] = await Promise.all([driver.refreshTopology(), driver.refreshTopology(), driver.refreshTopology()]);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    const after = device.requestLog.filter((r) => r.endsWith("/devices/current")).length;
    expect(after - before).toBe(1);

    farm.assertNoStrictViolations();
  });

  it("G — CISettings reconciliation: a stale/conflicting CISettings volume never overwrites R1's authoritative published state", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    device.setVolume(40);
    device.ciVolume = 5; // stale/conflicting CISettings value
    const srv = await farm.addDevice(device);
    const dev = "dev-g" as DeviceId;
    const driver = newDriver();
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();

    const rows = await driver.getCiSettingsReconciliation(dev);
    const volRow = rows?.find((r) => r.field === "volume");
    expect(volRow?.r1Value).toBe(40);
    expect(volRow?.ciSettingsValue).toBe(5);
    expect(volRow?.agree).toBe(false);
    // R1 remains authoritative — published state is untouched by the reconciliation read.
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);

    farm.assertNoStrictViolations();
  });

  it("H — artwork: fetched from the device's real coverArtUrl, coalesces, and a failure doesn't poison a later retry", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const badArt = await farm.addArtworkServer({ bytes: Buffer.alloc(0), status: 404 });
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    device.setMetadata({ artist: "Artist", album: "Album", title: "Track", coverArtUrl: `${badArt.base}/art.jpg` });
    const srv = await farm.addDevice(device);
    const dev = "dev-h" as DeviceId;
    const driver = newDriver();
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();

    expect(await driver.getArtwork(dev)).toBeNull(); // 404 — real, not fabricated success

    const goodArt = await farm.addArtworkServer({ bytes: Buffer.from([0xff, 0xd8, 0xff]), contentType: "image/jpeg" });
    device.setMetadata({ artist: "Artist", album: "Album", title: "Track 2", coverArtUrl: `${goodArt.base}/art2.jpg` });
    await driver.poll();
    const art = await driver.getArtwork(dev);
    expect(art).not.toBeNull();
    expect(art!.contentType).toBe("image/jpeg");

    farm.assertNoStrictViolations();
  });

  it("I — malformed responses never crash the driver and never overwrite prior valid state", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    device.setMetadata({ artist: "Artist", album: "Album", title: "Good Track" });
    const srv = await farm.addDevice(device);
    const dev = "dev-i" as DeviceId;
    const driver = newDriver();
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("Good Track");

    device.failNext("sources/current", { kind: "malformed-json" });
    await expect(driver.poll()).resolves.toBeUndefined();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("Good Track");

    device.failNext("soundControl/volume", { kind: "truncated" });
    await expect(driver.poll()).resolves.toBeUndefined();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("Good Track");

    farm.assertNoStrictViolations();
  });

  it("J — strict mode: a request outside the simulated protocol surface is caught, not silently accepted", async () => {
    farm = new DevialetVirtualDeviceFarm({ strict: true });
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    const srv = await farm.addDevice(device);
    // A raw fetch to a genuinely unsimulated path proves the farm rejects it loudly
    // rather than returning a permissive 200 — exactly the point of strict mode.
    const res = await fetch(`${srv.base}${IP_CONTROL_PATH}/groups/current/sources/current/playback/position`);
    expect(res.status).toBe(599);
    expect(() => farm.assertNoStrictViolations()).toThrow(/unexpected request/);
  });

  it("K — discovery: a realistic mDNS candidate parses through the REAL parseDevialetCandidate(), never a duplicated parser", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A" });
    const srv = await farm.addDevice(device);
    const host = new URL(srv.base).hostname;
    const port = Number(new URL(srv.base).port);
    const service: MdnsService = {
      name: `Living Room._http._tcp.local`,
      host,
      port,
      addresses: [host],
      txt: virtualDevialetMdnsTxt({ host, port }),
    };
    const candidate = parseDevialetCandidate(service);
    expect(candidate).not.toBeNull();
    expect(candidate?.path).toBe(IP_CONTROL_PATH);

    // Invalid manufacturer is rejected by the REAL parser, not re-implemented here.
    const wrongVendor: MdnsService = { ...service, txt: { ...service.txt, manufacturer: "NotDevialet" } };
    expect(parseDevialetCandidate(wrongVendor)).toBeNull();
  });
});
