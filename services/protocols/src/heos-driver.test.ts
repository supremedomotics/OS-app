import { createServer, type Server, type Socket } from "node:net";
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

  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
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
          } else if (g === "player" && c === "get_now_playing_media" && p) {
            sock.write(`${heosOk("player/get_now_playing_media", `pid=${pid}`, { type: "station", song: "Song A", station: "Jazz FM", artist: "Artist A", image_url: "https://art.example/1.jpg" })}\r\n`);
          } else if (g === "player" && c === "play_next" && p) {
            sock.write(`${heosOk("player/play_next", `pid=${pid}`)}\r\n`);
          } else if (g === "browse" && c === "play_input" && p) {
            sock.write(`${heosOk("browse/play_input", `pid=${pid}&input=${params.input}`)}\r\n`);
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

  it("rejects binding a non-media capability — HEOS has no power surface", async () => {
    await expect(
      driver.bind({ deviceId: "device-heos-bad" as DeviceId, capability: "onoff", address: `127.0.0.1:${heos.port}`, config: { pid: "3" } }),
    ).rejects.toThrow();
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
