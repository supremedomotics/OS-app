import { createServer, type Server } from "node:http";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { YamahaProtocolDriver, type YamahaEventSocket } from "./yamaha-driver.js";
import { commandToYamaha, parseYamahaEvent, parseYamahaFeatures } from "./yamaha-codec.js";

interface ZoneState {
  power: "on" | "standby";
  volume: number;
  mute: boolean;
  input: string;
  soundProgram?: string;
  bass?: number;
  treble?: number;
}

/**
 * A tiny in-process Yamaha Extended Control (YXC) unit: two zones (main has tone
 * control + sound programs, zone2 is volume/power/mute only, matching a real
 * MusicCast AVR's asymmetric zone feature set), one Net/USB now-playing engine shared
 * across zones (matches the protocol's real global-not-zone-scoped netusb API).
 */
function startFakeYamaha(): Promise<{ server: Server; base: string; host: string; calls: string[]; zones: Record<string, ZoneState>; netusb: Record<string, unknown> }> {
  const calls: string[] = [];
  const zones: Record<string, ZoneState> = {
    main: { power: "on", volume: 30, mute: false, input: "server", soundProgram: "straight", bass: 0, treble: 0 },
    zone2: { power: "standby", volume: 20, mute: false, input: "hdmi1" },
  };
  const netusb: Record<string, unknown> = {
    playback: "play", repeat: "off", shuffle: "off", play_time: 10, total_time: 200,
    artist: "Artist A", album: "Album B", track: "Track C", albumart_url: "/art.jpg", attribute: 511,
  };

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // ["YamahaExtendedControl","v1",group,method]
      const group = parts[2];
      const method = parts[3];
      calls.push(`${group}/${method}`);
      const q = Object.fromEntries(url.searchParams.entries());
      let body: Record<string, unknown> = { response_code: 0 };

      if (group === "system" && method === "getFeatures") {
        body = {
          response_code: 0,
          system: {
            func_list: [],
            zone_num: 2,
            input_list: [
              { id: "server", play_info_type: "netusb" },
              { id: "hdmi1", play_info_type: "none" },
            ],
          },
          zone: [
            {
              id: "main",
              func_list: ["power", "volume", "mute", "tone_control", "sound_program"],
              input_list: ["server", "hdmi1"],
              sound_program_list: ["straight", "stereo"],
              range_step: [{ id: "volume", min: 0, max: 200, step: 1 }, { id: "tone_control", min: -12, max: 12, step: 1 }],
            },
            {
              id: "zone2",
              func_list: ["power", "volume", "mute"],
              input_list: ["server", "hdmi1"],
              sound_program_list: [],
              range_step: [{ id: "volume", min: 0, max: 100, step: 1 }],
            },
          ],
        };
      } else if (group === "main" || group === "zone2") {
        const z = zones[group]!;
        if (method === "getStatus") {
          body = {
            response_code: 0, power: z.power, volume: z.volume, mute: z.mute, input: z.input,
            ...(z.soundProgram !== undefined ? { sound_program: z.soundProgram } : {}),
            ...(z.bass !== undefined ? { tone_control: { bass: z.bass, treble: z.treble } } : {}),
          };
        } else if (method === "setPower") {
          z.power = q.power === "toggle" ? (z.power === "on" ? "standby" : "on") : (q.power as "on" | "standby");
        } else if (method === "setVolume") {
          z.volume = Number(q.volume);
        } else if (method === "setMute") {
          z.mute = q.enable === "true";
        } else if (method === "setInput") {
          z.input = q.input ?? z.input;
        } else if (method === "setSoundProgram") {
          z.soundProgram = q.program;
        } else if (method === "setToneControl") {
          if (q.bass !== undefined) z.bass = Number(q.bass);
          if (q.treble !== undefined) z.treble = Number(q.treble);
        }
      } else if (group === "netusb") {
        if (method === "getPlayInfo") {
          body = { response_code: 0, input: zones.main!.input, ...netusb };
        } else if (method === "setPlayback") {
          netusb.playback = q.playback === "next" || q.playback === "previous" ? "play" : q.playback;
        } else if (method === "setPlayPosition") {
          netusb.play_time = Number(q.position);
        } else if (method === "toggleShuffle") {
          netusb.shuffle = netusb.shuffle === "off" ? "on" : "off";
        } else if (method === "toggleRepeat") {
          netusb.repeat = netusb.repeat === "off" ? "all" : netusb.repeat === "all" ? "one" : "off";
        }
      }

      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, calls, zones, netusb });
    });
  });
}

/** A fake UDP event socket the driver's tests can push messages through directly,
 * matching the injectable-transport convention used throughout this fleet (ssdp.ts,
 * knx-discovery.ts) instead of exercising real multicast/UDP networking in CI. */
function fakeEventSocket(): { socket: YamahaEventSocket; push: (sourceIp: string, payload: unknown) => void } {
  let onMessage: ((msg: Buffer, rinfo: { address: string }) => void) | null = null;
  const socket: YamahaEventSocket = {
    on: (event, cb) => {
      if (event === "message") onMessage = cb;
    },
    bind: (cb) => cb(),
    address: () => ({ port: 41100 }),
    close: () => {},
  };
  return { socket, push: (sourceIp, payload) => onMessage?.(Buffer.from(JSON.stringify(payload)), { address: sourceIp }) };
}

const nextEvent = (driver: YamahaProtocolDriver, pred: (e: BackendStateEvent) => boolean) =>
  new Promise<BackendStateEvent>((resolve) => {
    const off = driver.onState((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
  });

describe("Yamaha codec", () => {
  it("parses getFeatures into per-zone dynamic capability data", () => {
    const features = parseYamahaFeatures({
      system: { input_list: [{ id: "server", play_info_type: "netusb" }] },
      zone: [{ id: "main", func_list: ["tone_control"], input_list: ["server"], sound_program_list: ["straight"], range_step: [{ id: "volume", min: 0, max: 194, step: 1 }] }],
    });
    expect(features.systemInputs).toEqual([{ id: "server", playInfoType: "netusb" }]);
    expect(features.zones[0]?.volumeRange).toEqual({ min: 0, max: 194, step: 1 });
  });

  it("encodes volume using the zone's real native scale, not a fixed one", () => {
    expect(commandToYamaha({ capability: "media", action: "volume", volume: 50 }, "main", { volumeRange: { min: 0, max: 200, step: 1 } })).toEqual([
      { group: "main", method: "setVolume", params: { volume: 100 } },
    ]);
  });

  it("maps seek to the real netusb/setPlayPosition command (unlike Denon/HEOS)", () => {
    expect(commandToYamaha({ capability: "media", action: "seek", positionSec: 42 }, "main", { volumeRange: { min: 0, max: 100, step: 1 } })).toEqual([
      { group: "netusb", method: "setPlayPosition", params: { position: 42 } },
    ]);
  });

  it("combines soundProgram + tone into TWO independent HTTP requests from one 'advanced' command", () => {
    const requests = commandToYamaha(
      { capability: "media", action: "advanced", advanced: { soundProgram: "stereo", bass: 3, treble: -2 } },
      "main",
      { volumeRange: { min: 0, max: 100, step: 1 } },
    );
    expect(requests).toEqual([
      { group: "main", method: "setSoundProgram", params: { program: "stereo" } },
      { group: "main", method: "setToneControl", params: { mode: "manual", bass: 3, treble: -2 } },
    ]);
  });

  it("parses the hybrid direct-value + update-flag event payload", () => {
    const event = parseYamahaEvent(JSON.stringify({ main: { power: "on", volume: 40, status_updated: false }, netusb: { play_info_updated: true } }));
    expect(event?.zones.main).toMatchObject({ power: true, volume: 40, statusUpdated: false });
    expect(event?.netusbPlayInfoUpdated).toBe(true);
  });
});

describe("YamahaProtocolDriver (in-process YXC unit over HTTP, 2 zones)", () => {
  let yam: Awaited<ReturnType<typeof startFakeYamaha>>;
  let events: ReturnType<typeof fakeEventSocket>;
  let driver: YamahaProtocolDriver;
  const main = "device-yamaha-main" as DeviceId;
  const mainPower = "device-yamaha-main-power" as DeviceId;
  const zone2 = "device-yamaha-zone2" as DeviceId;

  beforeAll(async () => {
    yam = await startFakeYamaha();
    events = fakeEventSocket();
    driver = new YamahaProtocolDriver({ createEventSocket: () => events.socket, eventRefreshMs: 1_000_000 });
    await driver.connect();
    await driver.bind({ deviceId: mainPower, capability: "onoff", address: yam.host, config: { zone: "main" } });
    await driver.bind({ deviceId: main, capability: "media", address: yam.host, config: { zone: "main" } });
    await driver.bind({ deviceId: zone2, capability: "media", address: yam.host, config: { zone: "zone2" } });
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((r) => yam.server.close(() => r()));
  });

  it("syncs main zone's now-playing (netusb) metadata at bind time since its input is netusb-typed", () => {
    const state = driver.getState(main, "media") as { title?: string; artist?: string; artworkUrl?: string; playback?: string } | null;
    expect(state).toMatchObject({ title: "Track C", artist: "Artist A", playback: "playing" });
    expect(state?.artworkUrl).toBe(`${yam.base}/art.jpg`);
  });

  it("does NOT pull now-playing for zone2 since its input (hdmi1) is not netusb-typed", () => {
    const state = driver.getState(zone2, "media") as { title?: string | null; playback?: string } | null;
    expect(state?.title).toBeNull();
  });

  it("reports real Diagnostics Console counters keyed by host, shared across both zones", async () => {
    const before = driver.getDiagnostics(main);
    expect(before?.connectionStatus).toBe("connected"); // bind() already called getFeatures successfully
    expect(before?.protocol).toBe("yamaha");
    expect(before?.packetsSent).toBeGreaterThan(0);
    const sentBefore = before!.packetsSent;

    await driver.command(main, { capability: "media", action: "volume", volume: 50 });
    const after = driver.getDiagnostics(main)!;
    expect(after.packetsSent).toBeGreaterThan(sentBefore);
    expect(after.lastCommand).toMatch(/^(main|netusb)\//); // setVolume, then a syncZone re-fetch
    expect(after.lastCommandAt).not.toBeNull();
    // Same physical host — zone2's diagnostics reflect the same request/response traffic.
    expect(driver.getDiagnostics(zone2)?.packetsSent).toBe(after.packetsSent);
  });

  it("commands main zone power independently of zone2", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === mainPower && (e.state as { on?: boolean }).on === false);
    await driver.command(mainPower, { capability: "onoff", action: "off" });
    expect((await ev).state).toEqual({ kind: "onoff", on: false });
    expect(yam.zones.zone2!.power).toBe("standby"); // untouched by the main-zone command
  });

  it("sets volume using the zone's real range from getFeatures (0..200 for main)", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === main && (e.state as { volume?: number }).volume === 75);
    await driver.command(main, { capability: "media", action: "volume", volume: 75 });
    expect((await ev).state).toMatchObject({ volume: 75 });
    expect(yam.calls).toContain("main/setVolume");
  });

  it("sets DSP sound program + tone via the 'advanced' action", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === main && (e.state as { advanced?: Record<string, unknown> }).advanced?.soundProgram === "stereo");
    await driver.command(main, { capability: "media", action: "advanced", advanced: { soundProgram: "stereo", bass: 3, treble: -2 } });
    const state = (await ev).state as { advanced: Record<string, unknown> };
    expect(state.advanced).toMatchObject({ soundProgram: "stereo", bass: 3, treble: -2 });
  });

  it("seeks via the real setPlayPosition command", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === main && (e.state as { positionSec?: number }).positionSec === 99);
    await driver.command(main, { capability: "media", action: "seek", positionSec: 99 });
    expect((await ev).state).toMatchObject({ positionSec: 99 });
  });

  it("toggles shuffle only when the cached state disagrees with the request", async () => {
    const before = yam.calls.filter((c) => c === "netusb/toggleShuffle").length;
    // Currently off (from setup); asking for shuffle=false should be a no-op (no HTTP call).
    await driver.command(main, { capability: "media", action: "shuffle", shuffle: false });
    expect(yam.calls.filter((c) => c === "netusb/toggleShuffle").length).toBe(before);

    const ev = nextEvent(driver, (e) => e.deviceId === main && (e.state as { shuffle?: boolean }).shuffle === true);
    await driver.command(main, { capability: "media", action: "shuffle", shuffle: true });
    expect((await ev).state).toMatchObject({ shuffle: true });
  });

  it("applies a direct-value UDP event without a network round trip, filtered to the right zone/device", async () => {
    const ev = nextEvent(driver, (e) => e.deviceId === mainPower && (e.state as { on?: boolean }).on === true);
    events.push(yam.host, { main: { power: "on", volume: 60, mute: false, status_updated: false } });
    expect((await ev).state).toEqual({ kind: "onoff", on: true });
    // zone2 must be untouched by a main-zone-only event.
    expect(driver.getState(zone2, "media")).not.toMatchObject({ volume: 60 });
  });

  it("falls back to a full re-fetch when the event's status_updated flag is set", async () => {
    yam.zones.zone2!.volume = 88;
    const ev = nextEvent(driver, (e) => e.deviceId === zone2 && (e.state as { volume?: number }).volume === 88);
    events.push(yam.host, { zone2: { status_updated: true } });
    expect((await ev).state).toMatchObject({ volume: 88 });
  });

  it("ignores events from an IP this driver doesn't manage", () => {
    let called = false;
    const off = driver.onState(() => { called = true; });
    events.push("10.0.0.99", { main: { power: "on" } });
    off();
    expect(called).toBe(false);
  });

  it("rejects a command for an unbound device", async () => {
    await expect(driver.command("device-nope" as DeviceId, { capability: "media", action: "play" })).rejects.toThrow();
  });
});

describe("YamahaProtocolDriver — discovery", () => {
  it("filters MediaRenderer SSDP hits to Yamaha units and defaults to zone 'main'", async () => {
    const upnpXml = "<root><device><manufacturer>Yamaha Corporation</manufacturer><friendlyName>Master Bedroom</friendlyName></device></root>";
    const driver = new YamahaProtocolDriver({
      ssdp: async (opts) => {
        expect(opts?.st).toBe("urn:schemas-upnp-org:device:MediaRenderer:1");
        return [
          { address: "192.168.1.60", location: "http://192.168.1.60/desc.xml" },
          { address: "192.168.1.61", location: "http://192.168.1.61/desc.xml" }, // a non-Yamaha renderer
        ];
      },
      fetchImpl: (async (url: string) => ({
        ok: true,
        text: async () => (url.includes("192.168.1.60") ? upnpXml : "<root><device><manufacturer>Sonos, Inc.</manufacturer></device></root>"),
      })) as unknown as typeof fetch,
    });
    const found = await driver.discover();
    expect(found).toEqual([
      {
        backendId: "192.168.1.60",
        suggestedName: "Master Bedroom",
        capabilities: ["onoff", "media"],
        raw: {
          ip: "192.168.1.60",
          location: "http://192.168.1.60/desc.xml",
          manufacturer: "Yamaha Corporation",
          friendlyName: "Master Bedroom",
          zones: [{ id: "main", label: "Main Zone" }],
          bindConfig: { zone: "main" },
          locationHint: { raw: "Master Bedroom", source: "persistent_user_zone_name" },
        },
      },
    ]);
  });

  it("§Automatic Zone Generation: a real getFeatures response with extra zones surfaces them all at discovery time", async () => {
    const upnpXml = "<root><device><manufacturer>Yamaha Corporation</manufacturer><friendlyName>Media Room</friendlyName><modelName>RX-A8A</modelName></device></root>";
    const featuresJson = {
      response_code: 0,
      system: { func_list: [], input_list: [] },
      zone: [
        { id: "main", func_list: ["power"], input_list: ["hdmi1"], sound_program_list: [], range_step: [] },
        { id: "zone2", func_list: ["power"], input_list: ["hdmi1"], sound_program_list: [], range_step: [] },
        { id: "zone3", func_list: ["power"], input_list: ["hdmi1"], sound_program_list: [], range_step: [] },
      ],
    };
    const driver = new YamahaProtocolDriver({
      ssdp: async () => [{ address: "192.168.1.70", location: "http://192.168.1.70/desc.xml" }],
      fetchImpl: (async (url: string) => {
        if (url.includes("desc.xml")) return { ok: true, text: async () => upnpXml };
        return { ok: true, json: async () => featuresJson };
      }) as unknown as typeof fetch,
    });
    const found = await driver.discover();
    expect(found).toHaveLength(1);
    expect(found[0]?.raw.zones).toEqual([
      { id: "main", label: "Main Zone" },
      { id: "zone2", label: "Zone 2" },
      { id: "zone3", label: "Zone 3" },
    ]);
    expect(found[0]?.raw.bindConfig).toEqual({ zone: "main", model: "RX-A8A" });
  });
});
