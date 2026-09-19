import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, describe, expect, it } from "vitest";
import { DevialetProtocolDriver } from "./devialet-driver.js";

/**
 * § D8 — real-time media state, Group→physical-device projection, and album-art
 * integration. Real in-process HTTP servers throughout — no mocking framework.
 * Pure command-routing (D7) and pure topology reconciliation (D6) are unchanged and
 * not retested here; see their own dedicated test files.
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

/** A real (non-JSON) image server, for artwork-fetch tests. */
function startImageServer(bytes: Buffer, contentType = "image/jpeg"): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.end(bytes);
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

interface MediaFixture {
  volume?: number;
  playingState?: "playing" | "paused";
  muteState?: "muted" | "unmuted";
  artist?: string;
  album?: string;
  title?: string;
  coverArtUrl?: string;
  availableOperations?: string[];
  sourceType?: string;
  sourceHostDeviceId?: string;
  noMetadata?: boolean;
  noCurrentSource?: boolean;
  volumeStatus?: number;
  groupStatus?: number;
  groupError?: { code: string };
  malformedGroup?: boolean;
}

function deviceServer(deviceId: string, system: { systemId: string; groupId: string; role: string } | null, media: MediaFixture = {}) {
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
      if (media.volumeStatus) return { status: media.volumeStatus, body: "" };
      return { body: JSON.stringify({ volume: media.volume ?? 50 }) };
    }
    if (url.endsWith("/groups/current/sources/current")) {
      if (media.groupStatus) return { status: media.groupStatus, body: "" };
      if (media.malformedGroup) return { status: 200, body: "{not json" };
      if (media.groupError) return { status: 200, body: JSON.stringify({ error: media.groupError }) };
      if (media.noCurrentSource) return { status: 200, body: JSON.stringify({ error: { code: "NoCurrentSource" } }) };
      return {
        body: JSON.stringify({
          source: { sourceId: SOURCE_ID, deviceId: media.sourceHostDeviceId ?? deviceId, type: media.sourceType ?? "spotifyconnect" },
          playingState: media.playingState ?? "playing",
          muteState: media.muteState ?? "unmuted",
          ...(media.noMetadata
            ? {}
            : { metadata: { artist: media.artist ?? "Artist", album: media.album ?? "Album", title: media.title ?? "Track", ...(media.coverArtUrl ? { coverArtUrl: media.coverArtUrl } : {}) } }),
          availableOperations: media.availableOperations ?? ["play", "pause", "next", "previous"],
        }),
      };
    }
    return { body: "{}" };
  };
}

describe("DevialetProtocolDriver — D8 real-time media state, projection, artwork", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  async function bound(srv: Awaited<ReturnType<typeof startHttp>>, dev: DeviceId, driverOpts: ConstructorParameters<typeof DevialetProtocolDriver>[0] = { pollMs: 1_000_000 }) {
    const driver = new DevialetProtocolDriver(driverOpts);
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });
    return driver;
  }

  it("A/B — a single device's current source poll() produces a real, playing MediaState", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume: 40, playingState: "playing" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    const state = driver.getState(dev, "media") as { volume: number; playback: string };
    expect(state.volume).toBe(40);
    expect(state.playback).toBe("playing");

    await driver.disconnect();
  });

  it("C — paused media retains its metadata", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { playingState: "paused", title: "Paused Track" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    const state = driver.getState(dev, "media") as { playback: string; title: string | null };
    expect(state.playback).toBe("paused");
    expect(state.title).toBe("Paused Track");

    await driver.disconnect();
  });

  it("D — muted state is reported independently of playingState (playing + muted)", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { playingState: "playing", muteState: "muted" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    const state = driver.getState(dev, "media") as { playback: string; muted: boolean };
    expect(state.playback).toBe("playing");
    expect(state.muted).toBe(true);

    await driver.disconnect();
  });

  it("E/F/G/H — artist/album/title/source map exactly from the R1 response", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { artist: "Michael Jackson", album: "Thriller", title: "Billie Jean", sourceType: "spotifyconnect" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    const state = driver.getState(dev, "media") as { artist: string | null; album: string | null; title: string | null; source: string | null };
    expect(state.artist).toBe("Michael Jackson");
    expect(state.album).toBe("Thriller");
    expect(state.title).toBe("Billie Jean");
    expect(state.source).toBe("spotifyconnect");

    await driver.disconnect();
  });

  it("I — availableOperations is preserved via the existing generic advanced field", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { availableOperations: ["play", "pause", "seek"] }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    const state = driver.getState(dev, "media") as { advanced: { availableOperations: string[] } | null };
    expect(state.advanced?.availableOperations).toEqual(["play", "pause", "seek"]);

    await driver.disconnect();
  });

  it("J — missing metadata never fabricates artist/album/title", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { noMetadata: true }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    const state = driver.getState(dev, "media") as { artist: string | null; album: string | null; title: string | null };
    expect(state.artist).toBeNull();
    expect(state.album).toBeNull();
    expect(state.title).toBeNull();

    await driver.disconnect();
  });

  it("K — coverArtUrl maps to the gateway's own artwork-proxy URL, never R1's raw URL, in MediaState", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { coverArtUrl: "http://192.168.1.5/art/current.jpg" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev, { pollMs: 1_000_000, artworkUrlFor: (id) => `https://gateway.local/v1/devices/${id}/media/artwork` });

    await driver.poll();
    const state = driver.getState(dev, "media") as { artworkUrl: string | null };
    expect(state.artworkUrl).toBe(`https://gateway.local/v1/devices/${dev}/media/artwork`);

    await driver.disconnect();
  });

  it("K — artworkUrl is null when no artworkUrlFor callback is configured (never a raw LAN URL leaked into MediaState)", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { coverArtUrl: "http://192.168.1.5/art/current.jpg" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    const state = driver.getState(dev, "media") as { artworkUrl: string | null };
    expect(state.artworkUrl).toBeNull();

    await driver.disconnect();
  });

  it("L — getArtwork() fetches real bytes from R1's raw coverArtUrl", async () => {
    const artBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const artSrv = await startImageServer(artBytes);
    servers.push(artSrv.server);
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { coverArtUrl: `${artSrv.base}/art.jpg` }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);
    await driver.poll();

    const artwork = await driver.getArtwork(dev);
    expect(artwork).not.toBeNull();
    expect(artwork!.contentType).toBe("image/jpeg");
    expect(Buffer.from(artwork!.data)).toEqual(artBytes);
    expect(artSrv.hits).toHaveLength(1);

    await driver.disconnect();
  });

  it("getArtwork() returns null (never fabricates) when no artwork has ever been observed", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" })); // no coverArtUrl
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);
    await driver.poll();

    expect(await driver.getArtwork(dev)).toBeNull();

    await driver.disconnect();
  });

  it("M/O — two physical devices sharing one Group and the same artwork URL trigger exactly ONE real download", async () => {
    const artBytes = Buffer.from([1, 2, 3, 4]);
    const artSrv = await startImageServer(artBytes);
    servers.push(artSrv.server);
    const artUrl = `${artSrv.base}/shared.jpg`;
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "FrontLeft" }, { coverArtUrl: artUrl, artist: "Shared Artist" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S1", groupId: "G1", role: "FrontRight" }, { coverArtUrl: artUrl, artist: "Shared Artist" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const devA = "device-a" as DeviceId;
    const devB = "device-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: devB, capability: "media", ...bindAddress(srvB.base) });
    await driver.poll();

    const [artworkA, artworkB] = await Promise.all([driver.getArtwork(devA), driver.getArtwork(devB)]);
    expect(Buffer.from(artworkA!.data)).toEqual(artBytes);
    expect(Buffer.from(artworkB!.data)).toEqual(artBytes);
    expect(artSrv.hits).toHaveLength(1); // coalesced — one real download for both devices

    // Same-group media state itself is identical too (§O).
    const stateA = driver.getState(devA, "media") as { artist: string | null };
    const stateB = driver.getState(devB, "media") as { artist: string | null };
    expect(stateA.artist).toBe("Shared Artist");
    expect(stateB.artist).toBe("Shared Artist");

    await driver.disconnect();
  });

  it("N — different artwork URLs remain isolated (two independent fetches, correct bytes per device)", async () => {
    const bytesX = Buffer.from([0xaa]);
    const bytesY = Buffer.from([0xbb]);
    const artSrvX = await startImageServer(bytesX);
    const artSrvY = await startImageServer(bytesY);
    servers.push(artSrvX.server, artSrvY.server);
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { coverArtUrl: `${artSrvX.base}/x.jpg` }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S2", groupId: "G2", role: "Mono" }, { coverArtUrl: `${artSrvY.base}/y.jpg` }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const devA = "device-a" as DeviceId;
    const devB = "device-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: devB, capability: "media", ...bindAddress(srvB.base) });
    await driver.poll();

    const artworkA = await driver.getArtwork(devA);
    const artworkB = await driver.getArtwork(devB);
    expect(Buffer.from(artworkA!.data)).toEqual(bytesX);
    expect(Buffer.from(artworkB!.data)).toEqual(bytesY);

    await driver.disconnect();
  });

  it("P — two independent Systems sharing one Group: media is shared, volume is queried per-system, group query happens once", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume: 10, title: "Shared Track" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S2", groupId: "G1", role: "Mono" }, { volume: 20, title: "Shared Track" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const devA = "device-a" as DeviceId;
    const devB = "device-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: devB, capability: "media", ...bindAddress(srvB.base) });
    await driver.poll();

    const stateA = driver.getState(devA, "media") as { volume: number; title: string | null };
    const stateB = driver.getState(devB, "media") as { volume: number; title: string | null };
    expect(stateA.volume).toBe(10); // own system's volume
    expect(stateB.volume).toBe(20); // own system's volume
    expect(stateA.title).toBe("Shared Track"); // shared group's media
    expect(stateB.title).toBe("Shared Track");

    // Group query issued exactly once total (dedup across A and B) — whichever
    // device's host happened to be queried first receives the one real hit.
    const groupHits = srvA.hits.filter((h) => h.includes("/groups/current/sources/current")).length + srvB.hits.filter((h) => h.includes("/groups/current/sources/current")).length;
    expect(groupHits).toBe(1);

    await driver.disconnect();
  });

  it("Q — two independent Groups never cross-contaminate media", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { title: "Track A", coverArtUrl: "http://host/x.jpg" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S2", groupId: "G2", role: "Mono" }, { title: "Track B", coverArtUrl: "http://host/y.jpg" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    const devA = "device-a" as DeviceId;
    const devB = "device-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: devB, capability: "media", ...bindAddress(srvB.base) });
    await driver.poll();

    expect((driver.getState(devA, "media") as { title: string | null }).title).toBe("Track A");
    expect((driver.getState(devB, "media") as { title: string | null }).title).toBe("Track B");

    await driver.disconnect();
  });

  it("R — a Group change updates the physical device's media on the next refresh, never leaving stale data", async () => {
    let groupId = "G1";
    let title = "Old Track";
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId, role: "Mono" }, { title })(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);
    await driver.poll();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("Old Track");

    groupId = "G2";
    title = "New Track";
    await driver.refreshTopology();
    await driver.poll();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("New Track");

    await driver.disconnect();
  });

  it("S — a System change updates the physical device's volume on the next refresh", async () => {
    let systemId = "S1";
    let volume = 10;
    const srv = await startHttp((url) => deviceServer("A", { systemId, groupId: "G1", role: "Mono" }, { volume })(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);
    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(10);

    systemId = "S2";
    volume = 70;
    await driver.refreshTopology();
    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(70);

    await driver.disconnect();
  });

  it("T/U — an unknown Group never fabricates media state; system-only topology is not enough on its own", async () => {
    const srv = await startHttp((url) => {
      if (url.endsWith("/devices/current")) return { body: JSON.stringify({ deviceId: "A", model: "Phantom I", release: { version: "2.14.2" }, serial: "S1", deviceName: "A", systemId: "S1" }) }; // no groupId, ever
      if (url.endsWith("/systems/current")) return { body: JSON.stringify({ systemId: "S1", groupId: "G1", systemName: "A" }) };
      if (url.endsWith("/systems/current/sources/current/soundControl/volume")) return { body: JSON.stringify({ volume: 30 }) };
      return { body: "{}" };
    });
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    expect(driver.getState(dev, "media")).toBeNull(); // no fabricated media state
    expect(driver.getDeviceTopology(dev)).toMatchObject({ systemId: "S1", groupId: null }); // system topology IS known

    await driver.disconnect();
  });

  it("V — a real NoCurrentSource logical error publishes an honest idle state (§ D10 — a confirmed answer, not a failure) and does not throw", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { noCurrentSource: true }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await expect(driver.poll()).resolves.toBeUndefined();
    const state = driver.getState(dev, "media") as { playback: string; muted: boolean; title: string | null; source: string | null } | null;
    expect(state).not.toBeNull();
    expect(state!.playback).toBe("idle");
    expect(state!.muted).toBe(false);
    expect(state!.title).toBeNull();
    expect(state!.source).toBeNull();

    await driver.disconnect();
  });

  it("W — an unrelated R1 logical error also publishes no media state", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { groupError: { code: "UnreachableDevices" } }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await expect(driver.poll()).resolves.toBeUndefined();
    expect(driver.getState(dev, "media")).toBeNull();

    await driver.disconnect();
  });

  it("X — an HTTP failure on the group query publishes no media state", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { groupStatus: 500 }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await expect(driver.poll()).resolves.toBeUndefined();
    expect(driver.getState(dev, "media")).toBeNull();

    await driver.disconnect();
  });

  it("Y — a transport failure (unreachable host) publishes no media state", async () => {
    const dev = "device-a" as DeviceId;
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: "http://127.0.0.1:1", config: { path: IP_CONTROL_PATH } });

    await expect(driver.poll()).resolves.toBeUndefined();
    expect(driver.getState(dev, "media")).toBeNull();

    await driver.disconnect();
  });

  it("Z — a malformed group response publishes no media state", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { malformedGroup: true }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await expect(driver.poll()).resolves.toBeUndefined();
    expect(driver.getState(dev, "media")).toBeNull();

    await driver.disconnect();
  });

  it("AA/AB — repeated identical state emits no duplicate event; a real title change emits exactly one more", async () => {
    let title = "Track A";
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { title })(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);
    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));

    await driver.poll();
    await driver.poll();
    await driver.poll();
    expect(events.length).toBe(1);

    title = "Track B";
    await driver.poll();
    expect(events.length).toBe(2);
    expect((events[1]!.state as { title: string | null }).title).toBe("Track B");

    await driver.disconnect();
  });

  it("state-change detection also covers playingState/muteState/artist/album/source", async () => {
    let fixture: MediaFixture = { playingState: "paused", muteState: "unmuted", artist: "A1", album: "AL1", sourceType: "bluetooth" };
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, fixture)(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);
    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));

    await driver.poll();
    expect(events.length).toBe(1);

    fixture = { ...fixture, playingState: "playing" };
    await driver.poll();
    expect(events.length).toBe(2);

    fixture = { ...fixture, muteState: "muted" };
    await driver.poll();
    expect(events.length).toBe(3);

    fixture = { ...fixture, artist: "A2" };
    await driver.poll();
    expect(events.length).toBe(4);

    fixture = { ...fixture, album: "AL2" };
    await driver.poll();
    expect(events.length).toBe(5);

    fixture = { ...fixture, sourceType: "airplay2" };
    await driver.poll();
    expect(events.length).toBe(6);

    await driver.disconnect();
  });

  it("AC — getArtwork() reflects the current track's coverArtUrl across polls as it changes", async () => {
    const bytes1 = Buffer.from([1]);
    const bytes2 = Buffer.from([2]);
    const art1 = await startImageServer(bytes1);
    const art2 = await startImageServer(bytes2);
    servers.push(art1.server, art2.server);
    let coverArtUrl = `${art1.base}/1.jpg`;
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { coverArtUrl })(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    expect(Buffer.from((await driver.getArtwork(dev))!.data)).toEqual(bytes1);

    coverArtUrl = `${art2.base}/2.jpg`;
    await driver.poll();
    expect(Buffer.from((await driver.getArtwork(dev))!.data)).toEqual(bytes2);

    await driver.disconnect();
  });

  it("AD — a successful command never creates speculative media state; only the next poll() does", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume: 33 }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    expect(driver.getState(dev, "media")).toBeNull();
    await driver.command(dev, { capability: "media", action: "volume", volume: 77 });
    expect(driver.getState(dev, "media")).toBeNull();

    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number }).volume).toBe(33); // real value, not 77

    await driver.disconnect();
  });

  it("AE — N devices in the same Group never cause N duplicate Group media queries within one poll()", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S2", groupId: "G1", role: "Mono" }));
    const srvC = await startHttp(deviceServer("C", { systemId: "S3", groupId: "G1", role: "Mono" }));
    servers.push(srvA.server, srvB.server, srvC.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: "device-a" as DeviceId, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: "device-b" as DeviceId, capability: "media", ...bindAddress(srvB.base) });
    await driver.bind({ deviceId: "device-c" as DeviceId, capability: "media", ...bindAddress(srvC.base) });

    await driver.poll();
    const totalGroupHits = [srvA, srvB, srvC].reduce((sum, s) => sum + s.hits.filter((h) => h.includes("/groups/current/sources/current")).length, 0);
    expect(totalGroupHits).toBe(1);

    await driver.disconnect();
  });

  it("AF/AG — two driver instances remain isolated with no module-level mutable state", async () => {
    const srv1 = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume: 10, title: "Instance 1" }));
    const srv2 = await startHttp(deviceServer("A", { systemId: "S9", groupId: "G9", role: "Mono" }, { volume: 90, title: "Instance 2" }));
    servers.push(srv1.server, srv2.server);
    const dev = "device-a" as DeviceId;
    const driver1 = await bound(srv1, dev);
    const driver2 = await bound(srv2, dev);

    await driver1.poll();
    await driver2.poll();
    expect((driver1.getState(dev, "media") as { volume: number; title: string | null }).volume).toBe(10);
    expect((driver2.getState(dev, "media") as { volume: number; title: string | null }).volume).toBe(90);
    expect((driver1.getState(dev, "media") as { title: string | null }).title).toBe("Instance 1");
    expect((driver2.getState(dev, "media") as { title: string | null }).title).toBe("Instance 2");

    await driver1.disconnect();
    await driver2.disconnect();
  });

  it("AH — the real bind() -> poll() lifecycle (NO manual refreshTopology()) self-resolves topology and populates media state", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume: 55, title: "Lifecycle Track" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);
    // No refreshTopology() call — this is the actual gateway lifecycle.

    await driver.poll();
    const state = driver.getState(dev, "media") as { volume: number; title: string | null };
    expect(state.volume).toBe(55);
    expect(state.title).toBe("Lifecycle Track");
    expect(srv.hits.filter((h) => h.endsWith("/devices/current"))).toHaveLength(1); // exactly one on-demand identity query

    await driver.disconnect();
  });
});

describe("DevialetProtocolDriver — D8 final fix: incremental media-state merge (system volume vs group media are independent)", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  async function bound(srv: Awaited<ReturnType<typeof startHttp>>, dev: DeviceId) {
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", ...bindAddress(srv.base) });
    return driver;
  }

  it("A — group media succeeds while system volume fails: state is still published with fresh media fields and last-known volume retained", async () => {
    let volumeStatus: number | undefined;
    let title = "Track One";
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume: 25, title, volumeStatus })(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    // Tick 1 — both succeed, establishing a known volume (25).
    await driver.poll();
    expect((driver.getState(dev, "media") as { volume: number; title: string | null }).volume).toBe(25);

    // Tick 2 — volume query now fails; group media still succeeds with a new title.
    volumeStatus = 500;
    title = "Track Two (volume down)";
    await driver.poll();
    const state = driver.getState(dev, "media") as { volume: number; title: string | null };
    expect(state.title).toBe("Track Two (volume down)"); // fresh media field present
    expect(state.volume).toBe(25); // previous volume retained, never fabricated

    await driver.disconnect();
  });

  it("B — system volume succeeds while group media fails: state is still published with fresh volume and last-known media fields retained", async () => {
    let groupStatus: number | undefined;
    let volume = 10;
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume, title: "Stable Track", groupStatus })(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    // Tick 1 — both succeed, establishing known media (title "Stable Track").
    await driver.poll();
    expect((driver.getState(dev, "media") as { title: string | null }).title).toBe("Stable Track");

    // Tick 2 — group query now fails; volume still succeeds with a new value.
    groupStatus = 500;
    volume = 88;
    await driver.poll();
    const state = driver.getState(dev, "media") as { volume: number; title: string | null; muted: boolean };
    expect(state.volume).toBe(88); // fresh volume/mute present
    expect(state.title).toBe("Stable Track"); // previous media fields retained, never fabricated

    await driver.disconnect();
  });

  it("C — both halves succeed: the merged state contains fresh values from both", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume: 42, title: "Fresh Both" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    const state = driver.getState(dev, "media") as { volume: number; title: string | null };
    expect(state.volume).toBe(42);
    expect(state.title).toBe("Fresh Both");

    await driver.disconnect();
  });

  it("D — neither succeeds and there is no prior state: no fabricated MediaState is published", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volumeStatus: 500, groupStatus: 500 }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await expect(driver.poll()).resolves.toBeUndefined();
    expect(driver.getState(dev, "media")).toBeNull();

    await driver.disconnect();
  });

  it("D (edge case) — group succeeds on the very first tick but volume has NEVER been observed: still no publish (volume has no honest 'unknown' representation)", async () => {
    const srv = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volumeStatus: 500, title: "Never Published" }));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    expect(driver.getState(dev, "media")).toBeNull(); // volume never observed — cannot construct a valid state

    await driver.disconnect();
  });

  it("E — a failed refresh (both halves fail on a later tick) does not erase previously known fields", async () => {
    let volumeStatus: number | undefined;
    let groupStatus: number | undefined;
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume: 15, title: "Persisted Track", volumeStatus, groupStatus })(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll();
    const before = driver.getState(dev, "media") as { volume: number; title: string | null };
    expect(before.volume).toBe(15);
    expect(before.title).toBe("Persisted Track");

    volumeStatus = 500;
    groupStatus = 500;
    await driver.poll();
    const after = driver.getState(dev, "media") as { volume: number; title: string | null };
    expect(after).toEqual(before); // completely unchanged — nothing erased, nothing re-published

    await driver.disconnect();
  });

  it("F — group query deduplication is unchanged: N devices sharing one Group still produce exactly one Group query per poll(), even mid-merge", async () => {
    const srvA = await startHttp(deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }));
    const srvB = await startHttp(deviceServer("B", { systemId: "S2", groupId: "G1", role: "Mono" }));
    servers.push(srvA.server, srvB.server);
    const driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: "device-a" as DeviceId, capability: "media", ...bindAddress(srvA.base) });
    await driver.bind({ deviceId: "device-b" as DeviceId, capability: "media", ...bindAddress(srvB.base) });

    await driver.poll();
    const totalGroupHits = srvA.hits.filter((h) => h.includes("/groups/current/sources/current")).length + srvB.hits.filter((h) => h.includes("/groups/current/sources/current")).length;
    expect(totalGroupHits).toBe(1);
    // Volume remains per-system — two distinct system queries.
    const totalVolumeHits = srvA.hits.filter((h) => h.includes("/soundControl/volume")).length + srvB.hits.filter((h) => h.includes("/soundControl/volume")).length;
    expect(totalVolumeHits).toBe(2);

    await driver.disconnect();
  });

  it("G — existing artwork behavior is unchanged: coverArtUrl updates whenever the group half succeeds, and getArtwork() still coalesces by URL", async () => {
    const artBytes = Buffer.from([9, 9, 9]);
    const artSrv = await startImageServer(artBytes);
    servers.push(artSrv.server);
    let volumeStatus: number | undefined;
    const srv = await startHttp((url) => deviceServer("A", { systemId: "S1", groupId: "G1", role: "Mono" }, { volume: 20, coverArtUrl: `${artSrv.base}/art.jpg`, volumeStatus })(url));
    servers.push(srv.server);
    const dev = "device-a" as DeviceId;
    const driver = await bound(srv, dev);

    await driver.poll(); // establishes both halves, including artwork
    expect(Buffer.from((await driver.getArtwork(dev))!.data)).toEqual(artBytes);

    // Volume fails on the next tick, but the group half (and therefore artwork)
    // still updates independently — artwork tracking is untouched by the merge fix.
    volumeStatus = 500;
    await driver.poll();
    expect(Buffer.from((await driver.getArtwork(dev))!.data)).toEqual(artBytes);
    expect(artSrv.hits.length).toBeGreaterThan(0);

    await driver.disconnect();
  });
});
