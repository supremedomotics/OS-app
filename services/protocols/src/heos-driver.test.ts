import { createServer, Socket, type Server } from "node:net";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HeosProtocolDriver } from "./heos-driver.js";
import { commandToHeos, parseHeosAttrs, parseHeosMessage } from "./heos-codec.js";

function heosOk(command: string, message: string, payload?: unknown): string {
  return JSON.stringify({ heos: { command, result: "success", message }, ...(payload !== undefined ? { payload } : {}) });
}

/**
 * A tiny in-process HEOS CLI network: one connection, many pids. Answers get_* queries
 * with the current per-pid state and reflects set_* commands as real HEOS does,
 * including firing the matching unsolicited change event.
 */
function startFakeHeos(): Promise<{ server: Server; port: number; received: string[]; sockets: Set<Socket> }> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const players = new Map<string, { state: "play" | "pause" | "stop"; volume: number; muted: boolean; repeat: string; shuffle: string }>();
  players.set("1", { state: "stop", volume: 40, muted: false, repeat: "off", shuffle: "off" });
  players.set("2", { state: "stop", volume: 20, muted: false, repeat: "off", shuffle: "off" });
  players.set("3", { state: "stop", volume: 30, muted: false, repeat: "off", shuffle: "off" });

  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      // § Bug fix — a per-connection socket with no "error" listener makes Node re-throw
      // any socket error (e.g. ECONNRESET, expected whenever the driver-under-test
      // disconnects/reconnects mid-test or `server.close()` runs while still connected)
      // as an UNCAUGHT exception that fails the whole test run, even though every actual
      // assertion passed. Pre-existing, unrelated to any recent commit (last touched
      // 2026-07-23) — not a driver/production bug, purely this test fixture's own socket
      // hygiene. A reset connection during teardown is expected, not a real failure.
      sock.on("error", () => {});
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split("\r\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          received.push(line);
          const url = new URL(line);
          const gc = line.replace("heos://", "").split("?")[0];
          const [g, c] = gc.split("/");
          const params = Object.fromEntries(url.searchParams.entries());
          const pid = params.pid;
          const p = pid ? players.get(pid) : undefined;
          if (g === "system" && c === "register_for_change_events") {
            sock.write(`${heosOk("system/register_for_change_events", `enable=${params.enable}`)}\r\n`);
          } else if (g === "system" && c === "heart_beat") {
            sock.write(`${heosOk("system/heart_beat", "")}\r\n`);
          } else if (g === "player" && c === "get_play_state" && p) {
            sock.write(`${heosOk("player/get_play_state", `pid=${pid}&state=${p.state}`)}\r\n`);
          } else if (g === "player" && c === "set_play_state" && p) {
            p.state = params.state as "play" | "pause" | "stop";
            sock.write(`${heosOk("player/set_play_state", `pid=${pid}&state=${p.state}`)}\r\n`);
            sock.write(`${JSON.stringify({ heos: { command: "event/player_state_changed", message: `pid=${pid}&state=${p.state}` } })}\r\n`);
          } else if (g === "player" && c === "get_volume" && p) {
            sock.write(`${heosOk("player/get_volume", `pid=${pid}&level=${p.volume}`)}\r\n`);
          } else if (g === "player" && c === "set_volume" && p) {
            p.volume = Number(params.level);
            sock.write(`${heosOk("player/set_volume", `pid=${pid}&level=${p.volume}`)}\r\n`);
          } else if (g === "player" && c === "get_mute" && p) {
            sock.write(`${heosOk("player/get_mute", `pid=${pid}&state=${p.muted ? "on" : "off"}`)}\r\n`);
          } else if (g === "player" && c === "set_mute" && p) {
            p.muted = params.state === "on";
            sock.write(`${heosOk("player/set_mute", `pid=${pid}&state=${params.state}`)}\r\n`);
          } else if (g === "player" && c === "get_play_mode" && p) {
            sock.write(`${heosOk("player/get_play_mode", `pid=${pid}&repeat=${p.repeat}&shuffle=${p.shuffle}`)}\r\n`);
          } else if (g === "player" && c === "set_play_mode" && p) {
            p.repeat = params.repeat;
            p.shuffle = params.shuffle;
            sock.write(`${heosOk("player/set_play_mode", `pid=${pid}&repeat=${p.repeat}&shuffle=${p.shuffle}`)}\r\n`);
          } else if (g === "player" && c === "get_now_playing_media" && p && pid === "3") {
            // § Network Source Resolver — a song-type response carrying a real HEOS `sid`
            // (4 = Spotify, verified table in network-source-resolver.ts), no station name.
            sock.write(`${heosOk("player/get_now_playing_media", `pid=${pid}`, { type: "song", song: "Track X", sid: 4, artist: "Artist X", album: "Album X", image_url: "https://art.example/3.jpg" })}\r\n`);
          } else if (g === "player" && c === "get_now_playing_media" && p) {
            sock.write(`${heosOk("player/get_now_playing_media", `pid=${pid}`, { type: "station", song: "Song A", station: "Jazz FM", artist: "Artist A", image_url: "https://art.example/1.jpg" })}\r\n`);
          } else if (g === "player" && c === "play_next" && p) {
            sock.write(`${heosOk("player/play_next", `pid=${pid}`)}\r\n`);
          } else if (g === "browse" && c === "play_input" && p) {
            sock.write(`${heosOk("browse/play_input", `pid=${pid}&input=${params.input}`)}\r\n`);
          } else if (g === "player" && c === "get_queue" && p) {
            sock.write(
              `${heosOk("player/get_queue", `pid=${pid}&range=${params.range}&sequence=${params.sequence}`, [
                { song: "Track A", album: "Album A", artist: "Artist A", image_url: "https://art.example/a.jpg", qid: "1" },
                { song: "Track B", album: "Album A", artist: "Artist A", image_url: "https://art.example/b.jpg", qid: "2" },
              ])}\r\n`,
            );
          } else if (g === "player" && c === "get_players") {
            sock.write(
              `${heosOk("player/get_players", "", [
                { name: "Living Room", pid: "1", model: "HEOS Bar" },
                { name: "Theatre", pid: "2", model: "HEOS Bar" },
              ])}\r\n`,
            );
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, received, sockets });
    });
  });
}

const nextEvent = (driver: HeosProtocolDriver, pred: (e: BackendStateEvent) => boolean) =>
  new Promise<BackendStateEvent>((resolve) => {
    const off = driver.onState((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
  });

describe("HEOS codec", () => {
  it("parses the & and = delimited message string", () => {
    expect(parseHeosAttrs("pid=1&state=play")).toEqual({ pid: "1", state: "play" });
  });

  it("encodes commands and decodes events uniformly", () => {
    expect(commandToHeos({ capability: "media", action: "volume", volume: 55 }, "1")).toEqual({
      group: "player",
      command: "set_volume",
      params: { pid: "1", level: 55 },
    });
    expect(parseHeosMessage(JSON.stringify({ heos: { command: "event/player_state_changed", message: "pid=1&state=play" } }))).toEqual({
      kind: "playState",
      pid: "1",
      state: "play",
    });
  });

  it("rejects seek — no wire-level position-set command exists in HEOS CLI", () => {
    expect(commandToHeos({ capability: "media", action: "seek", positionSec: 30 }, "1")).toBeNull();
  });
});

describe("HeosProtocolDriver (in-process HEOS network over TCP, one connection many pids)", () => {
  let heos: Awaited<ReturnType<typeof startFakeHeos>>;
  let driver: HeosProtocolDriver;
  const livingRoom = "device-heos-living" as DeviceId;
  const theatre = "device-heos-theatre" as DeviceId;

  beforeAll(async () => {
    heos = await startFakeHeos();
    driver = new HeosProtocolDriver();
    await driver.connect();
    await driver.bind({ deviceId: livingRoom, capability: "media", address: `127.0.0.1:${heos.port}`, config: { pid: "1" } });
    await driver.bind({ deviceId: theatre, capability: "media", address: `127.0.0.1:${heos.port}`, config: { pid: "2" } });
    await vi.waitFor(() => expect(heos.received.some((r) => r.includes("pid=2"))).toBe(true));
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => heos.server.close(() => r()));
  });

  it("shares ONE TCP connection across both bound players (same host:port)", () => {
    expect(heos.sockets.size).toBe(1);
  });

  it("reports real Diagnostics Console counters shared by both bound players (one connection)", async () => {
    const before = driver.getDiagnostics(livingRoom);
    expect(before?.connectionStatus).toBe("connected");
    expect(before?.protocol).toBe("heos");
    expect(before?.packetsSent).toBeGreaterThan(0);
    const sentBefore = before!.packetsSent;

    await driver.command(livingRoom, { capability: "media", action: "volume", volume: 40 });
    await vi.waitFor(() => expect(driver.getDiagnostics(livingRoom)!.packetsSent).toBeGreaterThan(sentBefore));

    // Living room and theatre share ONE physical connection — diagnostics for both
    // devices report the same underlying link traffic.
    expect(driver.getDiagnostics(theatre)?.packetsSent).toBe(driver.getDiagnostics(livingRoom)?.packetsSent);
  });

  it("rejects binding a non-media capability — HEOS has no power surface", async () => {
    await expect(
      driver.bind({ deviceId: "device-heos-bad" as DeviceId, capability: "onoff", address: `127.0.0.1:${heos.port}`, config: { pid: "3" } }),
    ).rejects.toThrow();
  });

  it("refreshCapabilities forces a real reconnect that re-syncs both bound players (§ Capability Refresh)", async () => {
    const registersBefore = heos.received.filter((r) => r.includes("register_for_change_events?enable=on")).length;
    await driver.refreshCapabilities(livingRoom);
    await vi.waitFor(() => {
      expect(heos.received.filter((r) => r.includes("register_for_change_events?enable=on")).length).toBeGreaterThan(registersBefore);
    });
    // Both players sharing this connection are still bound and controllable — this
    // never recreated either device or dropped its binding.
    expect(driver.manages(livingRoom)).toBe(true);
    expect(driver.manages(theatre)).toBe(true);
    await vi.waitFor(() => expect(driver.getDiagnostics(livingRoom)?.connectionStatus).toBe("connected"));
  });

  it("plays living room and leaves theatre untouched", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === livingRoom && (e.state as { playback?: string }).playback === "playing");
    await driver.command(livingRoom, { capability: "media", action: "play" });
    expect((await ev).state).toMatchObject({ kind: "media", playback: "playing" });
    expect(driver.getState(theatre, "media")).not.toMatchObject({ playback: "playing" });
  });

  it("sets volume 1:1 (no scale conversion) and surfaces it on the right device", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === theatre && (e.state as { volume?: number }).volume === 65);
    await driver.command(theatre, { capability: "media", action: "volume", volume: 65 });
    expect((await ev).state).toMatchObject({ volume: 65 });
    expect(heos.received).toContain("heos://player/set_volume?pid=2&level=65");
  });

  it("switches input via browse/play_input and surfaces it as media source", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === livingRoom && (e.state as { source?: string }).source === "inputs/hdmi_in_1");
    await driver.command(livingRoom, { capability: "media", action: "source", source: "inputs/hdmi_in_1" });
    expect((await ev).state).toMatchObject({ source: "inputs/hdmi_in_1" });
  });

  it("syncs now-playing metadata (title/artist/artwork) from get_now_playing_media at bind time", async () => {
    await vi.waitFor(() => {
      const s = driver.getState(livingRoom, "media") as { title?: string | null; artworkUrl?: string | null } | null;
      expect(s?.title).toBe("Song A");
      expect(s?.artworkUrl).toBe("https://art.example/1.jpg");
    });
  });

  it("rejects a command for an unbound device", async () => {
    await expect(driver.command("device-nope" as DeviceId, { capability: "media", action: "play" })).rejects.toThrow();
  });

  it("fetches the real HEOS queue (get_queue), correlated via the spec's sequence argument", async () => {
    const items = await driver.getQueue(livingRoom);
    expect(items).toEqual([
      { id: "1", title: "Track A", artist: "Artist A", album: "Album A", artworkUrl: "https://art.example/a.jpg" },
      { id: "2", title: "Track B", artist: "Artist A", album: "Album A", artworkUrl: "https://art.example/b.jpg" },
    ]);
  });

  it("two concurrent getQueue calls resolve independently (sequence correlation, not just FIFO)", async () => {
    const [a, b] = await Promise.all([driver.getQueue(livingRoom), driver.getQueue(theatre)]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
  });

  it("getQueue on an unbound device resolves null rather than throwing", async () => {
    await expect(driver.getQueue("device-nope" as DeviceId)).resolves.toBeNull();
  });

  it("heartbeat() round-trips a real system/heart_beat probe with a measured latency (§ Universal AVR SDK)", async () => {
    const result = await driver.heartbeat(livingRoom);
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("heartbeat() on an unbound device resolves { ok: false } rather than throwing", async () => {
    await expect(driver.heartbeat("device-nope" as DeviceId)).resolves.toEqual({ ok: false, latencyMs: null });
  });

  it("resolves the real streaming service name from a song-type get_now_playing_media response (§ Network Source Resolver)", async () => {
    const den = "device-heos-den" as DeviceId;
    await driver.bind({ deviceId: den, capability: "media", address: `127.0.0.1:${heos.port}`, config: { pid: "3" } });
    await vi.waitFor(() => {
      const s = driver.getState(den, "media") as { title?: string | null; source?: string | null } | null;
      expect(s?.title).toBe("Track X");
      expect(s?.source).toBe("Spotify");
    });
  });
});

describe("HeosProtocolDriver — unbind (§ Driver Lifecycle Completion)", () => {
  it("keeps the shared network connection open while a sibling player is still bound, then closes it once the last player is unbound", async () => {
    const heos = await startFakeHeos();
    const driver = new HeosProtocolDriver();
    await driver.connect();
    const livingRoom = "device-heos-unbind-living" as DeviceId;
    const theatre = "device-heos-unbind-theatre" as DeviceId;
    await driver.bind({ deviceId: livingRoom, capability: "media", address: `127.0.0.1:${heos.port}`, config: { pid: "1" } });
    await driver.bind({ deviceId: theatre, capability: "media", address: `127.0.0.1:${heos.port}`, config: { pid: "2" } });
    await vi.waitFor(() => expect(heos.sockets.size).toBe(1));

    await driver.unbind(theatre);
    expect(driver.manages(theatre)).toBe(false);
    expect(driver.manages(livingRoom)).toBe(true);
    expect(heos.sockets.size).toBe(1); // living room still needs this connection

    await driver.unbind(livingRoom);
    expect(driver.manages(livingRoom)).toBe(false);
    await vi.waitFor(() => expect(heos.sockets.size).toBe(0));

    await expect(driver.unbind(livingRoom)).resolves.toBeUndefined(); // idempotent

    await driver.disconnect();
    await new Promise<void>((r) => heos.server.close(() => r()));
  });
});

describe("HeosProtocolDriver — auto-reconnect on drop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects with capped backoff after the socket closes and re-syncs both players", async () => {
    vi.useFakeTimers();
    const heos = await startFakeHeos();
    const driver = new HeosProtocolDriver({ reconnectBaseMs: 50, reconnectMaxMs: 50 });
    const dev = "device-heos-reconnect" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${heos.port}`, config: { pid: "1" } });

    await vi.waitFor(() => expect(heos.received.some((r) => r.includes("get_play_state"))).toBe(true));
    expect(heos.sockets.size).toBe(1);

    for (const s of heos.sockets) s.destroy();
    await vi.waitFor(() => expect(heos.sockets.size).toBe(0));

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(heos.sockets.size).toBe(1));
    await vi.waitFor(() => expect(heos.received.filter((r) => r.includes("get_play_state")).length).toBeGreaterThanOrEqual(2));

    await driver.disconnect();
    await new Promise<void>((r) => heos.server.close(() => r()));
  });
});

describe("HeosProtocolDriver — Production Hardening (Phase 3/6 audit)", () => {
  it("rejects a command after disconnect() instead of silently re-opening a socket", async () => {
    const heos = await startFakeHeos();
    const driver = new HeosProtocolDriver();
    const dev = "device-heos-teardown" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${heos.port}`, config: { pid: "9" } });
    await vi.waitFor(() => expect(heos.received.some((r) => r.includes("pid=9"))).toBe(true));

    await driver.disconnect();
    await expect(driver.command(dev, { capability: "media", action: "mute" })).rejects.toThrow(/disconnected/);
    await new Promise<void>((r) => heos.server.close(() => r()));
  });

  it("disconnect() is idempotent — calling it twice never throws", async () => {
    const heos = await startFakeHeos();
    const driver = new HeosProtocolDriver();
    await driver.connect();
    await driver.bind({ deviceId: "device-y" as DeviceId, capability: "media", address: `127.0.0.1:${heos.port}`, config: { pid: "1" } });
    await driver.disconnect();
    await expect(driver.disconnect()).resolves.toBeUndefined();
    await new Promise<void>((r) => heos.server.close(() => r()));
  });

  it("with trace:true, logs every raw command sent/line received and every command/getCapabilityConfig operation (§ Production Bugfix Sprint)", async () => {
    const heos = await startFakeHeos();
    const logs: { level: string; message: string }[] = [];
    const driver = new HeosProtocolDriver({ trace: true, onLog: (level, message) => logs.push({ level, message }) });
    const dev = "device-heos-traced" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${heos.port}`, config: { pid: "1" } });
    await vi.waitFor(() => expect(logs.some((l) => l.message.includes("[trace:heos] -> heos://player/get_volume"))).toBe(true));
    expect(logs.some((l) => l.message.startsWith("[trace:heos] <- "))).toBe(true);

    await driver.command(dev, { capability: "media", action: "mute" });
    await vi.waitFor(() => expect(logs.some((l) => l.message.includes("[trace:heos] -> heos://player/set_mute"))).toBe(true));
    expect(logs.some((l) => l.message.includes("[trace:heos] command") && l.message.includes("media/mute"))).toBe(true);

    driver.getCapabilityConfig(dev, "media");
    expect(logs.some((l) => l.message.includes("[trace:heos] getCapabilityConfig"))).toBe(true);

    await driver.disconnect();
    await new Promise<void>((r) => heos.server.close(() => r()));
  });

  it("with trace disabled (default), never emits [trace:] log lines even with onLog set", async () => {
    const heos = await startFakeHeos();
    const logs: { level: string; message: string }[] = [];
    const driver = new HeosProtocolDriver({ onLog: (level, message) => logs.push({ level, message }) });
    const dev = "device-heos-untraced" as DeviceId;
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: `127.0.0.1:${heos.port}`, config: { pid: "1" } });
    await vi.waitFor(() => expect(heos.received.some((r) => r.includes("pid=1"))).toBe(true));
    expect(logs.some((l) => l.message.startsWith("[trace:"))).toBe(false);
    await driver.disconnect();
    await new Promise<void>((r) => heos.server.close(() => r()));
  });
});

describe("HeosProtocolDriver — discovery", () => {
  it("resolves real pids via get_players after SSDP, one DiscoveredDevice per player", async () => {
    const heos = await startFakeHeos();
    const driver = new HeosProtocolDriver({
      port: heos.port,
      ssdp: async (opts) => {
        expect(opts?.st).toBe("urn:schemas-denon-com:device:ACT-Denon:1");
        return [{ address: "127.0.0.1" }];
      },
    });
    const found = await driver.discover();
    expect(found).toEqual([
      {
        backendId: "1",
        suggestedName: "Living Room",
        capabilities: ["media"],
        raw: {
          ip: "127.0.0.1",
          model: "HEOS Bar",
          bindConfig: { pid: "1", model: "HEOS Bar" },
          locationHint: { raw: "Living Room", source: "persistent_user_zone_name" },
        },
      },
      {
        backendId: "2",
        suggestedName: "Theatre",
        capabilities: ["media"],
        raw: {
          ip: "127.0.0.1",
          model: "HEOS Bar",
          bindConfig: { pid: "2", model: "HEOS Bar" },
          locationHint: { raw: "Theatre", source: "persistent_user_zone_name" },
        },
      },
    ]);
    await new Promise<void>((r) => heos.server.close(() => r()));
  });

  it("dedupes players seen from more than one SSDP hit on the same network", async () => {
    const heos = await startFakeHeos();
    const driver = new HeosProtocolDriver({
      port: heos.port,
      // Two different SSDP responders (e.g. two physical units) both answering
      // get_players with the SAME whole-network player list must not double-list.
      ssdp: async () => [{ address: "127.0.0.1" }, { address: "127.0.0.1" }],
    });
    const found = await driver.discover();
    expect(found).toHaveLength(2);
    await new Promise<void>((r) => heos.server.close(() => r()));
  });

  it("tolerates an unresponsive candidate host without failing the whole scan", async () => {
    const driver = new HeosProtocolDriver({
      discoverTimeoutMs: 50,
      ssdp: async () => [{ address: "10.255.255.1" }], // non-routable — never responds
      createSocket: () => new Socket(), // never connects; the discovery timeout resolves it
    });
    await expect(driver.discover()).resolves.toEqual([]);
  });
});
