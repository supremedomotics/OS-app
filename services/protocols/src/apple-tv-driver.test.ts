import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppleTvPairingRequiredError,
  AppleTvProtocolDriver,
  mediaStateFromNowPlaying,
  type AppleTvClient,
  type AppleTvNowPlaying,
} from "./apple-tv-driver.js";
import type { MdnsService } from "./mdns.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A fake Apple TV client with independently-controllable now-playing state and
 * connection failure injection, per instance — never shared/global. */
function fakeClient(overrides: Partial<AppleTvNowPlaying> = {}): { client: AppleTvClient; calls: string[] } {
  const calls: string[] = [];
  const np: AppleTvNowPlaying = {
    state: "idle",
    app: null,
    title: null,
    artist: null,
    artworkUrl: null,
    volume: 30,
    muted: false,
    ...overrides,
  };
  const client: AppleTvClient = {
    async play() {
      calls.push("play");
      np.state = "playing";
    },
    async pause() {
      calls.push("pause");
      np.state = "paused";
    },
    async stop() {
      calls.push("stop");
      np.state = "stopped";
    },
    async next() {
      calls.push("next");
    },
    async previous() {
      calls.push("previous");
    },
    async setVolume(percent) {
      calls.push(`volume:${percent}`);
      np.volume = percent;
    },
    async setMuted(muted) {
      calls.push(`muted:${muted}`);
      np.muted = muted;
    },
    async pressButton(button) {
      calls.push(`button:${button}`);
    },
    async nowPlaying() {
      return { ...np };
    },
    async close() {
      calls.push("close");
    },
  };
  return { client, calls };
}

describe("mediaStateFromNowPlaying", () => {
  it("maps a full now-playing snapshot onto the media capability", () => {
    expect(
      mediaStateFromNowPlaying({
        state: "playing",
        app: "Netflix",
        title: "The Movie",
        artist: null,
        artworkUrl: "https://hub.local/art.jpg",
        volume: 42,
        muted: false,
      }),
    ).toEqual({
      kind: "media",
      playback: "playing",
      volume: 42,
      muted: false,
      title: "The Movie",
      artist: null,
      source: "Netflix",
      artworkUrl: "https://hub.local/art.jpg",
      durationSec: null,
      positionSec: null,
    });
  });

  it("falls back to 'Apple TV' as source when no app is reported", () => {
    expect(mediaStateFromNowPlaying({ state: "idle", app: null, title: null, artist: null, artworkUrl: null, volume: 0, muted: false }).source).toBe(
      "Apple TV",
    );
  });

  it("maps volume=null/muted=null (device does not own audio output) to the honest non-nullable schema default, never a fabricated guess", () => {
    const state = mediaStateFromNowPlaying({ state: "idle", app: null, title: null, artist: null, artworkUrl: null, volume: null, muted: null });
    expect(state).toMatchObject({ volume: 0, muted: false });
  });
});

describe("AppleTvProtocolDriver — multi-instance isolation", () => {
  it("two independent Apple TVs never share state, commands, or clients", async () => {
    const living = fakeClient({ app: "Netflix", state: "playing" });
    const theater = fakeClient({ app: "Apple TV+", state: "paused" });
    const driver = new AppleTvProtocolDriver({
      connect: async ({ address }) => (address === "10.0.0.1" ? living.client : theater.client),
    });
    await driver.connect();

    const livingId = "device-living" as DeviceId;
    const theaterId = "device-theater" as DeviceId;
    await driver.bind({ deviceId: livingId, capability: "media", address: "10.0.0.1" });
    await driver.bind({ deviceId: theaterId, capability: "media", address: "10.0.0.2" });

    const livingState = driver.getState(livingId, "media");
    const theaterState = driver.getState(theaterId, "media");
    expect(livingState).toMatchObject({ source: "Netflix", playback: "playing" });
    expect(theaterState).toMatchObject({ source: "Apple TV+", playback: "paused" });
    expect(livingState).not.toEqual(theaterState);

    // A command to Theater must never reach Living Room's client.
    await driver.command(theaterId, { capability: "media", action: "stop" });
    expect(theater.calls).toContain("stop");
    expect(living.calls).not.toContain("stop");

    await driver.disconnect();
  });

  it("commands are routed to the exact device targeted — never leak to another bound Apple TV", async () => {
    const a = fakeClient();
    const b = fakeClient();
    const driver = new AppleTvProtocolDriver({ connect: async ({ address: addr }) => (addr === "a" ? a.client : b.client) });
    await driver.connect();
    const devA = "device-a" as DeviceId;
    const devB = "device-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", address: "a" });
    await driver.bind({ deviceId: devB, capability: "media", address: "b" });

    await driver.command(devA, { capability: "media", action: "play" });
    expect(a.calls).toEqual(["play"]);
    expect(b.calls).toEqual([]);

    await driver.command(devB, { capability: "media", action: "pause" });
    expect(b.calls).toEqual(["pause"]);
    expect(a.calls).toEqual(["play"]); // unchanged by B's command

    await driver.disconnect();
  });

  it("unbinding one device closes only its own client and leaves the other fully operational", async () => {
    const a = fakeClient();
    const b = fakeClient();
    const driver = new AppleTvProtocolDriver({ connect: async ({ address: addr }) => (addr === "a" ? a.client : b.client) });
    await driver.connect();
    const devA = "device-a" as DeviceId;
    const devB = "device-b" as DeviceId;
    await driver.bind({ deviceId: devA, capability: "media", address: "a" });
    await driver.bind({ deviceId: devB, capability: "media", address: "b" });

    await driver.unbind(devA);
    expect(a.calls).toContain("close");
    expect(b.calls).not.toContain("close");
    expect(driver.manages(devA)).toBe(false);
    expect(driver.manages(devB)).toBe(true);

    await driver.command(devB, { capability: "media", action: "play" });
    expect(b.calls).toContain("play");
    await driver.disconnect();
  });
});

describe("AppleTvProtocolDriver — connection lifecycle", () => {
  it("a successful bind reaches 'connected'", async () => {
    const { client } = fakeClient();
    const driver = new AppleTvProtocolDriver({ connect: async () => client });
    await driver.connect();
    const dev = "device-ok" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", address: "10.0.0.1" });
    expect(driver.getConnectionDiagnostics(dev)).toMatchObject({ state: "connected", reconnectAttempts: 0 });
    await driver.disconnect();
  });

  it("a failed connect enters 'error' then 'reconnecting' with exponential backoff, isolated per device", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { client } = fakeClient();
    const driver = new AppleTvProtocolDriver({
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 8_000,
      connect: async () => {
        attempts += 1;
        if (attempts < 4) throw new Error("connection refused");
        return client;
      },
    });
    await driver.connect();
    const dev = "device-flaky" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", address: "10.0.0.1" });
    expect(driver.getConnectionDiagnostics(dev)?.state).toBe("error");

    await vi.advanceTimersByTimeAsync(1_000); // 2nd attempt (~1s)
    expect(driver.getConnectionDiagnostics(dev)?.state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2_000); // 3rd attempt (~2s later)
    await vi.advanceTimersByTimeAsync(4_000); // 4th attempt (~4s later) — succeeds
    expect(driver.getConnectionDiagnostics(dev)).toMatchObject({ state: "connected", reconnectAttempts: 0 });
    expect(attempts).toBe(4);
    await driver.disconnect();
  });

  it("one device's reconnect loop never affects another device's connection", async () => {
    vi.useFakeTimers();
    const { client: goodClient } = fakeClient();
    const driver = new AppleTvProtocolDriver({
      reconnectBaseMs: 1_000,
      connect: async ({ address }) => {
        if (address === "flaky") throw new Error("connection refused");
        return goodClient;
      },
    });
    await driver.connect();
    const flakyId = "device-flaky" as DeviceId;
    const goodId = "device-good" as DeviceId;
    await driver.bind({ deviceId: flakyId, capability: "media", address: "flaky" });
    await driver.bind({ deviceId: goodId, capability: "media", address: "good" });

    expect(driver.getConnectionDiagnostics(flakyId)?.state).toBe("error");
    expect(driver.getConnectionDiagnostics(goodId)?.state).toBe("connected");

    await vi.advanceTimersByTimeAsync(5_000); // let the flaky device retry repeatedly
    expect(driver.getConnectionDiagnostics(goodId)?.state).toBe("connected"); // unaffected
    await driver.disconnect();
  });

  it("AppleTvPairingRequiredError moves the binding to 'pairing_required' and does NOT enter the reconnect loop", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const driver = new AppleTvProtocolDriver({
      connect: async () => {
        attempts += 1;
        throw new AppleTvPairingRequiredError();
      },
    });
    await driver.connect();
    const dev = "device-unpaired" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", address: "10.0.0.1" });
    expect(driver.getConnectionDiagnostics(dev)?.state).toBe("pairing_required");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(1); // never retried on its own
    await driver.disconnect();
  });

  it("disconnect() clears every binding's reconnect timer — no leaked timers after teardown", async () => {
    vi.useFakeTimers();
    const driver = new AppleTvProtocolDriver({
      reconnectBaseMs: 1_000,
      connect: async () => {
        throw new Error("always down");
      },
    });
    await driver.connect();
    const dev = "device-down" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", address: "10.0.0.1" });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await driver.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a command against a non-connected device fails descriptively rather than silently no-op'ing", async () => {
    const driver = new AppleTvProtocolDriver({
      connect: async () => {
        throw new Error("down");
      },
    });
    await driver.connect();
    const dev = "device-down" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "media", address: "10.0.0.1" });
    await expect(driver.command(dev, { capability: "media", action: "play" })).rejects.toThrow(/not connected/);
    await driver.disconnect();
  });
});

describe("AppleTvProtocolDriver — discovery / stable identity", () => {
  it("discover() returns a backendId derived from the mDNS instance name, never the raw host/address", async () => {
    const services: MdnsService[] = [
      { name: "Living Room._mediaremotetv._tcp.local", host: "192.168.1.50", port: 7000, addresses: ["192.168.1.50"], txt: {} },
    ];
    const driver = new AppleTvProtocolDriver({ mdns: async () => services });
    const found = await driver.discover();
    expect(found).toHaveLength(1);
    expect(found[0]!.backendId).toBe("Living Room");
    expect(found[0]!.backendId).not.toBe("192.168.1.50");
    expect(found[0]!.suggestedName).toBe("Living Room");
    expect(found[0]!.capabilities).toEqual(["media", "remote"]);
  });

  it("the SAME device rediscovered after an IP change reports the SAME backendId — proves reconciliation is possible via the existing registry, never IP-keyed identity", async () => {
    const before: MdnsService[] = [{ name: "Theater._mediaremotetv._tcp.local", host: "192.168.1.10", port: 7000, addresses: ["192.168.1.10"], txt: {} }];
    const after: MdnsService[] = [{ name: "Theater._mediaremotetv._tcp.local", host: "192.168.1.99", port: 7000, addresses: ["192.168.1.99"], txt: {} }];
    const driver = new AppleTvProtocolDriver({ mdns: async () => before });
    const first = (await driver.discover())[0]!;

    const driver2 = new AppleTvProtocolDriver({ mdns: async () => after });
    const second = (await driver2.discover())[0]!;

    expect(first.backendId).toBe(second.backendId); // identity survives the IP change
    expect(first.raw).toMatchObject({ address: "192.168.1.10" });
    expect(second.raw).toMatchObject({ address: "192.168.1.99" }); // the address itself DID change
  });

  it("multiple discovered Apple TVs are distinct selectable candidates, never merged", async () => {
    const services: MdnsService[] = [
      { name: "Living Room._mediaremotetv._tcp.local", host: "192.168.1.10", port: 7000, addresses: ["192.168.1.10"], txt: {} },
      { name: "Theater._mediaremotetv._tcp.local", host: "192.168.1.11", port: 7000, addresses: ["192.168.1.11"], txt: {} },
      { name: "Bedroom._mediaremotetv._tcp.local", host: "192.168.1.12", port: 7000, addresses: ["192.168.1.12"], txt: {} },
    ];
    const driver = new AppleTvProtocolDriver({ mdns: async () => services });
    const found = await driver.discover();
    expect(found).toHaveLength(3);
    expect(new Set(found.map((d) => d.backendId)).size).toBe(3);
    expect(found.map((d) => d.suggestedName)).toEqual(["Living Room", "Theater", "Bedroom"]);
  });
});

describe("AppleTvProtocolDriver — state events / artwork", () => {
  it("emits a state event through onState() when now-playing changes, scoped to the correct deviceId", async () => {
    const { client } = fakeClient({ app: "Music", state: "playing" });
    const driver = new AppleTvProtocolDriver({ connect: async () => client });
    await driver.connect();
    const dev = "device-events" as DeviceId;

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));
    await driver.bind({ deviceId: dev, capability: "media", address: "10.0.0.1" });

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.deviceId === dev)).toBe(true);
    await driver.disconnect();
  });

  it("getArtwork() delegates to the bound device's own client only", async () => {
    const art = { data: Buffer.from("fake-jpeg"), mimeType: "image/jpeg" };
    const withArt = fakeClient();
    withArt.client.getArtwork = async () => art;
    const noArt = fakeClient();
    const driver = new AppleTvProtocolDriver({ connect: async ({ address: addr }) => (addr === "with-art" ? withArt.client : noArt.client) });
    await driver.connect();
    const devWithArt = "device-art" as DeviceId;
    const devNoArt = "device-no-art" as DeviceId;
    await driver.bind({ deviceId: devWithArt, capability: "media", address: "with-art" });
    await driver.bind({ deviceId: devNoArt, capability: "media", address: "no-art" });

    expect(await driver.getArtwork(devWithArt)).toEqual(art);
    expect(await driver.getArtwork(devNoArt)).toBeNull();
    await driver.disconnect();
  });
});

describe("AppleTvProtocolDriver — capability guard", () => {
  it("rejects a bind for any capability other than 'media'/'remote'", async () => {
    const driver = new AppleTvProtocolDriver();
    await driver.connect();
    await expect(
      driver.bind({ deviceId: "device-x" as DeviceId, capability: "onoff", address: "10.0.0.1" }),
    ).rejects.toThrow(/not supported/);
    await driver.disconnect();
  });
});

describe("AppleTvProtocolDriver — remote (navigation) capability (§ Phase 2C)", () => {
  it("binding both media and remote for one device shares a single connection/client", async () => {
    const { client, calls } = fakeClient();
    let connectCount = 0;
    const driver = new AppleTvProtocolDriver({
      connect: async () => {
        connectCount++;
        return client;
      },
    });
    await driver.connect();
    await driver.bind({ deviceId: "tv-1" as DeviceId, capability: "media", address: "a" });
    await driver.bind({ deviceId: "tv-1" as DeviceId, capability: "remote", address: "a" });
    expect(connectCount).toBe(1);

    await driver.command("tv-1" as DeviceId, { capability: "remote", action: "up" });
    expect(calls).toContain("button:up");
    await driver.disconnect();
  });

  it("routes each of up/down/left/right/select/menu/home through the client's pressButton", async () => {
    const { client, calls } = fakeClient();
    const driver = new AppleTvProtocolDriver({ connect: async () => client });
    await driver.connect();
    await driver.bind({ deviceId: "tv-1" as DeviceId, capability: "remote", address: "a" });

    for (const action of ["up", "down", "left", "right", "select", "menu", "home"] as const) {
      await driver.command("tv-1" as DeviceId, { capability: "remote", action });
      expect(calls).toContain(`button:${action}`);
    }
    await driver.disconnect();
  });

  it("records remote state (lastButton) scoped to the remote capability, independent of media state", async () => {
    const { client } = fakeClient();
    const driver = new AppleTvProtocolDriver({ connect: async () => client });
    await driver.connect();
    await driver.bind({ deviceId: "tv-1" as DeviceId, capability: "media", address: "a" });
    await driver.bind({ deviceId: "tv-1" as DeviceId, capability: "remote", address: "a" });

    await driver.command("tv-1" as DeviceId, { capability: "remote", action: "menu" });
    expect(driver.getState("tv-1" as DeviceId, "remote")).toEqual({ kind: "remote", lastButton: "menu" });
    expect(driver.getState("tv-1" as DeviceId, "media")?.kind).toBe("media");
  });

  it("a command for a capability this device wasn't bound for throws (no bypass)", async () => {
    const { client } = fakeClient();
    const driver = new AppleTvProtocolDriver({ connect: async () => client });
    await driver.connect();
    await driver.bind({ deviceId: "tv-1" as DeviceId, capability: "media", address: "a" }); // remote NOT bound
    await expect(
      driver.command("tv-1" as DeviceId, { capability: "remote", action: "up" }),
    ).rejects.toThrow(/not bound/);
    await driver.disconnect();
  });

  it("two Apple TVs each bound for remote+media stay isolated: a button on A never reaches B", async () => {
    const a = fakeClient();
    const b = fakeClient();
    const driver = new AppleTvProtocolDriver({
      connect: async ({ address }) => (address === "addr-a" ? a.client : b.client),
    });
    await driver.connect();
    await driver.bind({ deviceId: "tv-a" as DeviceId, capability: "media", address: "addr-a" });
    await driver.bind({ deviceId: "tv-a" as DeviceId, capability: "remote", address: "addr-a" });
    await driver.bind({ deviceId: "tv-b" as DeviceId, capability: "media", address: "addr-b" });
    await driver.bind({ deviceId: "tv-b" as DeviceId, capability: "remote", address: "addr-b" });

    await driver.command("tv-a" as DeviceId, { capability: "remote", action: "select" });
    expect(a.calls).toContain("button:select");
    expect(b.calls).not.toContain("button:select");
    await driver.disconnect();
  });
});

describe("AppleTvProtocolDriver — multi-instance regression: A/B/C, shared room (§ Phase 2C)", () => {
  it("three Apple TVs (two sharing a room) stay fully isolated for commands, state, and artwork", async () => {
    const a = fakeClient({ title: "A-title" });
    const b = fakeClient({ title: "B-title" });
    const c = fakeClient({ title: "C-title" });
    const driver = new AppleTvProtocolDriver({
      connect: async ({ address }) => (address === "addr-a" ? a.client : address === "addr-b" ? b.client : c.client),
    });
    await driver.connect();
    // A and C are both "Living Room" at the SupremeOS device-model level (this driver
    // never sees/stores roomId at all — Device.roomId has no uniqueness constraint, so
    // this is purely a documentation fixture, not something the driver code branches on).
    await driver.bind({ deviceId: "tv-a" as DeviceId, capability: "media", address: "addr-a" });
    await driver.bind({ deviceId: "tv-a" as DeviceId, capability: "remote", address: "addr-a" });
    await driver.bind({ deviceId: "tv-b" as DeviceId, capability: "media", address: "addr-b" });
    await driver.bind({ deviceId: "tv-b" as DeviceId, capability: "remote", address: "addr-b" });
    await driver.bind({ deviceId: "tv-c" as DeviceId, capability: "media", address: "addr-c" });
    await driver.bind({ deviceId: "tv-c" as DeviceId, capability: "remote", address: "addr-c" });

    await driver.command("tv-a" as DeviceId, { capability: "media", action: "play" });
    expect(a.calls).toContain("play");
    expect(b.calls).not.toContain("play");
    expect(c.calls).not.toContain("play");

    await driver.command("tv-b" as DeviceId, { capability: "remote", action: "down" });
    expect(b.calls).toContain("button:down");
    expect(a.calls).not.toContain("button:down");
    expect(c.calls).not.toContain("button:down");

    await driver.command("tv-c" as DeviceId, { capability: "remote", action: "home" });
    expect(c.calls).toContain("button:home");
    expect(a.calls).not.toContain("button:home");
    expect(b.calls).not.toContain("button:home");

    expect(driver.getState("tv-a" as DeviceId, "media")?.kind === "media" && (driver.getState("tv-a" as DeviceId, "media") as any).title).toBe(
      "A-title",
    );
    expect(driver.getState("tv-b" as DeviceId, "media")?.kind === "media" && (driver.getState("tv-b" as DeviceId, "media") as any).title).toBe(
      "B-title",
    );

    await driver.getArtwork("tv-a" as DeviceId);
    // fakeClient() (Phase 1 helper) has no getArtwork — driver.getArtwork() must return
    // null rather than throwing, and must never touch B/C's clients.
    expect(b.calls.length + c.calls.length).toBe(2); // only the two button-press calls above
    await driver.disconnect();
  });
});

describe("AppleTvProtocolDriver — IP-change / rebind identity (§ Phase 2C)", () => {
  it("rebinding a device onto a new address reconnects the SAME deviceId's binding, never a duplicate", async () => {
    const oldSite = fakeClient();
    const newSite = fakeClient();
    let connectedAddresses: string[] = [];
    const driver = new AppleTvProtocolDriver({
      connect: async ({ address }) => {
        connectedAddresses.push(address);
        return address === "192.168.1.10" ? oldSite.client : newSite.client;
      },
    });
    await driver.connect();
    await driver.bind({ deviceId: "tv-stable" as DeviceId, capability: "media", address: "192.168.1.10" });
    expect(driver.manages("tv-stable" as DeviceId)).toBe(true);

    // The existing, generic reconciliation path (DriverBindingEngine.rebind(): unbind
    // then bind again) — this driver implements no second IP-change mechanism of its
    // own, per Phase 1's architecture note.
    await driver.unbind("tv-stable" as DeviceId);
    await driver.bind({ deviceId: "tv-stable" as DeviceId, capability: "media", address: "192.168.1.50" });

    expect(connectedAddresses).toEqual(["192.168.1.10", "192.168.1.50"]);
    expect(driver.manages("tv-stable" as DeviceId)).toBe(true); // same deviceId, still exactly one entry
    await driver.command("tv-stable" as DeviceId, { capability: "media", action: "play" });
    expect(newSite.calls).toContain("play");
    expect(oldSite.calls).not.toContain("play"); // old connection's client never reused
    await driver.disconnect();
  });
});
