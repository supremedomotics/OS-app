import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import { afterEach, describe, expect, it } from "vitest";
import { DevialetProtocolDriver, DevialetCommandRoutingError, DevialetOperationUnavailableError, DevialetApiError } from "./devialet-driver.js";

/**
 * § D7 — driver-level command-routing integration tests: `command()` against real
 * `/systems/current/...`/`/groups/current/...` endpoints via a real in-process HTTP
 * server, after real `refreshTopology()` reconciliation. Pure routing-algorithm
 * coverage lives in `devialet-command-routing.test.ts` — this file proves the DRIVER
 * wires topology-aware routing into `command()` correctly, and — most importantly —
 * that a stereo pair NEVER receives a duplicated command (§29 of the D7 brief's
 * mandatory negative test).
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

/** A fake Devialet unit answering /devices/current, /systems/current, group sources/
 * playback, and system volume. `system: null` means an accessory (no systemId/
 * groupId at all). `availableOperations` defaults to the full documented set. */
function deviceServer(
  deviceId: string,
  system: { systemId: string; groupId: string; role: string } | null,
  opts: { volume?: number; availableOperations?: string[] } = {},
) {
  const volume = opts.volume ?? 50;
  const availableOperations = opts.availableOperations ?? ["play", "pause", "next", "previous"];
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
      return { body: JSON.stringify({ volume }) };
    }
    if (url.endsWith("/groups/current/sources/current")) {
      return {
        body: JSON.stringify({
          source: { sourceId: SOURCE_ID, deviceId, type: "spotifyconnect" },
          playingState: "playing",
          muteState: "unmuted",
          availableOperations,
        }),
      };
    }
    if (url.endsWith("/groups/current/sources")) {
      return { body: JSON.stringify({ sources: [{ sourceId: SOURCE_ID, deviceId, type: "spotifyconnect" }, { sourceId: "bt-source-id", deviceId, type: "bluetooth" }] }) };
    }
    return { body: "{}" };
  };
}

async function boundDriver(srv: Awaited<ReturnType<typeof startHttp>>, dev: DeviceId, driver = new DevialetProtocolDriver({ pollMs: 1_000_000 })) {
  await driver.connect();
  await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });
  return driver;
}

describe("DevialetProtocolDriver — D7 topology-aware command routing", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  it("A — single-device system command (volume) succeeds once topology is known", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    await driver.command(dev, { capability: "media", action: "volume", volume: 40 });
    const volumeHits = srv.hits.filter((h) => h.includes("/soundControl/volume") && h.startsWith("POST"));
    expect(volumeHits).toHaveLength(1);

    await driver.disconnect();
  });

  it("B — single-device group playback command (next) succeeds once topology is known", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    await driver.command(dev, { capability: "media", action: "next" });
    expect(srv.hits.filter((h) => h.includes("/playback/next"))).toHaveLength(1);

    await driver.disconnect();
  });

  it("C/D/U/V — a stereo pair: volume(A) and play(A) each issue EXACTLY ONE real HTTP operation — never a second request to B", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "FrontLeft" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S1", groupId: "G1", role: "FrontRight" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const devA = "device-a" as DeviceId;
    const devB = "device-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: devB, capability: "media", ...bindAddress(srvB.base) });
    await driver.refreshTopology();

    await driver.command(devA, { capability: "media", action: "volume", volume: 40 });
    expect(srvA.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume"))).toHaveLength(1);
    expect(srvB.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume"))).toHaveLength(0);

    await driver.command(devA, { capability: "media", action: "play" });
    expect(srvA.hits.filter((h) => h.includes("/playback/play"))).toHaveLength(1);
    expect(srvB.hits.filter((h) => h.includes("/playback/play"))).toHaveLength(0);

    await driver.disconnect();
  });

  it("D (§29 mandatory negative test, worded exactly as the brief) — play(A) never produces play(A)+play(B)", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "FrontLeft" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S1", groupId: "G1", role: "FrontRight" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: "device-a" as DeviceId, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: "device-b" as DeviceId, capability: "media", ...bindAddress(srvB.base) });
    await driver.refreshTopology();

    await driver.command("device-a" as DeviceId, { capability: "media", action: "play" });
    const totalPlayRequests = srvA.hits.filter((h) => h.includes("/playback/play")).length + srvB.hits.filter((h) => h.includes("/playback/play")).length;
    expect(totalPlayRequests).toBe(1);

    await driver.disconnect();
  });

  it("D (volume variant) — volume(A,40) issues exactly one system-level volume request across the whole installation", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "FrontLeft" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S1", groupId: "G1", role: "FrontRight" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: "device-a" as DeviceId, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: "device-b" as DeviceId, capability: "media", ...bindAddress(srvB.base) });
    await driver.refreshTopology();

    await driver.command("device-a" as DeviceId, { capability: "media", action: "volume", volume: 40 });
    const totalVolumeRequests =
      srvA.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume")).length +
      srvB.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume")).length;
    expect(totalVolumeRequests).toBe(1);

    await driver.disconnect();
  });

  it("E — two independent systems in one group: volume routes per-system, playback routes to the shared group (both devices reachable independently)", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S2", groupId: "G1", role: "Mono" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const devA = "device-a" as DeviceId;
    const devB = "device-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: devB, capability: "media", ...bindAddress(srvB.base) });
    await driver.refreshTopology();
    expect(driver.getTopologySnapshot().groups.G1!.memberSystemIds).toEqual(["S1", "S2"]);

    await driver.command(devA, { capability: "media", action: "volume", volume: 40 });
    expect(srvA.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume"))).toHaveLength(1);
    expect(srvB.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume"))).toHaveLength(0);

    await driver.command(devB, { capability: "media", action: "pause" });
    expect(srvB.hits.filter((h) => h.includes("/playback/pause"))).toHaveLength(1);
    expect(srvA.hits.filter((h) => h.includes("/playback/pause"))).toHaveLength(0);

    await driver.disconnect();
  });

  it("F/H/W/X — after a system+group id change, refreshTopology() picks up the new ids and command() uses CURRENT topology, never stale cached ids", async () => {
    let systemId = "S1";
    let groupId = "G1";
    const srv = await startHttp((url) => deviceServer("A", { systemId, groupId, role: "Mono" })(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();
    await driver.command(dev, { capability: "media", action: "volume", volume: 10 });
    expect(driver.getDeviceTopology(dev)).toMatchObject({ systemId: "S1", groupId: "G1" });

    systemId = "S2";
    groupId = "G2";
    await driver.refreshTopology();
    expect(driver.getDeviceTopology(dev)).toMatchObject({ systemId: "S2", groupId: "G2" });
    // Command still succeeds — routing consulted the FRESH topology, not a cached id.
    await expect(driver.command(dev, { capability: "media", action: "volume", volume: 20 })).resolves.toBeUndefined();

    await driver.disconnect();
  });

  it("G — group id change alone (system unchanged) is picked up by command routing", async () => {
    let groupId = "G1";
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId, role: "Mono" })(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();
    expect(driver.getDeviceTopology(dev)!.groupId).toBe("G1");

    groupId = "G2";
    await driver.refreshTopology();
    expect(driver.getDeviceTopology(dev)!.groupId).toBe("G2");
    await expect(driver.command(dev, { capability: "media", action: "pause" })).resolves.toBeUndefined();

    await driver.disconnect();
  });

  it("I — a device whose topology genuinely cannot be resolved (R1 unreachable even for the on-demand attempt) fails command() with a structured DevialetCommandRoutingError, never a fabricated target", async () => {
    // § D7 patch — command() now self-heals via one on-demand refresh when a real
    // R1 server IS reachable (see the new "lifecycle gap" tests below), so this
    // negative case needs a device whose identity genuinely can't be established
    // even by that on-demand attempt.
    const dev = "device-a" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: "http://127.0.0.1:1", config: { path: IP_CONTROL_PATH } });
    // Deliberately do NOT call refreshTopology().

    const err = await driver.command(dev, { capability: "media", action: "volume", volume: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCommandRoutingError);
    expect((err as DevialetCommandRoutingError).level).toBe("system");
    expect((err as DevialetCommandRoutingError).reason).toBe("identity-unknown");

    await driver.disconnect();
  });

  it("J — partial topology: system known, group unknown — system-level command succeeds, group-level command fails cleanly", async () => {
    const srv = await startHttp((url) => {
      if (url.endsWith("/devices/current")) {
        return { body: JSON.stringify({ deviceId: "A", model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: "A", systemId: "S1" }) }; // no groupId
      }
      if (url.endsWith("/systems/current")) return { body: JSON.stringify({ systemId: "S1", groupId: "G1", systemName: "A's room" }) };
      if (url.endsWith("/systems/current/sources/current/soundControl/volume")) return { body: JSON.stringify({ volume: 30 }) };
      return { body: "{}" };
    });
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();
    expect(driver.getDeviceTopology(dev)).toMatchObject({ systemId: "S1", groupId: null });

    await expect(driver.command(dev, { capability: "media", action: "volume", volume: 40 })).resolves.toBeUndefined();

    const err = await driver.command(dev, { capability: "media", action: "play" }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCommandRoutingError);
    expect((err as DevialetCommandRoutingError).level).toBe("group");
    expect((err as DevialetCommandRoutingError).reason).toBe("topology-unavailable");

    await driver.disconnect();
  });

  it("K — a device that was unbound can no longer be commanded (existing not-bound guard, unaffected by D7)", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();
    await driver.unbind(dev);

    await expect(driver.command(dev, { capability: "media", action: "volume", volume: 10 })).rejects.toThrow(/not bound/);

    await driver.disconnect();
  });

  it("L — availableOperations rejects an unsupported playback operation (next) without sending it", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { availableOperations: ["play", "pause"] }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    const err = await driver.command(dev, { capability: "media", action: "next" }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetOperationUnavailableError);
    expect(srv.hits.filter((h) => h.includes("/playback/next"))).toHaveLength(0);

    await driver.disconnect();
  });

  it("M — mute/unmute never depend on availableOperations, even when the list is empty", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { availableOperations: [] }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    await expect(driver.command(dev, { capability: "media", action: "mute" })).resolves.toBeUndefined();
    await expect(driver.command(dev, { capability: "media", action: "unmute" })).resolves.toBeUndefined();
    expect(srv.hits.filter((h) => h.includes("/playback/mute"))).toHaveLength(1);
    expect(srv.hits.filter((h) => h.includes("/playback/unmute"))).toHaveLength(1);

    await driver.disconnect();
  });

  it("N — pause remains distinct from mute (different endpoints, never conflated)", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    await driver.command(dev, { capability: "media", action: "pause" });
    await driver.command(dev, { capability: "media", action: "mute" });
    expect(srv.hits.filter((h) => h.includes("/playback/pause"))).toHaveLength(1);
    expect(srv.hits.filter((h) => h.includes("/playback/mute"))).toHaveLength(1);
    expect(srv.hits.some((h) => h.includes("/playback/pause") && h.includes("mute"))).toBe(false);

    await driver.disconnect();
  });

  it("O — an R1 logical error in an HTTP 200 body is not treated as success", async () => {
    const srv = await startHttp((url, method) => {
      if (url.endsWith("/devices/current")) return { body: JSON.stringify({ deviceId: "A", model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: "A", systemId: "S1", groupId: "G1", role: "Mono" }) };
      if (url.endsWith("/systems/current") && method === "GET") return { body: JSON.stringify({ systemId: "S1", groupId: "G1", systemName: "A" }) };
      // Any POST (the actual command) returns a real R1 logical error in an HTTP 200.
      return { status: 200, body: JSON.stringify({ error: { code: "InvalidValue" } }) };
    });
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    const err = await driver.command(dev, { capability: "media", action: "volume", volume: 999 }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).kind).toBe("logical");

    await driver.disconnect();
  });

  it("P — an HTTP error status is not treated as success", async () => {
    const srv = await startHttp((url) => {
      if (url.endsWith("/devices/current")) return { body: JSON.stringify({ deviceId: "A", model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: "A", systemId: "S1", groupId: "G1", role: "Mono" }) };
      if (url.endsWith("/systems/current")) return { body: JSON.stringify({ systemId: "S1", groupId: "G1", systemName: "A" }) };
      if (url.includes("/playback/pause")) return { status: 500, body: "" };
      return { body: "{}" };
    });
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    const err = await driver.command(dev, { capability: "media", action: "pause" }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).kind).toBe("http");

    await driver.disconnect();
  });

  it("Q — a transport failure (unreachable host) is not treated as success", async () => {
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress("http://127.0.0.1:1") });
    // refreshTopology() will fail too (same unreachable host) — command() must
    // report the routing failure honestly (identity never established), not crash.
    await driver.refreshTopology();
    const err = await driver.command(dev, { capability: "media", action: "pause" }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCommandRoutingError);

    await driver.disconnect();
  });

  it("R — a group-level UnreachableDevices logical error during playback is surfaced, never silently converted to success", async () => {
    const srv = await startHttp((url) => {
      if (url.endsWith("/devices/current")) return { body: JSON.stringify({ deviceId: "A", model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: "A", systemId: "S1", groupId: "G1", role: "Mono" }) };
      if (url.endsWith("/systems/current")) return { body: JSON.stringify({ systemId: "S1", groupId: "G1", systemName: "A" }) };
      if (url.endsWith("/groups/current/sources/current")) return { body: JSON.stringify({ source: { sourceId: SOURCE_ID, deviceId: "A", type: "spotifyconnect" }, playingState: "paused", muteState: "unmuted", availableOperations: ["play"] }) };
      if (url.includes("/playback/play")) return { status: 200, body: JSON.stringify({ error: { code: "UnreachableDevices" } }) };
      return { body: "{}" };
    });
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    const err = await driver.command(dev, { capability: "media", action: "play" }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetApiError);
    expect((err as DevialetApiError).logical?.code).toBe("UnreachableDevices");

    await driver.disconnect();
  });

  it("S — command() never writes speculative state; getState() is unaffected by a successful command until poll() confirms it", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume: 77 }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    expect(driver.getState(dev, "media")).toBeNull();
    await driver.command(dev, { capability: "media", action: "volume", volume: 40 });
    expect(driver.getState(dev, "media")).toBeNull(); // still no speculative write

    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(77); // real device value, not 40

    await driver.disconnect();
  });

  it("T — two driver instances route commands independently with no shared state", async () => {
    const srv1 = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    const srv2 = await startHttp(deviceServer("A", { systemId: "S9", groupId: "G9", role: "Mono" }));
    servers.push(srv1.server, srv2.server);
    const dev = "device-a" as DeviceId;
    const driver1 = await boundDriver(srv1, dev);
    const driver2 = await boundDriver(srv2, dev, new DevialetProtocolDriver({ pollMs: 1_000_000 }));
    await driver1.refreshTopology();
    await driver2.refreshTopology();

    await driver1.command(dev, { capability: "media", action: "volume", volume: 10 });
    expect(srv1.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume"))).toHaveLength(1);
    expect(srv2.hits.filter((h) => h.startsWith("POST") && h.includes("/soundControl/volume"))).toHaveLength(0);

    await driver1.disconnect();
    await driver2.disconnect();
  });

  it("Y — an unsupported action (seek) is rejected before any target resolution or network call", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();
    const hitsBefore = srv.hits.length;

    await expect(driver.command(dev, { capability: "media", action: "seek", positionSec: 30 })).rejects.toThrow(/unsupported/);
    expect(srv.hits.length).toBe(hitsBefore); // no new request at all

    await driver.disconnect();
  });

  it("source selection: matches command.source against the current group's real source list by type, then plays it", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    await driver.command(dev, { capability: "media", action: "source", source: "bluetooth" });
    expect(srv.hits.some((h) => h.includes("/groups/current/sources") && !h.includes("/current/sources/current"))).toBe(true);
    expect(srv.hits.some((h) => h.includes("/groups/current/sources/bt-source-id/playback/play"))).toBe(true);

    await driver.disconnect();
  });

  it("source selection fails cleanly when no current-group source matches, never guessing a sourceId", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    await expect(driver.command(dev, { capability: "media", action: "source", source: "raat" })).rejects.toThrow(/no current-group source matches/);

    await driver.disconnect();
  });

  it("an accessory (no system/group at all) fails every command with topology-unavailable, never a fabricated target", async () => {
    const srv = await startHttp(deviceServer("ARCH", null));
    servers.push(srv.server);
    const dev = "device-arch" as DeviceId;
    const driver = await boundDriver(srv, dev);
    await driver.refreshTopology();

    const err = await driver.command(dev, { capability: "media", action: "volume", volume: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(DevialetCommandRoutingError);
    expect((err as DevialetCommandRoutingError).reason).toBe("topology-unavailable");

    await driver.disconnect();
  });
});
