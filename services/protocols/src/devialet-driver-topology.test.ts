import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import { afterEach, describe, expect, it } from "vitest";
import { DevialetProtocolDriver } from "./devialet-driver.js";

/**
 * § D6 — driver-level topology integration tests: `refreshTopology()` against real
 * `/devices/current`/`/systems/current` responses via a real in-process HTTP server.
 * Pure reconciliation-algorithm coverage lives in `devialet-topology.test.ts` — this
 * file only proves the DRIVER wires the real R1 client into the topology registry
 * correctly (identity population, diagnostics/tracing, event dispatch, multi-instance
 * isolation, partial-failure tolerance).
 */

const IP_CONTROL_PATH = "/ipcontrol/v1";

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

/** A fake device's R1 /devices/current + /systems/current responses. `system: null`
 * means the doc's own accessory shape (no systemId/groupId/role at all). */
function deviceServer(deviceId: string, system: { systemId: string; groupId: string; role: string; systemName?: string } | null) {
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
      return { body: JSON.stringify({ systemId: system.systemId, groupId: system.groupId, systemName: system.systemName ?? `${deviceId}'s room` }) };
    }
    return { status: 404, body: "" };
  };
}

describe("DevialetProtocolDriver — D6 topology integration", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  it("A — a single solo device: refreshTopology() populates devialetId and topology from real R1 responses", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono", systemName: "Living Room" }));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    const result = await driver.refreshTopology();
    expect(result.changed).toBe(true);
    expect(srv.hits.some((h) => h.includes("/devices/current"))).toBe(true);
    expect(srv.hits.some((h) => h.includes("/systems/current"))).toBe(true);

    const topo = driver.getDeviceTopology(dev);
    expect(topo).toMatchObject({ deviceId: "A", systemId: "S1", groupId: "G1", role: "Mono" });
    expect(driver.getTopologySnapshot().systems.S1).toMatchObject({ systemName: "Living Room", memberDeviceIds: ["A"] });

    await driver.disconnect();
  });

  it("B — a stereo pair (two SupremeOS devices) reconciles into one System with both members", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "FrontLeft" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S1", groupId: "G1", role: "FrontRight" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: "dev-a" as DeviceId, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: "dev-b" as DeviceId, capability: "media", ...bindAddress(srvB.base) });

    await driver.refreshTopology();
    const snapshot = driver.getTopologySnapshot();
    expect(snapshot.systems.S1!.memberDeviceIds).toEqual(["A", "B"]);
    expect(snapshot.devices.A!.role).toBe("FrontLeft");
    expect(snapshot.devices.B!.role).toBe("FrontRight");
    // getSystem() is called once per DISTINCT systemId, not once per device.
    expect(srvA.hits.filter((h) => h.includes("/systems/current")).length).toBe(1);

    await driver.disconnect();
  });

  it("D/E — a group id change for the same devices is a topology change, never a new physical device", async () => {
    let groupId = "G1";
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId, role: "Mono" })(url));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    await driver.refreshTopology();
    expect(driver.getTopologySnapshot().devices.A!.groupId).toBe("G1");

    groupId = "G2";
    const result = await driver.refreshTopology();
    expect(result.changed).toBe(true);
    expect(result.changes.removedGroupIds).toEqual(["G1"]);
    expect(result.changes.addedGroupIds).toEqual(["G2"]);
    expect(result.changes.addedDeviceIds).toEqual([]); // same physical device, not a new one
    expect(driver.getTopologySnapshot().devices.A!.deviceId).toBe("A");

    await driver.disconnect();
  });

  it("K/L — two independent physical devices stay isolated; a third device on a second driver instance never contaminates the first", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S2", groupId: "G2", role: "Mono" }));
    const srvC = await startHttp(deviceServer("C", { systemId: "S3", groupId: "G3", role: "Mono" }));
    servers.push(srvA.server, srvB.server, srvC.server);

    const driver1 = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver1.connect();
    await driver1.bind({ deviceId: "dev-a" as DeviceId, capability: "media", ...bindAddress(srvA.base) });
    await driver1.bind({ deviceId: "dev-b" as DeviceId, capability: "media", ...bindAddress(srvB.base) });
    await driver1.refreshTopology();

    const driver2 = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver2.connect();
    await driver2.bind({ deviceId: "dev-c" as DeviceId, capability: "media", ...bindAddress(srvC.base) });
    await driver2.refreshTopology();

    expect(Object.keys(driver1.getTopologySnapshot().devices).sort()).toEqual(["A", "B"]);
    expect(Object.keys(driver2.getTopologySnapshot().devices)).toEqual(["C"]);
    expect(driver1.getDeviceTopology("dev-c" as DeviceId)).toBeNull();

    await driver1.disconnect();
    await driver2.disconnect();
  });

  it("M/N/O — a device whose /devices/current fails this round keeps its last-known topology; a sibling device is unaffected", async () => {
    const srvGood = await startHttp(deviceServer("GOOD", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srvGood.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const devGood = "device-good" as DeviceId;
    const devFlaky = "device-flaky" as DeviceId;
    await driver.bind({ deviceId: devGood, capability: "media", ...bindAddress(srvGood.base) });
    // Nothing listens on this port — every call fails with a real connection error.
    await driver.bind({ deviceId: devFlaky, capability: "media", address: "http://127.0.0.1:1", config: { path: IP_CONTROL_PATH } });

    const first = await driver.refreshTopology();
    expect(first.changes.addedDeviceIds).toEqual(["GOOD"]); // flaky device never resolved an identity yet
    expect(driver.getDeviceTopology(devFlaky)).toBeNull();
    expect(driver.getDeviceTopology(devGood)).toMatchObject({ deviceId: "GOOD", systemId: "S1" });

    // A second refresh: the good device is untouched, the flaky one still fails —
    // still simply absent, never fabricated.
    const second = await driver.refreshTopology();
    expect(second.changed).toBe(false);
    expect(driver.getDeviceTopology(devGood)).toMatchObject({ deviceId: "GOOD", systemId: "S1" });

    await driver.disconnect();
  });

  it("system-name enrichment failure doesn't affect device/system membership", async () => {
    const srv = await startHttp((url) => {
      if (url.endsWith("/devices/current")) return { body: JSON.stringify({ deviceId: "A", model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: "A", systemId: "S1", groupId: "G1", role: "Mono" }) };
      if (url.endsWith("/systems/current")) return { status: 500, body: "" };
      return { status: 404, body: "" };
    });
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    await driver.refreshTopology();
    expect(driver.getTopologySnapshot().systems.S1).toMatchObject({ memberDeviceIds: ["A"], systemName: null });

    await driver.disconnect();
  });

  it("Q — repeated identical refreshTopology() calls are idempotent (changed: false on the second call)", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: "dev-a" as DeviceId, capability: "media", ...bindAddress(srv.base) });

    const first = await driver.refreshTopology();
    expect(first.changed).toBe(true);
    const second = await driver.refreshTopology();
    expect(second.changed).toBe(false);
    expect(second.changes).toEqual({ addedDeviceIds: [], removedDeviceIds: [], changedDeviceIds: [], addedSystemIds: [], removedSystemIds: [], addedGroupIds: [], removedGroupIds: [] });

    await driver.disconnect();
  });

  it("R — leader/master fields are always null — the driver never guesses them from response ordering", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "FrontLeft" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S1", groupId: "G1", role: "FrontRight" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: "dev-a" as DeviceId, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: "dev-b" as DeviceId, capability: "media", ...bindAddress(srvB.base) });
    await driver.refreshTopology();

    expect(driver.getTopologySnapshot().systems.S1!.leaderDeviceId).toBeNull();
    expect(driver.getTopologySnapshot().groups.G1!.masterSystemId).toBeNull();

    await driver.disconnect();
  });

  it("S — an accessory (no systemId/groupId in /devices/current) never becomes a stereo system member", async () => {
    const srv = await startHttp(deviceServer("ARCH", null));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-arch" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    await driver.refreshTopology();
    const topo = driver.getDeviceTopology(dev);
    expect(topo).toMatchObject({ deviceId: "ARCH", systemId: null, groupId: null });
    expect(Object.keys(driver.getTopologySnapshot().systems)).toEqual([]);

    await driver.disconnect();
  });

  it("V — unbind() genuinely removes a device from topology (unlike a failed refresh, which preserves it)", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });
    await driver.refreshTopology();
    expect(driver.getTopologySnapshot().devices.A).toBeDefined();

    await driver.unbind(dev);
    expect(driver.getTopologySnapshot().devices.A).toBeUndefined();
    expect(driver.getTopologySnapshot().systems.S1).toBeUndefined();
    expect(driver.getDeviceTopology(dev)).toBeNull();

    await driver.disconnect();
  });

  it("U — onTopologyChange() fires only on a real change, with old/new snapshots and affected ids", async () => {
    let groupId = "G1";
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId, role: "Mono" })(url));
    servers.push(srv.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    const events: { changed: boolean }[] = [];
    driver.onTopologyChange((result) => events.push(result));

    await driver.refreshTopology(); // first refresh: real change (empty -> populated)
    expect(events.length).toBe(1);

    await driver.refreshTopology(); // identical second refresh: no event
    expect(events.length).toBe(1);

    groupId = "G2";
    await driver.refreshTopology(); // real change again
    expect(events.length).toBe(2);
    expect(events[1]!.changed).toBe(true);

    await driver.disconnect();
  });

  it("diagnostics/tracing: topology queries are traced with R1-prefixed labels and counted in getDiagnostics()", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    servers.push(srv.server);
    const logs: string[] = [];
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000, trace: true, onLog: (_l, m) => logs.push(m) });
    await driver.connect();
    const dev = "device-a" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });

    await driver.refreshTopology();
    expect(logs.some((l) => l.includes("R1 GET devices/current (topology)"))).toBe(true);
    expect(logs.some((l) => l.includes("R1 GET systems/current (topology)"))).toBe(true);
    expect(logs.some((l) => l.includes("topology: refresh started"))).toBe(true);
    expect(logs.some((l) => l.includes("topology: changed"))).toBe(true);

    const diag = driver.getDiagnostics(dev);
    expect(diag!.packetsSent).toBeGreaterThanOrEqual(2);

    await driver.disconnect();
  });
});
