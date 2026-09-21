import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevialetProtocolDriver } from "./devialet-driver.js";

/**
 * § D11 — dynamic topology detection/refresh strategy. Real in-process HTTP servers
 * throughout. Each server is driven by a mutable `Topology` map keyed by deviceId, so
 * a test can simulate a real System/Group re-pair (Solo<->Stereo, Group reshuffle)
 * mid-session and observe the driver's `poll()`-piggybacked `refreshTopology()`
 * detect and reconcile it — never a second timer, never a fabricated topology.
 */

const IP_CONTROL_PATH = "/ipcontrol/v1";
const SOURCE_ID = "213a3ed0-1fb9-4da2-bcf4-066da0f7b27e";

interface DeviceTopo {
  systemId: string;
  groupId: string;
  volume: number;
  title?: string;
  unreachable?: boolean;
}

/** One server represents ONE physical Devialet device (its own host/IP), whose
 * System/Group membership is read from a mutable `topo` object the test can rewrite
 * between `poll()`/`refreshTopology()` calls — exactly mirroring a real re-pair. */
function startDeviceServer(deviceId: string, topo: DeviceTopo): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      hits.push(`${req.method} ${url}`);
      if (topo.unreachable) {
        req.socket.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      if (url.endsWith("/devices/current")) {
        return res.end(JSON.stringify({ deviceId, model: "Phantom I", release: { version: "2.14.2" }, serial: deviceId, deviceName: deviceId, systemId: topo.systemId, groupId: topo.groupId, role: "Mono" }));
      }
      if (url.endsWith("/systems/current")) {
        return res.end(JSON.stringify({ systemId: topo.systemId, groupId: topo.groupId, systemName: `${topo.systemId}'s room` }));
      }
      if (url.endsWith("/systems/current/sources/current/soundControl/volume")) {
        return res.end(JSON.stringify({ volume: topo.volume }));
      }
      if (url.endsWith("/groups/current/sources/current")) {
        return res.end(
          JSON.stringify({
            source: { sourceId: SOURCE_ID, deviceId, type: "airplay2" },
            playingState: "playing",
            muteState: "unmuted",
            metadata: { artist: "Artist", album: "Album", title: topo.title ?? "Track" },
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

describe("DevialetProtocolDriver — D11 dynamic topology detection/refresh", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  async function bound(srv: Awaited<ReturnType<typeof startDeviceServer>>, dev: DeviceId, topologyRefreshMs = 30) {
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000, topologyRefreshMs });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll(); // establishes initial topology on-demand (unchanged D8/AH behavior)
    return driver;
  }

  it("A — topology unchanged: a periodic sweep with no real change reports changed:false", async () => {
    const topo: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startDeviceServer("A", topo);
    servers.push(srv.server);
    const dev = "dev-a" as DeviceId;
    const driver = await bound(srv, dev);

    await new Promise((r) => setTimeout(r, 40));
    await driver.poll();
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S1");
    await driver.disconnect();
  });

  it("B/C — a systemId AND groupId change is detected by the piggybacked sweep, no manual refreshTopology() call", async () => {
    const topo: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startDeviceServer("A", topo);
    servers.push(srv.server);
    const dev = "dev-b" as DeviceId;
    const driver = await bound(srv, dev);
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S1");

    topo.systemId = "S2";
    topo.groupId = "G2";
    topo.volume = 15;
    await new Promise((r) => setTimeout(r, 40));
    await driver.poll(); // media poll + piggybacked topology sweep, same timer tick
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S2");
    expect(driver.getDeviceTopology(dev)?.groupId).toBe("G2");
    expect(driver.getTopologySnapshot().systems["S1"]).toBeUndefined();
    // § K — volume now targets the NEW system, without a manual refreshTopology().
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(15);
    await driver.disconnect();
  });

  it("D/E — Stereo -> Solo -> Stereo: two devices' System membership reconciles both ways", async () => {
    const topoA: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const topoB: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const srvA = await startDeviceServer("A", topoA);
    const srvB = await startDeviceServer("B", topoB);
    servers.push(srvA.server, srvB.server);
    const devA = "dev-d-a" as DeviceId;
    const devB = "dev-d-b" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000, topologyRefreshMs: 30 });
    await driver.connect();
    await driver.bind({ deviceId: devA, capability: "media", address: srvA.base, config: { path: IP_CONTROL_PATH } });
    await driver.bind({ deviceId: devB, capability: "media", address: srvB.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect(driver.getTopologySnapshot().systems["S1"]?.memberDeviceIds).toEqual(["A", "B"]);

    // Stereo -> Solo: each device becomes its own System.
    topoA.systemId = "SA";
    topoA.groupId = "GA";
    topoB.systemId = "SB";
    topoB.groupId = "GB";
    await new Promise((r) => setTimeout(r, 40));
    await driver.poll();
    expect(driver.getTopologySnapshot().systems["S1"]).toBeUndefined();
    expect(driver.getTopologySnapshot().systems["SA"]?.memberDeviceIds).toEqual(["A"]);
    expect(driver.getTopologySnapshot().systems["SB"]?.memberDeviceIds).toEqual(["B"]);

    // Solo -> Stereo: re-paired back into one System.
    topoA.systemId = "S1";
    topoA.groupId = "G1";
    topoB.systemId = "S1";
    topoB.groupId = "G1";
    await new Promise((r) => setTimeout(r, 40));
    await driver.poll();
    expect(driver.getTopologySnapshot().systems["SA"]).toBeUndefined();
    expect(driver.getTopologySnapshot().systems["SB"]).toBeUndefined();
    expect(driver.getTopologySnapshot().systems["S1"]?.memberDeviceIds).toEqual(["A", "B"]);
    await driver.disconnect();
  });

  it("F — Group membership reshuffle: G1{A,B} -> G2{A,C} -> G3{B,C}", async () => {
    const topoA: DeviceTopo = { systemId: "SA", groupId: "G1", volume: 10, title: "A" };
    const topoB: DeviceTopo = { systemId: "SB", groupId: "G1", volume: 20, title: "B" };
    const topoC: DeviceTopo = { systemId: "SC", groupId: "G1", volume: 30, title: "C" };
    const srvA = await startDeviceServer("A", topoA);
    const srvB = await startDeviceServer("B", topoB);
    const srvC = await startDeviceServer("C", topoC);
    servers.push(srvA.server, srvB.server, srvC.server);
    const devA = "dev-f-a" as DeviceId;
    const devB = "dev-f-b" as DeviceId;
    const devC = "dev-f-c" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000, topologyRefreshMs: 30 });
    await driver.connect();
    await driver.bind({ deviceId: devA, capability: "media", address: srvA.base, config: { path: IP_CONTROL_PATH } });
    await driver.bind({ deviceId: devB, capability: "media", address: srvB.base, config: { path: IP_CONTROL_PATH } });
    await driver.bind({ deviceId: devC, capability: "media", address: srvC.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    expect(driver.getTopologySnapshot().groups["G1"]?.memberSystemIds.sort()).toEqual(["SA", "SB", "SC"]);

    topoB.groupId = "G3";
    topoC.groupId = "G2";
    await new Promise((r) => setTimeout(r, 40));
    await driver.poll();
    expect(driver.getTopologySnapshot().groups["G1"]?.memberSystemIds).toEqual(["SA"]);
    expect(driver.getTopologySnapshot().groups["G2"]?.memberSystemIds).toEqual(["SC"]);
    expect(driver.getTopologySnapshot().groups["G3"]?.memberSystemIds).toEqual(["SB"]);
    await driver.disconnect();
  });

  it("G — repeated topology refresh with no change is idempotent (no duplicate members)", async () => {
    const topo: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startDeviceServer("A", topo);
    servers.push(srv.server);
    const dev = "dev-g" as DeviceId;
    const driver = await bound(srv, dev);

    const r1 = await driver.refreshTopology();
    const r2 = await driver.refreshTopology();
    expect(r1.changed).toBe(false); // already resolved by the initial poll() above
    expect(r2.changed).toBe(false);
    expect(driver.getTopologySnapshot().systems["S1"]?.memberDeviceIds).toEqual(["A"]);
  });

  it("H/I — topology refresh failure preserves last-known topology; recovery reconciles the real change", async () => {
    const topo: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startDeviceServer("A", topo);
    servers.push(srv.server);
    const dev = "dev-h" as DeviceId;
    const driver = await bound(srv, dev);
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S1");

    topo.unreachable = true;
    const failed = await driver.refreshTopology();
    expect(failed.changed).toBe(false);
    // Not fabricated, not erased — last-known topology survives a failed sweep.
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S1");

    topo.unreachable = false;
    topo.systemId = "S2";
    topo.groupId = "G2";
    const recovered = await driver.refreshTopology();
    expect(recovered.changed).toBe(true);
    expect(driver.getDeviceTopology(dev)?.systemId).toBe("S2");
  });

  it("J — media projection follows the new Group after a topology change", async () => {
    const topo: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40, title: "Old Group Track" };
    const srv = await startDeviceServer("A", topo);
    servers.push(srv.server);
    const dev = "dev-j" as DeviceId;
    const driver = await bound(srv, dev);
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("Old Group Track");

    topo.groupId = "G2";
    topo.title = "New Group Track";
    await new Promise((r) => setTimeout(r, 40));
    await driver.poll();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("New Group Track");
    expect(driver.getDeviceTopology(dev)?.groupId).toBe("G2");
  });

  it("L — a command issued during a concurrent topology refresh resolves correctly, no crash/race", async () => {
    const topo: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startDeviceServer("A", topo);
    servers.push(srv.server);
    const dev = "dev-l" as DeviceId;
    const driver = await bound(srv, dev);

    const [refreshResult] = await Promise.all([
      driver.refreshTopology(),
      driver.command(dev, { capability: "media", action: "mute" } as never),
    ]);
    expect(refreshResult.changed).toBe(false);
    expect(srv.hits.some((h) => h.endsWith("/playback/mute"))).toBe(true);
  });

  it("M — concurrent refreshTopology() calls coalesce onto one in-flight sweep", async () => {
    let deviceQueryCount = 0;
    const topo: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startDeviceServer("A", topo);
    servers.push(srv.server);
    const dev = "dev-m" as DeviceId;
    const driver = await bound(srv, dev);
    deviceQueryCount = srv.hits.filter((h) => h.endsWith("/devices/current")).length;

    const [r1, r2, r3] = await Promise.all([driver.refreshTopology(), driver.refreshTopology(), driver.refreshTopology()]);
    expect(r1).toBe(r2); // same coalesced result object
    expect(r2).toBe(r3);
    const newQueries = srv.hits.filter((h) => h.endsWith("/devices/current")).length - deviceQueryCount;
    expect(newQueries).toBe(1); // one real sweep, not three
  });

  it("N — partial topology: an unbound stereo partner is never invented", async () => {
    // Device A reports systemId "S1" (a real Devialet stereo pair), but its partner
    // was never bound to this driver instance at all.
    const topo: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startDeviceServer("A", topo);
    servers.push(srv.server);
    const dev = "dev-n" as DeviceId;
    const driver = await bound(srv, dev);

    expect(driver.getTopologySnapshot().systems["S1"]?.memberDeviceIds).toEqual(["A"]);
    // Never fabricated a second member for a device this driver has never observed.
  });

  it("O — duplicate topology observations across repeated sweeps stay idempotent", async () => {
    const topo: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startDeviceServer("A", topo);
    servers.push(srv.server);
    const dev = "dev-o" as DeviceId;
    const driver = await bound(srv, dev);

    const snapshots = [driver.getTopologySnapshot()];
    for (let i = 0; i < 3; i++) {
      await driver.refreshTopology();
      snapshots.push(driver.getTopologySnapshot());
    }
    expect(snapshots[1]).toEqual(snapshots[2]);
    expect(snapshots[2]).toEqual(snapshots[3]);
  });

  it("P — request-count scaling: N devices sharing one System issue exactly N device queries + ONE system-name query per sweep", async () => {
    const topos = ["A", "B", "C", "D", "E"].map((id) => ({ id, topo: { systemId: "S1", groupId: "G1", volume: 40 } as DeviceTopo }));
    const srvs = await Promise.all(topos.map((t) => startDeviceServer(t.id, t.topo)));
    servers.push(...srvs.map((s) => s.server));
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000, topologyRefreshMs: 1_000_000 });
    await driver.connect();
    for (let i = 0; i < srvs.length; i++) {
      await driver.bind({ deviceId: `dev-p-${i}` as DeviceId, capability: "media", address: srvs[i]!.base, config: { path: IP_CONTROL_PATH } });
    }
    const result = await driver.refreshTopology();
    expect(result.changed).toBe(true);
    for (const srv of srvs) {
      expect(srv.hits.filter((h) => h.endsWith("/devices/current"))).toHaveLength(1);
      // Deduped: only the FIRST device sharing systemId "S1" triggers a /systems/current
      // lookup for that system's display name — not one per device.
      const systemNameHits = srv.hits.filter((h) => h.endsWith("/systems/current"));
      expect(systemNameHits.length).toBeLessThanOrEqual(1);
    }
    const totalSystemNameHits = srvs.reduce((n, s) => n + s.hits.filter((h) => h.endsWith("/systems/current")).length, 0);
    expect(totalSystemNameHits).toBe(1); // exactly one, across all 5 devices, for the shared system
  });

  it("Q — reconnect followed by a topology refresh baselines cleanly (no duplicate immediate sweep)", async () => {
    // § D18 — this test needs the OPPOSITE guarantee every other test in this file
    // needs: "less than topologyRefreshMs has elapsed" across operations that include
    // REAL network round trips (bind()'s topology resolution, poll()'s media query).
    // A real sleep can only ever prove "at least N ms elapsed" reliably (CPU
    // scheduling delays a timer, never fires it early) — it can never reliably prove
    // "at most N ms elapsed," which is exactly what "no redundant sweep" requires.
    // Under CPU contention, the real I/O in `bound()`'s own `connect()`+`poll()` can
    // itself take >=30ms, making `poll()`'s own topologyRefreshMs check fire an
    // uninvited sweep before this test ever reaches its own assertions — a real,
    // reproducible flake (see D17/D18 reports), not a driver defect.
    //
    // Fix: mock `Date.now()` so the driver's own elapsed-time arithmetic
    // (`poll()`'s `Date.now() - lastTopologyRefreshAt >= topologyRefreshMs`) is fully
    // controlled by the test, decoupled from real wall-clock speed. Real HTTP I/O and
    // real timers are untouched — only `Date.now()` is mocked, so `connect()`'s
    // timer/`bind()`/`poll()`'s actual async work still runs for real; only the
    // driver's own "how much time has passed" question becomes deterministic.
    const topo: DeviceTopo = { systemId: "S1", groupId: "G1", volume: 40 };
    const srv = await startDeviceServer("A", topo);
    servers.push(srv.server);
    const dev = "dev-q" as DeviceId;

    let now = 1_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const driver = new DevialetProtocolDriver({ pollMs: 1_000_000, topologyRefreshMs: 30 });
      await driver.connect(); // baselines lastTopologyRefreshAt at the mocked "now"
      await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
      await driver.poll(); // real I/O runs, but the mocked clock never advances during it
      const hitsAfterFirstPoll = srv.hits.filter((h) => h.endsWith("/devices/current")).length;
      expect(hitsAfterFirstPoll).toBe(1);

      await driver.disconnect();
      now += 10; // deterministically "10ms later" — well under the 30ms threshold
      await driver.connect(); // re-baselines the clock at this new mocked "now"
      await driver.poll(); // topology already known — no redundant sweep right after reconnect
      expect(srv.hits.filter((h) => h.endsWith("/devices/current")).length).toBe(hitsAfterFirstPoll);
      await driver.disconnect();
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
