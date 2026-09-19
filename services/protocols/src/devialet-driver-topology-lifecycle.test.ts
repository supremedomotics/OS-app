import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import { afterEach, describe, expect, it } from "vitest";
import { DevialetProtocolDriver, DevialetCommandRoutingError } from "./devialet-driver.js";

/**
 * § D7 patch — closes the real lifecycle gap verified by direct call-path
 * inspection (gateway → SIL → adapter → `driver.command()` never invokes
 * `refreshTopology()`, and nothing else does either). These tests represent the
 * ACTUAL SupremeOS lifecycle — `bind()` immediately followed by `command()`, with NO
 * manual `refreshTopology()` call — which is exactly the sequence that would have
 * failed under the pre-patch D7 implementation and must now succeed via one
 * on-demand, single-binding topology resolution inside `command()` itself.
 *
 * Pure command-routing logic is unchanged and untested again here — see
 * `devialet-command-routing.test.ts`. Topology-aware routing against an ALREADY-
 * refreshed topology is unchanged and untested again here — see
 * `devialet-driver-command-routing.test.ts`. This file is specifically about the
 * lifecycle gap: command() with NO prior refreshTopology() call.
 */

const IP_CONTROL_PATH = "/ipcontrol/v1";
const SOURCE_ID = "213a3ed0-1fb9-4da2-bcf4-066da0f7b27e";

function startHttp(handler: (url: string, method: string) => { status?: number; body?: string }): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const out = handler(req.url ?? "", req.method ?? "GET");
      res.statusCode = out.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(out.body ?? "{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, hits });
    });
  });
}

function bindAddress(base: string) {
  return { address: base, config: { path: IP_CONTROL_PATH } };
}

function deviceServer(deviceId: string, system: { systemId: string; groupId: string; role: string } | null) {
  return (url: string) => {
    if (url.endsWith("/devices/current")) {
      return {
        body: JSON.stringify({
          deviceId,
          model: "Phantom I",
          release: { version: "2.14.2" },
          serial: "S1",
          deviceName: deviceId,
          ...(system ? { systemId: system.systemId, groupId: system.groupId, role: system.role } : {}),
        }),
      };
    }
    if (url.endsWith("/systems/current") && system) {
      return { body: JSON.stringify({ systemId: system.systemId, groupId: system.groupId, systemName: `${deviceId}'s room` }) };
    }
    if (url.endsWith("/systems/current/sources/current/soundControl/volume")) {
      return { body: JSON.stringify({ volume: 50 }) };
    }
    if (url.endsWith("/groups/current/sources/current")) {
      return { body: JSON.stringify({ source: { sourceId: SOURCE_ID, deviceId, type: "spotifyconnect" }, playingState: "playing", muteState: "unmuted", availableOperations: ["play", "pause"] }) };
    }
    return { body: "{}" };
  };
}

describe("DevialetProtocolDriver — D7 patch: real lifecycle (bind -> command, no manual refreshTopology())", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  it("A/B — a SYSTEM-level command (volume) issued immediately after bind() self-resolves topology and executes exactly once", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });
    // No refreshTopology() call — this is the actual gateway call path.

    await driver.command(dev, { capability: "media", action: "volume", volume: 40 });
    expect(srv.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume"))).toHaveLength(1);
    expect(driver.getDeviceTopology(dev)).toMatchObject({ deviceId: "A", systemId: "S1", groupId: "G1" });

    await driver.disconnect();
  });

  it("A/C — a GROUP-level command (play) issued immediately after bind() self-resolves topology and executes exactly once", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    await driver.command(dev, { capability: "media", action: "play" });
    expect(srv.hits.filter((h) => h.includes("/playback/play"))).toHaveLength(1);

    await driver.disconnect();
  });

  it("D — if R1 genuinely reports no groupId even after the on-demand refresh, a group-level command fails with a routing error and sends no command request", async () => {
    const srv = await startHttp((url) => {
      if (url.endsWith("/devices/current")) return { body: JSON.stringify({ deviceId: "A", model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: "A", systemId: "S1" }) }; // no groupId, ever
      if (url.endsWith("/systems/current")) return { body: JSON.stringify({ systemId: "S1", groupId: "G1", systemName: "A" }) };
      return { body: "{}" };
    });
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    const err = await driver.command(dev, { capability: "media", action: "play" }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCommandRoutingError);
    expect((err as DevialetCommandRoutingError).reason).toBe("topology-unavailable");
    expect(srv.hits.some((h) => h.includes("/playback/"))).toBe(false); // no command request was ever sent
    // Exactly one on-demand devices/current query for this command (§K).
    expect(srv.hits.filter((h) => h.endsWith("/devices/current"))).toHaveLength(1);

    await driver.disconnect();
  });

  it("E — a topology refresh failure (R1 unreachable) sends no command request", async () => {
    const dev = "device-a" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: "http://127.0.0.1:1", config: { path: IP_CONTROL_PATH } });

    const err = await driver.command(dev, { capability: "media", action: "volume", volume: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCommandRoutingError);
    expect((err as DevialetCommandRoutingError).reason).toBe("identity-unknown");

    await driver.disconnect();
  });

  it("F — when topology is ALREADY known (a prior command or refreshTopology() already resolved it), a subsequent command performs NO additional topology query", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    await driver.command(dev, { capability: "media", action: "volume", volume: 10 }); // self-resolves topology
    const devicesCurrentHitsAfterFirst = srv.hits.filter((h) => h.endsWith("/devices/current")).length;
    expect(devicesCurrentHitsAfterFirst).toBe(1);

    await driver.command(dev, { capability: "media", action: "volume", volume: 20 }); // topology already known
    const devicesCurrentHitsAfterSecond = srv.hits.filter((h) => h.endsWith("/devices/current")).length;
    expect(devicesCurrentHitsAfterSecond).toBe(1); // unchanged — no second topology query

    await driver.disconnect();
  });

  it("G — partial topology self-resolved on demand: system known, group unknown — volume succeeds, play fails after exactly one refresh", async () => {
    const srv = await startHttp((url) => {
      if (url.endsWith("/devices/current")) return { body: JSON.stringify({ deviceId: "A", model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: "A", systemId: "S1" }) };
      if (url.endsWith("/systems/current")) return { body: JSON.stringify({ systemId: "S1", groupId: "G1", systemName: "A" }) };
      if (url.endsWith("/systems/current/sources/current/soundControl/volume")) return { body: JSON.stringify({ volume: 30 }) };
      return { body: "{}" };
    });
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    await expect(driver.command(dev, { capability: "media", action: "volume", volume: 40 })).resolves.toBeUndefined();

    const err = await driver.command(dev, { capability: "media", action: "play" }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCommandRoutingError);
    expect((err as DevialetCommandRoutingError).reason).toBe("topology-unavailable");

    await driver.disconnect();
  });

  it("H — two driver instances remain isolated through the on-demand lifecycle path", async () => {
    const srv1 = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    const srv2 = await startHttp(deviceServer("A", { systemId: "S9", groupId: "G9", role: "Mono" }));
    servers.push(srv1.server, srv2.server);
    const dev = "device-a" as DeviceId;
    const driver1 = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    const driver2 = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver1.connect();
    await driver2.connect();
    await driver1.bind({ deviceId: dev, capability: "media", ...bindAddress(srv1.base) });
    await driver2.bind({ deviceId: dev, capability: "media", ...bindAddress(srv2.base) });

    await driver1.command(dev, { capability: "media", action: "volume", volume: 10 });
    expect(srv1.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume"))).toHaveLength(1);
    expect(srv2.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume"))).toHaveLength(0);
    expect(driver1.getDeviceTopology(dev)).toMatchObject({ systemId: "S1" });
    expect(driver2.getDeviceTopology(dev)).toBeNull(); // never touched

    await driver1.disconnect();
    await driver2.disconnect();
  });

  it("I — a stereo pair, both commanded via the on-demand lifecycle path, never produces a duplicated command to the other member", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "FrontLeft" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S1", groupId: "G1", role: "FrontRight" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const devA = "device-a" as DeviceId;
    const devB = "device-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: devB, capability: "media", ...bindAddress(srvB.base) });

    await driver.command(devA, { capability: "media", action: "play" }); // no prior refreshTopology()
    const totalPlayRequests = srvA.hits.filter((h) => h.includes("/playback/play")).length + srvB.hits.filter((h) => h.includes("/playback/play")).length;
    expect(totalPlayRequests).toBe(1);

    await driver.disconnect();
  });

  it("J — command() still never writes speculative state through the on-demand lifecycle path", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    expect(driver.getState(dev, "media")).toBeNull();
    await driver.command(dev, { capability: "media", action: "volume", volume: 40 });
    expect(driver.getState(dev, "media")).toBeNull(); // still no speculative write

    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(50); // real device value from deviceServer's fixed 50, not 40

    await driver.disconnect();
  });

  it("K — at most one on-demand topology query per command, even for concurrent commands against the same binding (coalesced, not duplicated)", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    // Two commands fired concurrently before either has resolved topology.
    await Promise.all([
      driver.command(dev, { capability: "media", action: "volume", volume: 10 }),
      driver.command(dev, { capability: "media", action: "mute" }),
    ]);
    // Exactly one /devices/current query was needed to resolve topology for both —
    // the in-flight refresh was coalesced, not duplicated.
    expect(srv.hits.filter((h) => h.endsWith("/devices/current"))).toHaveLength(1);

    await driver.disconnect();
  });

  it("L — the existing refreshTopology() sweep still works normally alongside the new on-demand path", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    const result = await driver.refreshTopology();
    expect(result.changed).toBe(true);
    expect(driver.getTopologySnapshot().devices.A).toMatchObject({ systemId: "S1", groupId: "G1" });

    // A command afterward performs no additional topology query.
    await driver.command(dev, { capability: "media", action: "volume", volume: 15 });
    expect(srv.hits.filter((h) => h.endsWith("/devices/current"))).toHaveLength(1);

    await driver.disconnect();
  });
});
