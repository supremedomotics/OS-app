import { describe, expect, it } from "vitest";
import { TvDeviceSessionManager } from "./tv-device-session-manager.js";
import { FakeTvTransport } from "./transports/fake-tv-transport.js";
import type { TvDeviceConfig } from "./tv-types.js";

/**
 * (§25/§B — preliminary scale test, fake transports only) Not a soak test and not a
 * timing/CPU benchmark — those require real transports and land with Phase 8/9. This
 * proves the STRUCTURAL claims from the Phase 1 review gate hold at 100 simultaneously
 * bound devices, not just at the 2-20 device scale the other suites use: 100 distinct
 * sessions/transports/state-caches/command-queues/reconnect-schedulers, commands and
 * state staying device-scoped at that count, one device's disconnect not touching the
 * other 99, and unbindAll() leaving zero resources behind.
 */
const DEVICE_COUNT = 100;

function makeConfig(deviceId: string, transports: Map<string, FakeTvTransport>): TvDeviceConfig {
  return {
    deviceId,
    host: `10.0.0.${deviceId}`,
    platform: "android_tv",
    transportKind: "fake",
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    createTransport: (config) => {
      const t = new FakeTvTransport(config);
      transports.set(deviceId, t);
      return t;
    },
  };
}

function deviceIds(): string[] {
  return Array.from({ length: DEVICE_COUNT }, (_, i) => `TV${String(i).padStart(3, "0")}`);
}

describe("TV SDK — preliminary 100-device scale test (fake transports)", () => {
  it("binds 100 devices, each with its own session/transport/cache/queue/reconnect scheduler", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    const ids = deviceIds();

    await Promise.all(ids.map((id) => mgr.bind(makeConfig(id, transports))));

    expect(mgr.count()).toBe(DEVICE_COUNT);
    expect(transports.size).toBe(DEVICE_COUNT);
    // 100 distinct transport object identities — not one shared instance handed out
    // DEVICE_COUNT times, which would silently defeat every isolation claim below.
    expect(new Set(transports.values()).size).toBe(DEVICE_COUNT);
    for (const id of ids) {
      expect(mgr.manages(id)).toBe(true);
      expect(mgr.get(id)!.isConnected()).toBe(true);
    }

    await mgr.unbindAll();
  });

  it("commands and media/app state remain device-scoped across all 100 devices simultaneously", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    const ids = deviceIds();
    await Promise.all(ids.map((id) => mgr.bind(makeConfig(id, transports))));

    // Every device gets a DIFFERENT volume and a DIFFERENT "now playing" title,
    // concurrently — if any cache/queue were accidentally shared, values would collide.
    await Promise.all(ids.map((id, i) => mgr.setVolume(id, i)));
    for (const [i, id] of ids.entries()) {
      transports.get(id)!.emitMediaState({ title: `Title-${i}` });
    }

    for (const [i, id] of ids.entries()) {
      expect(transports.get(id)!.volumePercent).toBe(i);
      expect(mgr.getMediaState(id)?.title).toBe(`Title-${i}`);
      expect(mgr.getDiagnostics(id)!.lastCommand).toBe(`volume:${i}`);
    }

    await mgr.unbindAll();
  });

  it("disconnecting 1 of 100 devices leaves the other 99 fully connected and responsive", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    const ids = deviceIds();
    await Promise.all(ids.map((id) => mgr.bind(makeConfig(id, transports))));

    const victim = ids[42]!;
    transports.get(victim)!.failNextConnect("connection");
    transports.get(victim)!.simulateConnectionLost();

    expect(mgr.get(victim)!.isConnected()).toBe(false);
    const survivors = ids.filter((id) => id !== victim);
    for (const id of survivors) expect(mgr.get(id)!.isConnected()).toBe(true);

    // The survivors must still take commands immediately — the victim's reconnect loop
    // (even a currently-failing one) must impose zero latency on anyone else.
    await Promise.all(survivors.map((id) => mgr.sendKey(id, "HOME")));
    for (const id of survivors) expect(transports.get(id)!.received).toEqual(["HOME"]);

    await mgr.unbindAll();
  });

  it("unbindAll() at 100 devices disposes every transport and leaves zero sessions", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    const ids = deviceIds();
    await Promise.all(ids.map((id) => mgr.bind(makeConfig(id, transports))));

    await mgr.unbindAll();

    expect(mgr.count()).toBe(0);
    for (const id of ids) {
      expect(mgr.manages(id)).toBe(false);
      expect(transports.get(id)!.isDisposed()).toBe(true);
      expect(transports.get(id)!.isConnected()).toBe(false);
    }
  });
});
