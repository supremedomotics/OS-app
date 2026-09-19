import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import { afterEach, describe, expect, it } from "vitest";
import { DevialetProtocolDriver } from "./devialet-driver.js";

/**
 * § D9 — CISettings enrichment/reconciliation. R1 (`devialet-ip-control-client.ts`)
 * remains authoritative for volume/mute/source/media in every case; these tests
 * verify actual state-publication behavior (`getState()`), not merely that a
 * CISettings client method was called. Real in-process HTTP servers, no mocking.
 */

const IP_CONTROL_PATH = "/ipcontrol/v1";
const SOURCE_ID = "213a3ed0-1fb9-4da2-bcf4-066da0f7b27e";

interface CiSettingsFixture {
  volume?: number | { status: number } | "malformed" | "transport";
  mutemode?: string | { status: number };
  source?: string | { status: number };
  powerstate?: string;
}

function startHttp(
  r1: { deviceId: string; systemId: string; groupId: string; volume: number; muted: boolean; source: string },
  ci: CiSettingsFixture = {},
): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const url = req.url ?? "";

      if (url.endsWith("/devices/current")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ deviceId: r1.deviceId, model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: r1.deviceId, systemId: r1.systemId, groupId: r1.groupId, role: "Mono" }));
      }
      if (url.endsWith("/systems/current")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ systemId: r1.systemId, groupId: r1.groupId, systemName: "Room" }));
      }
      if (url.endsWith("/systems/current/sources/current/soundControl/volume")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ volume: r1.volume }));
      }
      if (url.endsWith("/groups/current/sources/current")) {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            source: { sourceId: SOURCE_ID, deviceId: r1.deviceId, type: r1.source },
            playingState: "playing",
            muteState: r1.muted ? "muted" : "unmuted",
            metadata: { artist: "Artist", album: "Album", title: "Track" },
            availableOperations: ["play", "pause"],
          }),
        );
      }
      if (url === "/cisettings/volume") {
        if (ci.volume === "transport") { req.socket.destroy(); return; }
        if (ci.volume === "malformed") { res.statusCode = 200; return res.end("{not json"); }
        if (typeof ci.volume === "object") { res.statusCode = ci.volume.status; return res.end(""); }
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: { volume: ci.volume ?? 0 } }));
      }
      if (url === "/cisettings/mutemode") {
        if (typeof ci.mutemode === "object") { res.statusCode = ci.mutemode.status; return res.end(""); }
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: { mutemode: ci.mutemode ?? "OFF" } }));
      }
      if (url === "/cisettings/source") {
        if (typeof ci.source === "object") { res.statusCode = ci.source.status; return res.end(""); }
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: { source: ci.source ?? "" } }));
      }
      if (url === "/cisettings/powerstate") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: { powerstate: ci.powerstate ?? "running" } }));
      }
      if (url === "/cisettings/internalstate") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: { internalstate: "OK" } }));
      }
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, hits });
    });
  });
}

describe("DevialetProtocolDriver — D9 CISettings enrichment/reconciliation", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  async function bound(srv: Awaited<ReturnType<typeof startHttp>>, dev: DeviceId) {
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    return driver;
  }

  it("A — R1 volume and CISettings volume agree", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { volume: 40 });
    servers.push(srv.server);
    const dev = "dev-a" as DeviceId;
    const driver = await bound(srv, dev);

    const rows = await driver.getCiSettingsReconciliation(dev);
    const volRow = rows?.find((r) => r.field === "volume");
    expect(volRow?.r1Value).toBe(40);
    expect(volRow?.ciSettingsValue).toBe(40);
    expect(volRow?.agree).toBe(true);
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);
  });

  it("B — R1 volume and CISettings volume conflict — R1 remains published", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { volume: 99 });
    servers.push(srv.server);
    const dev = "dev-b" as DeviceId;
    const driver = await bound(srv, dev);

    const rows = await driver.getCiSettingsReconciliation(dev);
    const volRow = rows?.find((r) => r.field === "volume");
    expect(volRow?.r1Value).toBe(40);
    expect(volRow?.ciSettingsValue).toBe(99);
    expect(volRow?.agree).toBe(false);
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);
  });

  it("C — CISettings volume unavailable (HTTP error) — R1 state unaffected", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { volume: { status: 500 } });
    servers.push(srv.server);
    const dev = "dev-c" as DeviceId;
    const driver = await bound(srv, dev);

    const rows = await driver.getCiSettingsReconciliation(dev);
    const volRow = rows?.find((r) => r.field === "volume");
    expect(volRow?.r1Value).toBe(40);
    expect(volRow?.ciSettingsValue).toBeNull();
    expect(volRow?.agree).toBe(false);
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);
  });

  it("D — R1 mute vs CISettings mutemode conflict — R1 remains published", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: true, source: "airplay2" }, { mutemode: "OFF" });
    servers.push(srv.server);
    const dev = "dev-d" as DeviceId;
    const driver = await bound(srv, dev);

    const rows = await driver.getCiSettingsReconciliation(dev);
    const muteRow = rows?.find((r) => r.field === "muted");
    expect(muteRow?.r1Value).toBe(true);
    expect(muteRow?.ciSettingsValue).toBe(false);
    expect(muteRow?.agree).toBe(false);
    expect((driver.getState(dev, "media") as { muted: boolean }).muted).toBe(true);
  });

  it("E — R1 source vs CISettings source conflict — R1 remains published", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { source: "bluetooth" });
    servers.push(srv.server);
    const dev = "dev-e" as DeviceId;
    const driver = await bound(srv, dev);

    const rows = await driver.getCiSettingsReconciliation(dev);
    const srcRow = rows?.find((r) => r.field === "source");
    expect(srcRow?.r1Value).toBe("airplay2");
    expect(srcRow?.ciSettingsValue).toBe("bluetooth");
    expect(srcRow?.agree).toBe(false);
    expect((driver.getState(dev, "media") as { source: string }).source).toBe("airplay2");
  });

  it("F/G — CISettings powerstate is readable but stays diagnostic-only", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { powerstate: "starting" });
    servers.push(srv.server);
    const dev = "dev-f" as DeviceId;
    const driver = await bound(srv, dev);

    const power = await driver.getCiSettingsPowerState(dev);
    expect(power).toBe("starting");
    // Never bound to a capability — no "onoff" state exists for this device.
    expect(driver.getState(dev, "onoff")).toBeNull();
  });

  it("H — CISettings-only diagnostic info (internalstate) is available without touching media state", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" });
    servers.push(srv.server);
    const dev = "dev-h" as DeviceId;
    const driver = await bound(srv, dev);

    const internal = await driver.getCiSettingsInternalState(dev);
    expect(internal).toBe("OK");
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);
  });

  it("I — CISettings malformed response is isolated to its own field", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { volume: "malformed" });
    servers.push(srv.server);
    const dev = "dev-i" as DeviceId;
    const driver = await bound(srv, dev);

    const rows = await driver.getCiSettingsReconciliation(dev);
    expect(rows?.find((r) => r.field === "volume")?.ciSettingsValue).toBeNull();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);
  });

  it("J — CISettings HTTP error is isolated to its own field", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { mutemode: { status: 404 } });
    servers.push(srv.server);
    const dev = "dev-j" as DeviceId;
    const driver = await bound(srv, dev);

    const rows = await driver.getCiSettingsReconciliation(dev);
    expect(rows?.find((r) => r.field === "muted")?.ciSettingsValue).toBeNull();
    expect(rows?.find((r) => r.field === "volume")?.ciSettingsValue).toBe(0);
  });

  it("K — CISettings transport error is isolated to its own field", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { volume: "transport" });
    servers.push(srv.server);
    const dev = "dev-k" as DeviceId;
    const driver = await bound(srv, dev);

    const rows = await driver.getCiSettingsReconciliation(dev);
    expect(rows?.find((r) => r.field === "volume")?.ciSettingsValue).toBeNull();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(40);
  });

  it("L/M — two devices with different CISettings results never cross-contaminate, survives an IP change", async () => {
    const srvA = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { volume: 40 });
    const srvB = await startHttp({ deviceId: "B", systemId: "S2", groupId: "G2", volume: 70, muted: false, source: "bluetooth" }, { volume: 10 });
    servers.push(srvA.server, srvB.server);
    const devA = "dev-l-a" as DeviceId;
    const devB = "dev-l-b" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: devA, capability: "media", address: srvA.base, config: { path: IP_CONTROL_PATH } });
    await driver.bind({ deviceId: devB, capability: "media", address: srvB.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();

    const rowsA = await driver.getCiSettingsReconciliation(devA);
    const rowsB = await driver.getCiSettingsReconciliation(devB);
    expect(rowsA?.find((r) => r.field === "volume")?.r1Value).toBe(40);
    expect(rowsA?.find((r) => r.field === "volume")?.ciSettingsValue).toBe(40);
    expect(rowsB?.find((r) => r.field === "volume")?.r1Value).toBe(70);
    expect(rowsB?.find((r) => r.field === "volume")?.ciSettingsValue).toBe(10);

    // § M — rebind devA to a new "IP" (srvB's address, simulating a real IP change)
    // and confirm the CISettings reconciliation is keyed by the stable binding, not
    // by host/IP — no residual state leaks between the two logical devices.
    await driver.unbind(devA);
    await driver.bind({ deviceId: devA, capability: "media", address: srvB.base, config: { path: IP_CONTROL_PATH } });
    await driver.poll();
    const rowsAAfterMove = await driver.getCiSettingsReconciliation(devA);
    expect(rowsAAfterMove?.find((r) => r.field === "volume")?.r1Value).toBe(70);
    expect(rowsAAfterMove?.find((r) => r.field === "volume")?.ciSettingsValue).toBe(10);
  });

  it("N — R1 state remains valid when every CISettings field fails", async () => {
    const srv = await startHttp(
      { deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" },
      { volume: { status: 500 }, mutemode: { status: 500 }, source: { status: 500 } },
    );
    servers.push(srv.server);
    const dev = "dev-n" as DeviceId;
    const driver = await bound(srv, dev);

    const rows = await driver.getCiSettingsReconciliation(dev);
    expect(rows?.every((r) => r.ciSettingsValue === null)).toBe(true);
    const state = driver.getState(dev, "media") as { volume: number; muted: boolean; source: string };
    expect(state.volume).toBe(40);
    expect(state.muted).toBe(false);
    expect(state.source).toBe("airplay2");
  });

  it("O — CISettings cannot overwrite authoritative R1 media state across repeated reconciliation calls", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { volume: 5, mutemode: "ON", source: "bluetooth" });
    servers.push(srv.server);
    const dev = "dev-o" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.getCiSettingsReconciliation(dev);
    await driver.getCiSettingsReconciliation(dev);
    const state = driver.getState(dev, "media") as { volume: number; muted: boolean; source: string };
    expect(state.volume).toBe(40);
    expect(state.muted).toBe(false);
    expect(state.source).toBe("airplay2");
  });

  it("P — getAll/getLean remain unused by the D9 reconciliation path", async () => {
    const srv = await startHttp({ deviceId: "A", systemId: "S1", groupId: "G1", volume: 40, muted: false, source: "airplay2" }, { volume: 40 });
    servers.push(srv.server);
    const dev = "dev-p" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.getCiSettingsReconciliation(dev);
    expect(srv.hits.some((h) => h.includes("/cisettings/getall") || h.includes("/cisettings/getlean"))).toBe(false);
  });
});
