import type { DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { SonosProtocolDriver } from "./sonos-driver.js";
import { mapSonosPlayback, wrapSonosDevice, type SonosDevice } from "./sonos-transport.js";

/** A fake node-sonos device — records control calls, returns canned state. */
class FakeSonos implements SonosDevice {
  volume = 25;
  muted = false;
  state = "stopped";
  readonly calls: string[] = [];
  async play() { this.calls.push("play"); this.state = "playing"; return true; }
  async pause() { this.calls.push("pause"); this.state = "paused"; return true; }
  async stop() { this.calls.push("stop"); this.state = "stopped"; return true; }
  async next() { this.calls.push("next"); return true; }
  async previous() { this.calls.push("previous"); return true; }
  async setVolume(v: number) { this.calls.push(`vol:${v}`); this.volume = v; return true; }
  async setMuted(m: boolean) { this.calls.push(`mute:${m}`); this.muted = m; return true; }
  async getVolume() { return this.volume; }
  async getMuted() { return this.muted; }
  async getCurrentState() { return this.state; }
  async currentTrack() { return { title: "Flume", artist: "Bon Iver" }; }
}

describe("Sonos node-sonos transport", () => {
  it("maps node-sonos playback states", () => {
    expect(mapSonosPlayback("playing")).toBe("playing");
    expect(mapSonosPlayback("transitioning")).toBe("playing");
    expect(mapSonosPlayback("paused")).toBe("paused");
    expect(mapSonosPlayback("no_media_present")).toBe("idle");
  });

  it("wraps a node-sonos device as a SonosPlayer with correct control + state mapping", async () => {
    const dev = new FakeSonos();
    const player = wrapSonosDevice(dev);
    await player.play();
    await player.setVolume(70);
    await player.setMute(true);
    expect(dev.calls).toContain("play");
    expect(dev.calls).toContain("vol:70");
    expect(dev.calls).toContain("mute:true");

    const state = await player.getState();
    expect(state).toEqual({
      playback: "playing",
      volume: 70,
      muted: true,
      title: "Flume",
      artist: "Bon Iver",
    });
  });

  it("drives the real wrapper through SonosProtocolDriver end-to-end", async () => {
    const dev = new FakeSonos();
    // The driver uses the real wrapSonosDevice path; only the underlying device is faked.
    const driver = new SonosProtocolDriver({
      pollMs: 1_000_000,
      connect: async () => wrapSonosDevice(dev),
    });
    await driver.connect();
    const id = "device-sonos-kitchen" as DeviceId;
    await driver.bind({ deviceId: id, capability: "media", address: "192.168.1.56" });

    await driver.command(id, { capability: "media", action: "volume", volume: 40 });
    expect(dev.calls).toContain("vol:40");
    const s = driver.getState(id, "media") as { volume: number; artist: string | null };
    expect(s.volume).toBe(40);
    expect(s.artist).toBe("Bon Iver");
  });
});
