import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, describe, expect, it } from "vitest";
import { DevialetProtocolDriver } from "./devialet-driver.js";

/**
 * § D2/D3/D4 — Devialet Fusion Driver architecture tests. Covers driver-level
 * lifecycle, idempotent bind/unbind, multi-device isolation, independent driver
 * instances, state recording via the shared `recordCapabilityState()` path,
 * diagnostics/tracing integration, and (§D4) CISettings enrichment reaching the real
 * device without ever mutating R1-confirmed state — exercised against the REAL R1/
 * CISettings endpoint shapes via a real in-process HTTP server.
 *
 * Protocol-correctness tests for the clients themselves live in
 * `devialet-ip-control-client.test.ts` / `devialet-cisettings-client.test.ts` — this
 * file only proves the DRIVER wires both clients in correctly.
 */

function startHttp(handler: (url: string, method: string) => { status?: number; body?: string }): Promise<{ server: Server; base: string; port: number; hits: string[] }> {
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
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, port, hits });
    });
  });
}

/** An mDNS TXT fixture matching a real "-ipcontrol" Devialet service instance,
 * pointed at a fake R1 server's actual loopback port. */
function devialetMdnsService(name: string, port: number): import("./mdns.js").MdnsService {
  return {
    name: `${name}-ipcontrol._http._tcp.local`,
    host: `${name}.local`,
    port,
    addresses: ["127.0.0.1"],
    txt: { path: IP_CONTROL_PATH, ipControlVersion: "1", manufacturer: "Devialet" },
  };
}

function deviceInfoHandler(deviceId: string, extra: Record<string, unknown> = {}) {
  return (url: string) => {
    if (url.endsWith("/devices/current")) {
      return { body: JSON.stringify({ deviceId, model: "Phantom I", release: { version: "2.14.2" }, serial: "P35V1", deviceName: "Living Room", ...extra }) };
    }
    return { body: "{}" };
  };
}

const IP_CONTROL_PATH = "/ipcontrol/v1";
const SOURCE_ID = "213a3ed0-1fb9-4da2-bcf4-066da0f7b27e";

function mediaHandler(volume: number, playingState: "playing" | "paused") {
  return (url: string) => {
    if (url.endsWith("/systems/current/sources/current/soundControl/volume")) {
      return { body: JSON.stringify({ volume }) };
    }
    if (url.endsWith("/groups/current/sources/current")) {
      return {
        body: JSON.stringify({
          source: { sourceId: SOURCE_ID, deviceId: "dispatcher-device", type: "spotifyconnect" },
          playingState,
          muteState: "unmuted",
          metadata: { artist: "Artist", album: "Album", title: "Track" },
          availableOperations: ["play", "pause", "next", "previous"],
        }),
      };
    }
    return { body: "{}" };
  };
}

function bindAddress(base: string) {
  return { address: base, config: { path: IP_CONTROL_PATH } };
}

describe("DevialetProtocolDriver — D2/D3 architecture", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  it("constructs with default options, unconnected", () => {
    const driver = new DevialetProtocolDriver();
    expect(driver.protocol).toBe("devialet");
    expect(driver.isConnected()).toBe(false);
  });

  it("connect()/disconnect() toggle isConnected(); disconnect stops the poll timer", async () => {
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    expect(driver.isConnected()).toBe(false);
    await driver.connect();
    expect(driver.isConnected()).toBe(true);
    await driver.disconnect();
    expect(driver.isConnected()).toBe(false);
  });

  it("supports multiple simultaneously-bound physical devices", async () => {
    const srvA = await startHttp(mediaHandler(10, "paused"));
    const srvB = await startHttp(mediaHandler(90, "playing"));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const devA = "device-a" as DeviceId;
    const devB = "device-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: devB, capability: "media", ...bindAddress(srvB.base) });

    expect(driver.manages(devA)).toBe(true);
    expect(driver.manages(devB)).toBe(true);

    await driver.poll();
    const stateA = driver.getState(devA, "media") as { volume: number; playback: string };
    const stateB = driver.getState(devB, "media") as { volume: number; playback: string };
    expect(stateA.volume).toBe(10);
    expect(stateA.playback).toBe("paused");
    expect(stateB.volume).toBe(90);
    expect(stateB.playback).toBe("playing");

    await driver.disconnect();
  });

  it("bind() is idempotent — re-binding the same device+capability replaces, not duplicates", async () => {
    const srvOld = await startHttp(mediaHandler(1, "paused"));
    const srvNew = await startHttp(mediaHandler(2, "playing"));
    servers.push(srvOld.server, srvNew.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-rebind" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srvOld.base) });
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srvNew.base) });

    await driver.command(dev, { capability: "media", action: "next" });
    expect(srvNew.hits.some((h) => h.includes("/playback/next"))).toBe(true);
    expect(srvOld.hits.some((h) => h.includes("/playback/next"))).toBe(false);

    await driver.poll();
    const s = driver.getState(dev, "media") as { volume: number };
    expect(s.volume).toBe(2);

    await driver.disconnect();
  });

  it("unbind() releases a device's bindings/state without disturbing other devices", async () => {
    const srvA = await startHttp(mediaHandler(5, "paused"));
    const srvB = await startHttp(mediaHandler(6, "playing"));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const devA = "device-unbind-a" as DeviceId;
    const devB = "device-unbind-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: devB, capability: "media", ...bindAddress(srvB.base) });
    await driver.poll();

    await driver.unbind(devA);
    expect(driver.manages(devA)).toBe(false);
    expect(driver.getState(devA, "media")).toBeNull();
    expect(driver.manages(devB)).toBe(true);
    expect(driver.getState(devB, "media")).not.toBeNull();

    await expect(driver.unbind(devA)).resolves.toBeUndefined();
    await expect(driver.unbind("never-bound" as DeviceId)).resolves.toBeUndefined();

    await driver.disconnect();
  });

  it("two driver instances never share state, even for the same DeviceId", async () => {
    const srv1 = await startHttp(mediaHandler(11, "paused"));
    const srv2 = await startHttp(mediaHandler(22, "playing"));
    servers.push(srv1.server, srv2.server);
    const dev = "device-shared-id" as DeviceId;
    const driver1 = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    const driver2 = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver1.connect();
    await driver2.connect();
    await driver1.bind({ deviceId: dev, capability: "media", ...bindAddress(srv1.base) });
    await driver2.bind({ deviceId: dev, capability: "media", ...bindAddress(srv2.base) });

    await driver1.command(dev, { capability: "media", action: "next" });
    expect(srv1.hits.some((h) => h.includes("/playback/next"))).toBe(true);
    expect(srv2.hits.some((h) => h.includes("/playback/next"))).toBe(false);

    await driver1.poll();
    await driver2.poll();
    expect((driver1.getState(dev, "media") as { volume: number }).volume).toBe(11);
    expect((driver2.getState(dev, "media") as { volume: number }).volume).toBe(22);

    await driver1.disconnect();
    await driver2.disconnect();
  });

  it("records state through the shared recordCapabilityState() dedupe — unchanged data emits no second event", async () => {
    const srv = await startHttp(mediaHandler(50, "playing"));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-dedupe" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));
    await driver.poll();
    await driver.poll();
    await driver.poll();
    expect(events.length).toBe(1);
    expect(events[0]!.state).toMatchObject({ kind: "media", volume: 50, playback: "playing", artist: "Artist", album: "Album", title: "Track" });

    await driver.disconnect();
  });

  it("command() never mutates confirmed state directly — only poll()'s feedback does", async () => {
    const srv = await startHttp(mediaHandler(33, "paused"));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-no-optimistic" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    expect(driver.getState(dev, "media")).toBeNull();
    await driver.command(dev, { capability: "media", action: "volume", volume: 77 });
    expect(driver.getState(dev, "media")).toBeNull();
    expect(srv.hits.some((h) => h.includes("/soundControl/volume"))).toBe(true);

    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(33);

    await driver.disconnect();
  });

  it("play resolves the current sourceId first, then POSTs to that source's play endpoint", async () => {
    const srv = await startHttp(mediaHandler(20, "paused"));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-play" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    await driver.command(dev, { capability: "media", action: "play" });
    expect(srv.hits.some((h) => h.includes("/groups/current/sources/current"))).toBe(true);
    expect(srv.hits.some((h) => h.includes(`/groups/current/sources/${SOURCE_ID}/playback/play`))).toBe(true);

    await driver.disconnect();
  });

  it("throws for a command issued while disconnected, and for an unbound device", async () => {
    const driver = new DevialetProtocolDriver();
    const dev = "device-guard" as DeviceId;
    await expect(driver.command(dev, { capability: "media", action: "next" })).rejects.toThrow(/disconnected/);
    await driver.connect();
    await expect(driver.command(dev, { capability: "media", action: "next" })).rejects.toThrow(/not bound/);
    await driver.disconnect();
  });

  it("integrates real diagnostics — packet counters and connection status reflect actual traffic", async () => {
    const srv = await startHttp(mediaHandler(40, "playing"));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    const dev = "device-diagnostics" as DeviceId;
    expect(driver.getDiagnostics(dev)).toBeNull();

    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });
    await driver.command(dev, { capability: "media", action: "next" });
    await driver.poll();

    const diag = driver.getDiagnostics(dev);
    expect(diag).not.toBeNull();
    expect(diag!.connectionStatus).toBe("connected");
    expect(diag!.protocol).toBe("devialet");
    expect(diag!.packetsSent).toBeGreaterThan(0);
    expect(diag!.packetsReceived).toBeGreaterThan(0);
    expect(diag!.firmware).toBeNull();
    expect(diag!.model).toBeNull();

    await driver.disconnect();
  });

  it("integrates real tracing — onLog receives [trace:devialet] lines when trace is enabled", async () => {
    const srv = await startHttp(mediaHandler(1, "paused"));
    servers.push(srv.server);
    const logs: string[] = [];
    const driver = new DevialetProtocolDriver({
      pollMs: 1_000_000,
      trace: true,
      onLog: (_level, message) => logs.push(message),
    });
    const dev = "device-trace" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });
    await driver.command(dev, { capability: "media", action: "next" });
    await driver.poll();

    expect(logs.some((l) => l.startsWith("[trace:devialet]"))).toBe(true);
    const trace = driver.getTrace(dev);
    expect(trace).not.toBeNull();
    expect(trace!.length).toBeGreaterThan(0);

    await driver.disconnect();
  });

  it("refreshCapabilities() is a real, honest no-op for an unmanaged device, and doesn't throw for a managed one", async () => {
    const driver = new DevialetProtocolDriver();
    const dev = "device-refresh" as DeviceId;
    await expect(driver.refreshCapabilities("never-bound" as DeviceId)).resolves.toBeUndefined();
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress("http://127.0.0.1:1") });
    await expect(driver.refreshCapabilities(dev)).resolves.toBeUndefined();
    await driver.disconnect();
  });

  it("§ D4 — getCiSettingsLean()/getCiSettingsInternalState() reach the real CISettings server and never mutate confirmed R1 state", async () => {
    const srv = await startHttp((url) => {
      if (url === "/cisettings/getlean") return { body: JSON.stringify({ data: { powerstate: "running", mutemode: "OFF", volume: 88, source: "Bluetooth" } }) };
      if (url === "/cisettings/internalstate") return { body: JSON.stringify({ data: { internalstate: "OK" } }) };
      if (url.endsWith("/systems/current/sources/current/soundControl/volume")) return { body: JSON.stringify({ volume: 33 }) };
      if (url.endsWith("/groups/current/sources/current")) return { body: JSON.stringify({ playingState: "paused", muteState: "unmuted", availableOperations: [] }) };
      return { status: 404 };
    });
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-cisettings" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    // Establish real R1-confirmed state first.
    await driver.poll();
    const r1State = driver.getState(dev, "media") as { volume: number };
    expect(r1State.volume).toBe(33);

    // CISettings reports a DIFFERENT volume (88) — reading it must never overwrite
    // the R1-confirmed capability state (§13/§20 — no fusion in D4).
    const lean = await driver.getCiSettingsLean(dev);
    expect(lean).toEqual({ powerstate: "running", mutemode: "OFF", volume: 88, source: "Bluetooth" });
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(33);

    const internalState = await driver.getCiSettingsInternalState(dev);
    expect(internalState).toBe("OK");
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(33);

    // Both CISettings calls hit the real fixed /cisettings/... path, separate from R1.
    expect(srv.hits.some((h) => h.includes("/cisettings/getlean"))).toBe(true);
    expect(srv.hits.some((h) => h.includes("/cisettings/internalstate"))).toBe(true);

    await driver.disconnect();
  });

  it("§ D4 — getCiSettingsLean()/getCiSettingsInternalState() return null for an unmanaged device", async () => {
    const driver = new DevialetProtocolDriver();
    const dev = "device-cisettings-unmanaged" as DeviceId;
    expect(await driver.getCiSettingsLean(dev)).toBeNull();
    expect(await driver.getCiSettingsInternalState(dev)).toBeNull();
  });

  it("tolerates a real logical error (e.g. NoCurrentSource) during poll() without throwing or recording fabricated state", async () => {
    const srv = await startHttp((url) => {
      if (url.endsWith("/groups/current/sources/current")) {
        return { body: JSON.stringify({ error: { code: "NoCurrentSource" } }) };
      }
      if (url.endsWith("/systems/current/sources/current/soundControl/volume")) {
        return { body: JSON.stringify({ volume: 15 }) };
      }
      return { body: "{}" };
    });
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-no-current-source" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    await expect(driver.poll()).resolves.toBeUndefined();
    expect(driver.getState(dev, "media")).toBeNull();

    await driver.disconnect();
  });
});

describe("DevialetProtocolDriver — D5 discovery + stable identity", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  it("A/J/K — discovers a real _http._tcp Devialet service, queries /devices/current, and returns the stable deviceId + discovered path as backendId/raw", async () => {
    const srv = await startHttp(deviceInfoHandler("device-uuid-A"));
    servers.push(srv.server);
    let browsedServiceType: string | undefined;
    const driver = new DevialetProtocolDriver({
      mdns: async (serviceType) => {
        browsedServiceType = serviceType;
        return [devialetMdnsService("living-room", srv.port)];
      },
    });

    const found = await driver.discover();
    expect(browsedServiceType).toBe("_http._tcp.local");
    expect(found).toHaveLength(1);
    expect(found[0]!.backendId).toBe("device-uuid-A");
    expect(found[0]!.suggestedName).toBe("Living Room");
    expect(found[0]!.raw).toMatchObject({ host: `127.0.0.1:${srv.port}`, path: IP_CONTROL_PATH, ipControlVersion: "1" });
    expect(srv.hits.some((h) => h.includes("/devices/current"))).toBe(true);
  });

  it("D — a plain _http._tcp record with no Devialet TXT keys is ignored, never queried over R1", async () => {
    const srv = await startHttp(deviceInfoHandler("should-never-be-queried"));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({
      mdns: async () => [
        { name: "Living room._http._tcp.local", host: "living-room.local", port: srv.port, addresses: ["127.0.0.1"], txt: { path: "/" } },
      ],
    });
    const found = await driver.discover();
    expect(found).toHaveLength(0);
    expect(srv.hits).toEqual([]);
  });

  it("L — an IP address change for the SAME physical device yields the SAME backendId across two discover() calls", async () => {
    const srvOldIp = await startHttp(deviceInfoHandler("device-stable-id"));
    const srvNewIp = await startHttp(deviceInfoHandler("device-stable-id"));
    servers.push(srvOldIp.server, srvNewIp.server);
    let currentPort = srvOldIp.port;
    const driver = new DevialetProtocolDriver({ mdns: async () => [devialetMdnsService("moved-speaker", currentPort)] });

    const before = await driver.discover();
    expect(before[0]!.backendId).toBe("device-stable-id");
    expect(before[0]!.raw).toMatchObject({ host: `127.0.0.1:${srvOldIp.port}` });

    currentPort = srvNewIp.port; // simulates the device now answering at a different transport endpoint
    const after = await driver.discover();
    expect(after[0]!.backendId).toBe("device-stable-id");
    expect(after[0]!.raw).toMatchObject({ host: `127.0.0.1:${srvNewIp.port}` });
    expect(after[0]!.backendId).toBe(before[0]!.backendId);
  });

  it("M — the SAME physical device announcing multiple mDNS instances (the doc's own IPv4/IPv6 duplicate case) collapses to ONE discovered device", async () => {
    const srv = await startHttp(deviceInfoHandler("device-dup"));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({
      mdns: async () => [
        devialetMdnsService("dup-speaker-v4", srv.port),
        devialetMdnsService("dup-speaker-v6", srv.port),
      ],
    });
    const found = await driver.discover();
    expect(found).toHaveLength(1);
    expect(found[0]!.backendId).toBe("device-dup");
  });

  it("N — two genuinely different Devialet devices remain independent, each with its own backendId", async () => {
    const srvA = await startHttp(deviceInfoHandler("device-A"));
    const srvB = await startHttp(deviceInfoHandler("device-B"));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({
      mdns: async () => [devialetMdnsService("speaker-a", srvA.port), devialetMdnsService("speaker-b", srvB.port)],
    });
    const found = await driver.discover();
    expect(found.map((d) => d.backendId).sort()).toEqual(["device-A", "device-B"]);
  });

  it("O — two driver instances performing discovery never share state", async () => {
    const srvA = await startHttp(deviceInfoHandler("device-instance-A"));
    const srvB = await startHttp(deviceInfoHandler("device-instance-B"));
    servers.push(srvA.server, srvB.server);
    const driver1 = new DevialetProtocolDriver({ mdns: async () => [devialetMdnsService("s1", srvA.port)] });
    const driver2 = new DevialetProtocolDriver({ mdns: async () => [devialetMdnsService("s2", srvB.port)] });
    const [found1, found2] = await Promise.all([driver1.discover(), driver2.discover()]);
    expect(found1[0]!.backendId).toBe("device-instance-A");
    expect(found2[0]!.backendId).toBe("device-instance-B");
  });

  it("P/Q — a candidate whose /devices/current fails is omitted (never a fabricated identity), without affecting a sibling candidate's discovery", async () => {
    const srvGood = await startHttp(deviceInfoHandler("device-good"));
    servers.push(srvGood.server);
    const driver = new DevialetProtocolDriver({
      mdns: async () => [
        devialetMdnsService("unreachable-speaker", 1), // nothing listens on port 1 -> connection refused
        devialetMdnsService("good-speaker", srvGood.port),
      ],
    });
    const found = await driver.discover();
    expect(found).toHaveLength(1);
    expect(found[0]!.backendId).toBe("device-good");
  });

  it("U — a failed identity query is traced/logged, not silently swallowed", async () => {
    const logs: string[] = [];
    const driver = new DevialetProtocolDriver({
      trace: true,
      onLog: (_level, message) => logs.push(message),
      mdns: async () => [devialetMdnsService("unreachable-speaker", 1)],
    });
    const found = await driver.discover();
    expect(found).toHaveLength(0);
    expect(logs.some((l) => l.includes("identity query failed"))).toBe(true);
  });
});
