import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import {
  AppleTvProtocolDriver,
  mediaStateFromNowPlaying,
  type AppleTvClient,
  type AppleTvNowPlaying,
} from "./apple-tv-driver.js";
import type { MdnsService } from "./mdns.js";

/** A fake Apple TV: tracks transport + volume and reports a Netflix "now playing". */
function fakeAppleTv(): { client: AppleTvClient; np: AppleTvNowPlaying; calls: string[] } {
  const np: AppleTvNowPlaying = {
    state: "paused",
    app: "Netflix",
    title: "The Crown",
    artist: "S5 · E3",
    artworkUrl: "https://art.local/crown.jpg",
    volume: 40,
    muted: false,
  };
  const calls: string[] = [];
  const client: AppleTvClient = {
    play: async () => void (calls.push("play"), (np.state = "playing")),
    pause: async () => void (calls.push("pause"), (np.state = "paused")),
    stop: async () => void (calls.push("stop"), (np.state = "stopped")),
    next: async () => void calls.push("next"),
    previous: async () => void calls.push("previous"),
    setVolume: async (v) => void (calls.push(`vol:${v}`), (np.volume = v)),
    setMuted: async (m) => void (calls.push(`mute:${m}`), (np.muted = m)),
    nowPlaying: async () => ({ ...np }),
  };
  return { client, np, calls };
}

describe("Apple TV driver (discovery real, MRP client seam)", () => {
  it("maps now-playing onto media state with the foreground app as the source", () => {
    const state = mediaStateFromNowPlaying({
      state: "playing",
      app: "Disney+",
      title: "Andor",
      artist: "S1 · E7",
      artworkUrl: "https://art.local/andor.jpg",
      volume: 55.6,
      muted: false,
    });
    expect(state).toEqual({
      kind: "media",
      playback: "playing",
      volume: 56, // rounded + clamped
      muted: false,
      title: "Andor",
      artist: "S1 · E7",
      source: "Disney+", // app → source
      artworkUrl: "https://art.local/andor.jpg",
    });
  });

  it("falls back to an 'Apple TV' source when the app is unknown", () => {
    const s = mediaStateFromNowPlaying({
      state: "idle",
      app: null,
      title: null,
      artist: null,
      artworkUrl: null,
      volume: 0,
      muted: false,
    });
    expect(s).toMatchObject({ source: "Apple TV", playback: "idle" });
  });

  it("discovers Apple TVs over mDNS and surfaces a media device", async () => {
    const fake: MdnsService = {
      name: "Living\\032Room._mediaremotetv._tcp.local",
      host: "appletv.local",
      port: 49153,
      addresses: ["10.0.0.42"],
      txt: { Name: "Living Room" },
    };
    const driver = new AppleTvProtocolDriver({ pollMs: 1_000_000, mdns: async () => [fake] });
    await driver.connect();
    const found = await driver.discover();
    expect(found[0]).toMatchObject({ backendId: "10.0.0.42", capabilities: ["media"] });
    expect(found[0]?.suggestedName).toBe("Living Room");
    await driver.disconnect();
  });

  it("drives full transport + volume and reflects the playing app/content in state", async () => {
    const { client, calls } = fakeAppleTv();
    const driver = new AppleTvProtocolDriver({ pollMs: 1_000_000, connect: async () => client });
    await driver.connect();
    const dev = "device-appletv" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", address: "10.0.0.42" });

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));

    await driver.command(dev, { capability: "media", action: "play" });
    await driver.command(dev, { capability: "media", action: "volume", volume: 70 });
    await driver.command(dev, { capability: "media", action: "mute" });
    await driver.command(dev, { capability: "media", action: "next" });

    expect(calls).toEqual(["play", "vol:70", "mute:true", "next"]);

    const s = driver.getState(dev, "media") as {
      playback: string;
      volume: number;
      muted: boolean;
      source: string;
      title: string;
    };
    expect(s.playback).toBe("playing");
    expect(s.volume).toBe(70);
    expect(s.muted).toBe(true);
    expect(s.source).toBe("Netflix"); // foreground app
    expect(s.title).toBe("The Crown"); // its content
    expect(events.at(-1)?.state).toMatchObject({ source: "Netflix", title: "The Crown" });

    await driver.disconnect();
  });

  it("rejects non-media bindings and unbound commands", async () => {
    const driver = new AppleTvProtocolDriver({ connect: async () => fakeAppleTv().client });
    await driver.connect();
    await expect(
      driver.bind({ deviceId: "x" as DeviceId, capability: "onoff", address: "1.2.3.4" }),
    ).rejects.toThrow(/not supported/);
    await expect(
      driver.command("nope" as DeviceId, { capability: "media", action: "play" }),
    ).rejects.toThrow(/not bound/);
    await driver.disconnect();
  });
});
