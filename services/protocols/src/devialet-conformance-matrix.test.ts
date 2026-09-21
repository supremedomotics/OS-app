import type { DeviceId } from "@supreme/domain-model";
import { afterEach, describe, expect, it } from "vitest";
import { DevialetProtocolDriver } from "./devialet-driver.js";
import { parseDevialetCandidate } from "./devialet-discovery.js";
import type { MdnsService } from "./mdns.js";
import {
  DevialetVirtualDeviceFarm,
  VirtualDevialetDevice,
  virtualDevialetMdnsTxt,
  type VirtualLogicalErrorCode,
} from "./devialet-virtual-device.js";

/**
 * § D17 — the D12 Devialet R1 capability audit turned into an EXECUTABLE conformance
 * matrix. `DEVIALET_CONFORMANCE_MATRIX` below is the machine-readable record of what
 * D12 classified; the tests that follow prove the current driver's REAL wire/state
 * behavior against it using the D16 virtual device farm — never a second simulator.
 * A future driver change that silently expands/shrinks the supported surface should
 * make one of these tests fail (either a new strict-mode violation, or a matrix count
 * assertion drifting), not merely a documentation update.
 *
 * Classifications (unchanged from D12 — not re-litigated here):
 *   A = implemented · B = partially implemented · C = intentionally unsupported ·
 *   D = requires implementation · E = protocol ambiguous/unverified · F = not applicable
 */

export type ConformanceClassification = "A" | "B" | "C" | "D" | "E" | "F";

export interface ConformanceRow {
  capability: string;
  protocol: "R1" | "CISettings" | "discovery" | "topology";
  method?: "GET" | "POST";
  endpoint?: string;
  stateAffected?: string;
  classification: ConformanceClassification;
  notes: string;
}

export const DEVIALET_CONFORMANCE_MATRIX: ConformanceRow[] = [
  { capability: "device identity", protocol: "R1", method: "GET", endpoint: "/devices/current", stateAffected: "topology.devices[id]", classification: "A", notes: "deviceId/systemId?/groupId?/role?/deviceName" },
  { capability: "system identity", protocol: "R1", method: "GET", endpoint: "/systems/current", stateAffected: "topology.systems[id].systemName", classification: "A", notes: "systemId/groupId/systemName" },
  { capability: "system availableFeatures", protocol: "R1", method: "GET", endpoint: "/systems/current", classification: "B", notes: "parsed into DevialetSystemInfo, never read by the driver — no SupremeOS capability maps to it" },
  { capability: "volume (system)", protocol: "R1", method: "GET", endpoint: "/systems/current/sources/current/soundControl/volume", stateAffected: "media.volume", classification: "A", notes: "" },
  { capability: "volume (system)", protocol: "R1", method: "POST", endpoint: "/systems/current/sources/current/soundControl/volume", stateAffected: "media.volume", classification: "A", notes: "body {volume}" },
  { capability: "volumeUp/volumeDown", protocol: "R1", method: "POST", endpoint: "/systems/current/sources/current/soundControl/volume{Up,Down}", classification: "F", notes: "client methods exist, never called — no relative-volume MediaCommand action exists in domain-model" },
  { capability: "group sources", protocol: "R1", method: "GET", endpoint: "/groups/current/sources", classification: "A", notes: "used internally to resolve source name -> sourceId" },
  { capability: "current source / now playing", protocol: "R1", method: "GET", endpoint: "/groups/current/sources/current", stateAffected: "media.{source,playingState,muteState,metadata,availableOperations}", classification: "A", notes: "" },
  { capability: "play", protocol: "R1", method: "POST", endpoint: "/groups/current/sources/{sourceId}/playback/play", classification: "A", notes: "" },
  { capability: "pause / stop", protocol: "R1", method: "POST", endpoint: "/groups/current/sources/current/playback/pause", classification: "A", notes: "stop maps to pause, no distinct R1 endpoint" },
  { capability: "mute", protocol: "R1", method: "POST", endpoint: "/groups/current/sources/current/playback/mute", classification: "A", notes: "" },
  { capability: "unmute", protocol: "R1", method: "POST", endpoint: "/groups/current/sources/current/playback/unmute", classification: "A", notes: "" },
  { capability: "next", protocol: "R1", method: "POST", endpoint: "/groups/current/sources/current/playback/next", classification: "A", notes: "gated by availableOperations" },
  { capability: "previous", protocol: "R1", method: "POST", endpoint: "/groups/current/sources/current/playback/previous", classification: "A", notes: "gated by availableOperations" },
  { capability: "seek", protocol: "R1", classification: "E", notes: "availableOperations lists it as a value; no endpoint/payload documented anywhere" },
  { capability: "playback position", protocol: "R1", method: "GET", endpoint: "/groups/current/sources/current/playback/position", classification: "E", notes: "no schema documented; client returns raw JSON, never called by the driver" },
  { capability: "power", protocol: "R1", classification: "F", notes: "R1 documents no power endpoint at all" },
  { capability: "leader/master fields", protocol: "topology", classification: "E", notes: "concept named, no field/endpoint reports it; always null" },
  { capability: "topology derivation (Device->System->Group)", protocol: "topology", classification: "A", notes: "derived by aggregating /devices/current across bound devices; no membership endpoint exists" },
  { capability: "dynamic topology change detection", protocol: "topology", classification: "A", notes: "D11 piggybacked periodic sweep" },
  { capability: "CISettings volume", protocol: "CISettings", method: "GET", endpoint: "/cisettings/volume", classification: "C", notes: "reconciliation/diagnostic only, never authoritative" },
  { capability: "CISettings mutemode", protocol: "CISettings", method: "GET", endpoint: "/cisettings/mutemode", classification: "C", notes: "reconciliation/diagnostic only, never authoritative" },
  { capability: "CISettings source", protocol: "CISettings", method: "GET", endpoint: "/cisettings/source", classification: "C", notes: "reconciliation/diagnostic only, never authoritative" },
  { capability: "CISettings powerstate", protocol: "CISettings", method: "GET", endpoint: "/cisettings/powerstate", classification: "C", notes: "diagnostic-only read; never bound to a capability" },
  { capability: "CISettings internalstate", protocol: "CISettings", method: "GET", endpoint: "/cisettings/internalstate", classification: "A", notes: "diagnostic accessor, exercised by getCiSettingsInternalState()" },
  { capability: "CISettings power (write)", protocol: "CISettings", method: "POST", endpoint: "/cisettings/power", classification: "C", notes: "client method exists, never called — no confirmed read-back" },
  { capability: "CISettings getAll/getLean", protocol: "CISettings", classification: "E", notes: "URL path and response shape unverified; never called by the driver" },
  { capability: "CISettings EQ/bass/treble/tone/night-mode/etc.", protocol: "CISettings", classification: "C", notes: "doc's own §2 'not yet available' list — client structurally refuses to send" },
  { capability: "discovery — mDNS _http._tcp + TXT filter", protocol: "discovery", classification: "A", notes: "manufacturer=Devialet, ipControlVersion present, path present" },
  { capability: "discovery — /devices/current confirmation", protocol: "discovery", classification: "A", notes: "turns a transport candidate into an identified device" },
  { capability: "onoff / EQ / bass / treble / balance capability", protocol: "R1", classification: "F", notes: "no SupremeOS capability created for any of these — never exposed" },
];

const IP_CONTROL_PATH = "/ipcontrol/v1";

function summarize(matrix: ConformanceRow[]): Record<ConformanceClassification, number> {
  const counts: Record<ConformanceClassification, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  for (const row of matrix) counts[row.classification]++;
  return counts;
}

describe("Devialet R1/CISettings conformance matrix — machine-readable summary", () => {
  it("classification counts match the D12 audit exactly (no silent drift)", () => {
    // A change to these numbers means the SUPPORT SURFACE changed — investigate before
    // updating this assertion, never adjust it merely to make the test pass.
    expect(summarize(DEVIALET_CONFORMANCE_MATRIX)).toEqual({ A: 17, B: 1, C: 6, D: 0, E: 4, F: 3 });
  });

  it("no row is classified D (requires implementation) — D12/D17 found none", () => {
    expect(DEVIALET_CONFORMANCE_MATRIX.filter((r) => r.classification === "D")).toHaveLength(0);
  });
});

describe("Devialet conformance — wire/state proofs against the real DevialetProtocolDriver", () => {
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

  async function boundDriver(device: VirtualDevialetDevice, deviceId: DeviceId) {
    const srv = await farm.addDevice(device);
    const driver = newDriver();
    await driver.connect();
    await driver.bind({ deviceId, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    return driver;
  }

  it("device/system identity: /devices/current + /systems/current populate topology exactly as documented", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1", role: "Mono", systemName: "Living Room" });
    const dev = "dev-identity" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.refreshTopology();

    const topo = driver.getDeviceTopology(dev);
    expect(topo?.deviceId).toBe("A");
    expect(topo?.systemId).toBe("S1");
    expect(topo?.groupId).toBe("G1");
    expect(topo?.role).toBe("Mono");
    expect(driver.getTopologySnapshot().systems["S1"]?.systemName).toBe("Living Room");
    farm.assertNoStrictViolations();
  });

  it("volume request body is exactly {volume}: absolute POST, wire-verified via the virtual device's real mutation", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    const dev = "dev-vol-body" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.poll();

    await driver.command(dev, { capability: "media", action: "volume", volume: 42 } as never);
    // The virtual device only accepts a real {volume:number} body (see
    // devialet-virtual-device.ts's POST handler) — a wrong shape would leave
    // device.volume unchanged, so this IS a real body-shape proof, not just a 200.
    expect(device.volume).toBe(42);
    farm.assertNoStrictViolations();
  });

  it("source selection: command -> POST play({sourceId}) -> subsequent read reflects the REAL new source, never synthesized", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    device.setSource({ sourceId: "src-bt", deviceId: "A", type: "bluetooth" });
    const dev = "dev-source" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.poll();
    expect((driver.getState(dev, "media") as { source: string | null }).source).toBe("bluetooth");

    await driver.command(dev, { capability: "media", action: "source", source: "bluetooth" } as never);
    // Command completion does not itself publish state — only the next read does.
    await driver.poll();
    expect(device.playingState).toBe("playing");
    farm.assertNoStrictViolations();
  });

  it("availableOperations gating: next/previous allowed only when the virtual device's real list includes them", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    const dev = "dev-avail" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.poll();

    device.setAvailableOperations(["play", "pause", "next", "previous"]);
    await expect(driver.command(dev, { capability: "media", action: "next" } as never)).resolves.toBeUndefined();
    await expect(driver.command(dev, { capability: "media", action: "previous" } as never)).resolves.toBeUndefined();

    device.setAvailableOperations(["play", "pause"]);
    await expect(driver.command(dev, { capability: "media", action: "next" } as never)).rejects.toThrow(/availableOperations/);
    await expect(driver.command(dev, { capability: "media", action: "previous" } as never)).rejects.toThrow(/availableOperations/);
    farm.assertNoStrictViolations();
  });

  it("NoCurrentSource (permanent regression): confirmed answer -> idle/null fields; a transport failure never produces the same transition", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    const dev = "dev-ncs" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.poll();

    device.noCurrentSource = true;
    await driver.poll();
    const idle = driver.getState(dev, "media") as { playback: string; title: string | null; artist: string | null; album: string | null; source: string | null; muted: boolean };
    expect(idle.playback).toBe("idle");
    expect(idle.title).toBeNull();
    expect(idle.artist).toBeNull();
    expect(idle.album).toBeNull();
    expect(idle.source).toBeNull();

    device.noCurrentSource = false;
    device.setPlayback("playing");
    await driver.poll();
    expect((driver.getState(dev, "media") as { playback: string }).playback).toBe("playing");

    device.failNext("sources/current", { kind: "socket-reset" });
    await driver.poll();
    expect((driver.getState(dev, "media") as { playback: string }).playback).toBe("playing"); // never fabricated to idle
    farm.assertNoStrictViolations();
  });

  it.each([
    { desc: "full metadata", meta: { artist: "A", album: "B", title: "C" }, expectTitle: "C" },
    { desc: "metadata absent", meta: undefined, expectTitle: null },
    { desc: "metadata changes between polls", meta: { artist: "A2", album: "B2", title: "New Title" }, expectTitle: "New Title" },
  ])("media metadata: $desc", async ({ meta, expectTitle }) => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    device.setMetadata(meta);
    const dev = "dev-meta" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.poll();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe(expectTitle);
    farm.assertNoStrictViolations();
  });

  it("metadata while paused: playback and metadata are independently correct", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    device.setPlayback("paused");
    device.setMetadata({ artist: "Artist", album: "Album", title: "Paused Track" });
    const dev = "dev-paused-meta" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.poll();
    const state = driver.getState(dev, "media") as { playback: string; title: string | null };
    expect(state.playback).toBe("paused");
    expect(state.title).toBe("Paused Track");
    farm.assertNoStrictViolations();
  });

  it("artwork URL change is picked up on the next poll, never cached past a real change", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const artA = await farm.addArtworkServer({ bytes: Buffer.from([1]), contentType: "image/jpeg" });
    const artB = await farm.addArtworkServer({ bytes: Buffer.from([2]), contentType: "image/png" });
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    device.setMetadata({ artist: "A", album: "B", title: "T1", coverArtUrl: `${artA.base}/1.jpg` });
    const dev = "dev-art-change" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.poll();
    expect((await driver.getArtwork(dev))?.contentType).toBe("image/jpeg");

    device.setMetadata({ artist: "A", album: "B", title: "T2", coverArtUrl: `${artB.base}/2.png` });
    await driver.poll();
    expect((await driver.getArtwork(dev))?.contentType).toBe("image/png");
    farm.assertNoStrictViolations();
  });

  it("R1 vs CISettings authority: conflicting volume/mute/source never override R1's published state; CISettings unavailability never invalidates it", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    device.setVolume(30);
    device.setMuted(false);
    device.setSource({ sourceId: "s", deviceId: "A", type: "airplay2" });
    device.ciVolume = 70;
    device.ciMuteMode = true;
    device.ciSource = "bluetooth";
    const dev = "dev-authority" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.poll();

    let rows = await driver.getCiSettingsReconciliation(dev);
    expect(rows?.find((r) => r.field === "volume")).toMatchObject({ r1Value: 30, ciSettingsValue: 70, agree: false });
    expect(rows?.find((r) => r.field === "muted")).toMatchObject({ r1Value: false, ciSettingsValue: true, agree: false });
    expect(rows?.find((r) => r.field === "source")).toMatchObject({ r1Value: "airplay2", ciSettingsValue: "bluetooth", agree: false });
    let state = driver.getState(dev, "media") as { volume: number; muted: boolean; source: string | null };
    expect(state.volume).toBe(30);
    expect(state.muted).toBe(false);
    expect(state.source).toBe("airplay2");

    // CISettings becomes wholly unavailable — R1 media state must remain valid.
    device.failNext("/cisettings/", { kind: "http-status", status: 500 });
    device.failNext("/cisettings/", { kind: "http-status", status: 500 });
    device.failNext("/cisettings/", { kind: "http-status", status: 500 });
    rows = await driver.getCiSettingsReconciliation(dev);
    expect(rows?.every((r) => r.ciSettingsValue === null)).toBe(true);
    state = driver.getState(dev, "media") as { volume: number; muted: boolean; source: string | null };
    expect(state.volume).toBe(30);
    expect(state.muted).toBe(false);
    expect(state.source).toBe("airplay2");
    farm.assertNoStrictViolations();
  });

  it.each<{ code: VirtualLogicalErrorCode }>([
    { code: "UnreachableDevices" },
    { code: "Timeout" },
    { code: "InvalidValue" },
    { code: "SystemLeaderAbsent" },
    { code: "PlaybackNoStream" },
    { code: "Error" },
  ])("logical error conformance: $code never crashes poll() and preserves prior valid state", async ({ code }) => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    device.setMetadata({ artist: "A", album: "B", title: "Stable Track" });
    const dev = "dev-logical-err" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.poll();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("Stable Track");

    device.failNext("sources/current", { kind: "logical-error", code });
    await expect(driver.poll()).resolves.toBeUndefined();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("Stable Track");
    farm.assertNoStrictViolations();
  });

  it.each([400, 404, 415, 500])("HTTP %i error conformance: classified as a real failure, no crash, state preserved", async (status) => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    device.setVolume(55);
    const dev = "dev-http-err" as DeviceId;
    const driver = await boundDriver(device, dev);
    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(55);

    device.failNext("soundControl/volume", { kind: "http-status", status });
    await expect(driver.poll()).resolves.toBeUndefined();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(55);
    farm.assertNoStrictViolations();
  });

  it("discovery conformance: valid candidate + every documented negative case, via the REAL parseDevialetCandidate()", () => {
    const base: MdnsService = { name: "Living Room._http._tcp.local", host: "10.0.0.5", port: 80, addresses: ["10.0.0.5"], txt: virtualDevialetMdnsTxt({ host: "10.0.0.5", port: 80 }) };
    expect(parseDevialetCandidate(base)).not.toBeNull();

    expect(parseDevialetCandidate({ ...base, txt: { ...base.txt, manufacturer: "SomeOtherBrand" } })).toBeNull();
    const { ipControlVersion: _iv, ...withoutVersion } = base.txt;
    expect(parseDevialetCandidate({ ...base, txt: withoutVersion })).toBeNull();
    const { path: _p, ...withoutPath } = base.txt;
    expect(parseDevialetCandidate({ ...base, txt: withoutPath })).toBeNull();
    expect(parseDevialetCandidate({ ...base, addresses: [] })).toBeNull();
    expect(parseDevialetCandidate({ ...base, port: 0 })).toBeNull();
    expect(parseDevialetCandidate({ ...base, port: -1 })).toBeNull();
  });

  it("device confirmation failure: a discovery candidate whose /devices/current query fails is simply omitted, never a fabricated identity", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const device = new VirtualDevialetDevice({ deviceId: "A" });
    device.failNext("/devices/current", { kind: "socket-reset" });
    const srv = await farm.addDevice(device);
    const driver = newDriver({ mdns: async () => [{ name: "Living Room._http._tcp.local", host: new URL(srv.base).hostname, port: Number(new URL(srv.base).port), addresses: [new URL(srv.base).hostname], txt: virtualDevialetMdnsTxt({ host: "x", port: 1 }) }] });
    await driver.connect();
    const found = await driver.discover();
    expect(found).toHaveLength(0); // confirmation failed — never a partial/fabricated result
  });

  it("capability surface guard: only 'media' is ever published — no onoff/power/seek/EQ state exists after a full realistic lifecycle", async () => {
    farm = new DevialetVirtualDeviceFarm();
    const a = new VirtualDevialetDevice({ deviceId: "A", systemId: "S1", groupId: "G1" });
    const devA = "dev-guard-a" as DeviceId;
    const driver = await boundDriver(a, devA);
    await driver.poll();
    await driver.refreshTopology();
    await driver.command(devA, { capability: "media", action: "volume", volume: 20 } as never);
    await driver.command(devA, { capability: "media", action: "pause" } as never);
    await driver.command(devA, { capability: "media", action: "mute" } as never);
    await driver.getCiSettingsReconciliation(devA);
    await driver.getCiSettingsPowerState(devA);
    await driver.poll();

    expect(driver.getState(devA, "media")).not.toBeNull();
    expect(driver.getState(devA, "onoff")).toBeNull();
    // Every real request this entire lifecycle issued stayed inside the simulated,
    // documented protocol surface — a silent expansion into seek/power/EQ/etc. would
    // have shown up as a strict-mode violation here.
    farm.assertNoStrictViolations();
  });
});
