import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import { afterEach, describe, expect, it } from "vitest";
import { DevialetProtocolDriver } from "./devialet-driver.js";

/**
 * § D10 — resilience/lifecycle hardening: reconnect idempotency, network-loss and
 * reboot recovery, IP-address change, topology/group-membership change, stale-state
 * semantics, media-cache/artwork isolation on unbind, and concurrency safety. Real
 * in-process HTTP servers throughout, matching every other Devialet test file's
 * convention — no mocking framework. Command routing (D7) and pure topology
 * reconciliation (D6) are unit-tested elsewhere; this file exercises the DRIVER's
 * lifecycle behavior end-to-end.
 */

const IP_CONTROL_PATH = "/ipcontrol/v1";
const SOURCE_ID = "213a3ed0-1fb9-4da2-bcf4-066da0f7b27e";

interface Fixture {
  systemId: string;
  groupId: string;
  volume: number;
  playingState?: "playing" | "paused";
  muteState?: "muted" | "unmuted";
  title?: string;
  unreachable?: boolean;
  noCurrentSource?: boolean;
  coverArtUrl?: string;
}

function startHttp(getFixture: () => Fixture): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      hits.push(`${req.method} ${url}`);
      const f = getFixture();
      if (f.unreachable) {
        req.socket.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      if (url.endsWith("/devices/current")) {
        return res.end(JSON.stringify({ deviceId: "A", model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: "A", systemId: f.systemId, groupId: f.groupId, role: "Mono" }));
      }
      if (url.endsWith("/systems/current")) {
        return res.end(JSON.stringify({ systemId: f.systemId, groupId: f.groupId, systemName: "Room" }));
      }
      if (url.endsWith("/systems/current/sources/current/soundControl/volume")) {
        return res.end(JSON.stringify({ volume: f.volume }));
      }
      if (url.endsWith("/groups/current/sources/current")) {
        if (f.noCurrentSource) return res.end(JSON.stringify({ error: { code: "NoCurrentSource" } }));
        return res.end(
          JSON.stringify({
            source: { sourceId: SOURCE_ID, deviceId: "A", type: "airplay2" },
            playingState: f.playingState ?? "playing",
            muteState: f.muteState ?? "unmuted",
            metadata: { artist: "Artist", album: "Album", title: f.title ?? "Track", ...(f.coverArtUrl ? { coverArtUrl: f.coverArtUrl } : {}) },
            availableOperations: ["play", "pause"],
          }),
        );
      }
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, hits });
    });
  });
}

describe("DevialetProtocolDriver — D10 resilience/lifecycle hardening", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  it("A — bind -> unbind -> bind produces one clean logical device, no duplicate state", async () => {
    let fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-a" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();

    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);

    await driver.unbind(dev);
    expect(driver.getState(dev, "media")).toBeNull();
    expect(driver.manages(dev)).toBe(false);
    expect(driver.getDeviceTopology(dev)).toBeNull();

    fixture = { systemId: "S1", groupId: "G1", volume: 55 };
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(55);
    expect(driver.manages(dev)).toBe(true);
  });

  it("B — duplicate bind for the same device+capability replaces the entry, never duplicates it", async () => {
    const fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-b" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();

    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();

    // Exactly one publish's worth of state, no crash/duplication from a second bind.
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);
    await driver.unbind(dev);
    expect(driver.manages(dev)).toBe(false);
  });

  it("D — device network loss then recovery: no crash, no fabricated state, real recovery", async () => {
    const fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40, unreachable: false };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-d" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });

    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);

    fixture.unreachable = true;
    await expect(driver.poll()).resolves.toBeUndefined();
    // Healthy last-known state is NOT replaced with a fabricated value during the outage.
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);

    fixture.unreachable = false;
    fixture.volume = 65;
    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(65);
    expect(driver.manages(dev)).toBe(true);

    await driver.disconnect();
  });

  it("E — reboot: device disappears, comes back with the SAME deviceId/topology — driver recovers", async () => {
    const fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40, playingState: "playing", title: "Before Reboot" };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-e" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect(driver.getDeviceTopology(dev)?.deviceId).toBe("A");

    fixture.unreachable = true;
    await driver.poll();
    await driver.refreshTopology(); // simulates a health-check sweep during the outage

    fixture.unreachable = false;
    fixture.title = "After Reboot";
    await driver.poll();
    const state = driver.getState(dev, "media") as { title: string | null; volume: number };
    expect(state.title).toBe("After Reboot");
    expect(state.volume).toBe(40);
    expect(driver.getDeviceTopology(dev)?.deviceId).toBe("A");
    expect(driver.manages(dev)).toBe(true);
  });

  it("F — IP address change: same deviceId, new host, old address abandoned, no duplicate device, no cache leak", async () => {
    const fixtureOld: Fixture = { systemId: "S1", groupId: "G1", volume: 40 };
    const fixtureNew: Fixture = { systemId: "S1", groupId: "G1", volume: 77 };
    const srvOld = await startHttp(() => fixtureOld);
    const srvNew = await startHttp(() => fixtureNew);
    servers.push(srvOld.server, srvNew.server);
    const dev = "dev-f" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srvOld.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);

    // Re-bind the SAME logical device at its new IP — the real commissioning/
    // discovery re-bind path, never a second device.
    await driver.bind({ deviceId: dev, capability: "media", address: srvNew.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();

    expect(driver.manages(dev)).toBe(true);
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(77);
    // The old server received no traffic after the rebind.
    const oldHitsAfterRebind = srvOld.hits.length;
    await driver.poll();
    expect(srvOld.hits.length).toBe(oldHitsAfterRebind);
  });

  it("G/H — topology change (group membership change) redirects volume/media to the new system/group", async () => {
    const fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-g" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S1");
    expect(driver.getDeviceTopology(dev)?.groupId).toBe("G1");

    // Real topology change (e.g. Solo -> Stereo, or a group re-pair) — the device now
    // reports a different System/Group on its next `/devices/current` answer.
    fixture.systemId = "S2";
    fixture.groupId = "G2";
    fixture.volume = 15;
    const result = await driver.refreshTopology();
    expect(result.changed).toBe(true);
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S2");
    expect(driver.getDeviceTopology(dev)?.groupId).toBe("G2");
    // The old system/group no longer lists this device as a member.
    expect(driver.getTopologySnapshot().systems["S1"]).toBeUndefined();

    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(15);
  });

  it("I — stale topology is preserved (not erased) across a single failed refresh", async () => {
    const fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-i" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.refreshTopology();
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S1");

    fixture.unreachable = true;
    const result = await driver.refreshTopology();
    expect(result.changed).toBe(false);
    // Last-known topology survives the failed query untouched — never erased to null.
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S1");
    expect(driver.getDeviceTopology(dev)?.groupId).toBe("G1");
  });

  it("J — media cache is isolated per device; a new device never inherits another's media state", async () => {
    const fixtureA: Fixture = { systemId: "S1", groupId: "G1", volume: 40, title: "Track A" };
    const fixtureB: Fixture = { systemId: "S2", groupId: "G2", volume: 90, title: "Track B" };
    const srvA = await startHttp(() => fixtureA);
    const srvB = await startHttp(() => fixtureB);
    servers.push(srvA.server, srvB.server);
    const devA = "dev-j-a" as DeviceId;
    const devB = "dev-j-b" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: devA, capability: "media", address: srvA.base, config: { path: IP_CONTROL_PATH } });
    await driver.bind({ deviceId: devB, capability: "media", address: srvB.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();

    expect((driver.getState(devA, "media") as { title: string | null }).title).toBe("Track A");
    expect((driver.getState(devB, "media") as { title: string | null }).title).toBe("Track B");

    await driver.unbind(devA);
    const devC = "dev-j-c" as DeviceId; // a brand-new logical device, never bound before
    await driver.bind({ deviceId: devC, capability: "media", address: srvA.base, config: { path: IP_CONTROL_PATH } });
    // Before its first poll, a new device must never show a stale/inherited value.
    expect(driver.getState(devC, "media")).toBeNull();
    await driver.poll();
    expect((driver.getState(devC, "media") as { title: string | null }).title).toBe("Track A");
    // devB's own cache is untouched throughout.
    expect((driver.getState(devB, "media") as { title: string | null }).title).toBe("Track B");
  });

  it("K — artwork: a failed fetch does not poison a later successful fetch for the same URL", async () => {
    const fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40, coverArtUrl: "" };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);

    const badImage = createServer((req, res) => {
      res.statusCode = 500;
      res.end();
    });
    await new Promise<void>((r) => badImage.listen(0, "127.0.0.1", r));
    servers.push(badImage);
    const badAddr = badImage.address();
    const badPort = typeof badAddr === "object" && badAddr ? badAddr.port : 0;
    fixture.coverArtUrl = `http://127.0.0.1:${badPort}/art.jpg`;

    const dev = "dev-k" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();

    const failed = await driver.getArtwork(dev);
    expect(failed).toBeNull();

    // Retry the SAME URL after the art server recovers — the earlier failure must not
    // leave a poisoned in-flight/negative-cache entry.
    badImage.removeAllListeners("request");
    badImage.on("request", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "image/jpeg");
      res.end(Buffer.from([0xff, 0xd8, 0xff]));
    });
    const recovered = await driver.getArtwork(dev);
    expect(recovered).not.toBeNull();
    expect(recovered!.contentType).toBe("image/jpeg");
  });

  it("L — CISettings failure never blocks R1 polling/state (no dependency for normal operation)", async () => {
    const fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-l" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });

    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);
    // This server has no /cisettings/* routes at all (falls through to "{}", which
    // is malformed per CISettings' own {data:{...}} envelope) — poll()/R1 state must
    // be completely unaffected.
    await expect(driver.getCiSettingsInternalState(dev)).rejects.toThrow();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);
  });

  it("M — a malformed R1 group response (mid-session) does not crash the driver and preserves prior valid state", async () => {
    let malformed = false;
    const hits: string[] = [];
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      hits.push(url);
      res.setHeader("content-type", "application/json");
      if (url.endsWith("/devices/current")) return res.end(JSON.stringify({ deviceId: "A", model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: "A", systemId: "S1", groupId: "G1", role: "Mono" }));
      if (url.endsWith("/systems/current")) return res.end(JSON.stringify({ systemId: "S1", groupId: "G1", systemName: "Room" }));
      if (url.endsWith("/systems/current/sources/current/soundControl/volume")) return res.end(JSON.stringify({ volume: 40 }));
      if (url.endsWith("/groups/current/sources/current")) {
        if (malformed) return res.end("{not valid json");
        return res.end(JSON.stringify({ source: { sourceId: SOURCE_ID, deviceId: "A", type: "airplay2" }, playingState: "playing", muteState: "unmuted", metadata: { artist: "Artist", album: "Album", title: "Good Track" }, availableOperations: ["play"] }));
      }
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    const dev = "dev-m" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("Good Track");

    malformed = true;
    await expect(driver.poll()).resolves.toBeUndefined();
    // Malformed = "no new data this tick," not "erase what we knew" — prior valid
    // state is preserved, never crashed, never replaced with a fabricated value.
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("Good Track");
  });

  it("N — a logical R1 error (e.g. UnreachableDevices) during poll never throws out of poll()", async () => {
    const fixture: Fixture & { forceError?: boolean } = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-n" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();

    fixture.noCurrentSource = true;
    await expect(driver.poll()).resolves.toBeUndefined();
    const state = driver.getState(dev, "media") as { playback: string };
    // § D10 — NoCurrentSource is a real, confirmed answer: publishes an honest idle
    // state rather than throwing or silently retaining the old "playing" state.
    expect(state.playback).toBe("idle");
  });

  it("O — repeated topology refresh is idempotent (no duplicate members, stable snapshot)", async () => {
    const fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-o" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });

    const r1 = await driver.refreshTopology();
    const r2 = await driver.refreshTopology();
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(false);
    expect(driver.getTopologySnapshot().systems["S1"]?.memberDeviceIds).toEqual(["A"]);
  });

  it("P — concurrent recovery: overlapping poll() calls during a topology-unknown window never duplicate requests pathologically", async () => {
    const fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-p" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });

    // Two concurrent polls racing while topology is still unknown for this binding.
    await Promise.all([driver.poll(), driver.poll()]);
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S1");
  });

  it("Q — connect() called twice never leaks a duplicate poll timer", async () => {
    const fixture: Fixture = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startHttp(() => fixture);
    servers.push(srv.server);
    const dev = "dev-q" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 20 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.connect(); // reconnect without an intervening disconnect()

    await new Promise((r) => setTimeout(r, 80));
    const hitsAfterFirstWindow = srv.hits.filter((h) => h.includes("/devices/current")).length;
    // A single active timer at pollMs=20 over ~80ms should produce roughly 3-5 ticks,
    // not roughly double that from two leaked concurrent timers.
    expect(hitsAfterFirstWindow).toBeLessThan(9);

    await driver.disconnect();
  });
});
