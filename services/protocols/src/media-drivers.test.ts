import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WiimProtocolDriver } from "./wiim-driver.js";
import { decodeHex, commandToLinkPlay } from "./wiim-codec.js";
import { DevialetProtocolDriver } from "./devialet-driver.js";
import { commandToDevialet } from "./devialet-codec.js";
import { SonosProtocolDriver, type SonosPlayer, type SonosPlayerState } from "./sonos-driver.js";
import { AjaxProtocolDriver, type AjaxClient, type AjaxEvent } from "./ajax-driver.js";

function startHttp(handler: (url: string, method: string) => { status?: number; body?: string }): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const out = handler(req.url ?? "", req.method ?? "GET");
      res.statusCode = out.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(out.body ?? "OK");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, hits });
    });
  });
}

describe("WiiM / LinkPlay driver (in-process HTTP)", () => {
  let srv: Awaited<ReturnType<typeof startHttp>>;
  let driver: WiimProtocolDriver;
  const dev = "device-wiim" as DeviceId;

  beforeAll(async () => {
    srv = await startHttp((url) => {
      if (url.includes("getPlayerStatus")) {
        // "Lorde" hex = 4c6f726465 ; status play; vol 42
        return { body: JSON.stringify({ status: "play", vol: 42, mute: 0, Title: "4c6f726465" }) };
      }
      return { body: "OK" };
    });
    driver = new WiimProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base });
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => srv.server.close(() => r()));
  });

  it("encodes commands and decodes hex metadata", () => {
    expect(commandToLinkPlay({ capability: "media", action: "volume", volume: 30 })).toBe("setPlayerCmd:vol:30");
    expect(decodeHex("4c6f726465")).toBe("Lorde");
  });

  it("sends a transport command and polls player status into media state", async () => {
    await driver.command(dev, { capability: "media", action: "pause" });
    expect(srv.hits.some((h) => h.includes("setPlayerCmd") && h.includes("pause"))).toBe(true);

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));
    await driver.poll();
    const s = events.at(-1)?.state as { kind: string; playback: string; volume: number; title: string | null };
    expect(s.kind).toBe("media");
    expect(s.playback).toBe("playing");
    expect(s.volume).toBe(42);
    expect(s.title).toBe("Lorde");
  });
});

describe("Devialet driver (in-process HTTP)", () => {
  let srv: Awaited<ReturnType<typeof startHttp>>;
  let driver: DevialetProtocolDriver;
  const dev = "device-phantom" as DeviceId;

  beforeAll(async () => {
    srv = await startHttp((url) => {
      if (url.endsWith("/soundControl/volume")) return { body: JSON.stringify({ volume: 55, mute: false }) };
      if (url.endsWith("/playback")) return { body: JSON.stringify({ state: "playing", title: "Time", artist: "Hans Zimmer" }) };
      return { body: "{}" };
    });
    driver = new DevialetProtocolDriver({ pollMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: dev, capability: "media", address: srv.base });
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => srv.server.close(() => r()));
  });

  it("maps a volume command and polls volume+playback into media state", async () => {
    expect(commandToDevialet({ capability: "media", action: "play" })?.path).toContain("/playback/play");
    await driver.command(dev, { capability: "media", action: "volume", volume: 60 });
    expect(srv.hits.some((h) => h.startsWith("POST") && h.includes("/soundControl/volume"))).toBe(true);

    await driver.poll();
    const s = driver.getState(dev, "media") as { volume: number; playback: string; artist: string | null };
    expect(s.volume).toBe(55);
    expect(s.playback).toBe("playing");
    expect(s.artist).toBe("Hans Zimmer");
  });
});

describe("Sonos driver (fake UPnP transport)", () => {
  it("maps media commands to the player and surfaces its state", async () => {
    let vol = 20;
    let playing = false;
    const player: SonosPlayer = {
      play: async () => void (playing = true),
      pause: async () => void (playing = false),
      stop: async () => void (playing = false),
      next: async () => {},
      previous: async () => {},
      setVolume: async (v) => void (vol = v),
      setMute: async () => {},
      getState: async (): Promise<SonosPlayerState> => ({
        playback: playing ? "playing" : "paused",
        volume: vol,
        muted: false,
        title: "Redbone",
        artist: "Childish Gambino",
      }),
    };
    const driver = new SonosProtocolDriver({ pollMs: 1_000_000, connect: async () => player });
    await driver.connect();
    const dev = "device-sonos" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", address: "Living Room" });

    await driver.command(dev, { capability: "media", action: "play" });
    await driver.command(dev, { capability: "media", action: "volume", volume: 65 });
    expect(vol).toBe(65);
    const s = driver.getState(dev, "media") as { playback: string; volume: number; artist: string | null };
    expect(s.playback).toBe("playing");
    expect(s.volume).toBe(65);
    expect(s.artist).toBe("Childish Gambino");
  });
});

describe("Ajax sensors driver (fake cloud client)", () => {
  it("maps device events to Supreme sensor states and rejects commands", async () => {
    let emit: ((e: AjaxEvent) => void) | null = null;
    const client: AjaxClient = {
      start: async () => {},
      stop: async () => {},
      onEvent: (h) => void (emit = h),
    };
    const driver = new AjaxProtocolDriver({ connect: async () => client });
    await driver.connect();
    const motion = "device-ajax-motion" as DeviceId;
    await driver.bind({ deviceId: motion, capability: "sensor", address: "ajax-12ab" });

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));
    emit!({ deviceId: "ajax-12ab", kind: "motion", active: true });
    expect(events.at(-1)?.state).toEqual({ kind: "sensor", value: 1, unit: "", measure: "motion" });

    await expect(
      driver.command(motion, { capability: "onoff", action: "on" }),
    ).rejects.toThrow(/read-only/);
  });
});
