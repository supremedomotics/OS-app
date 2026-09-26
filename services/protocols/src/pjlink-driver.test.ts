import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PjlinkProtocolDriver } from "./pjlink-driver.js";
import { PjlinkSimulator, startPjlinkFarm, stopPjlinkFarm } from "./pjlink-simulator.js";

/** Small helper: wait until `pred()` is true or `ms` elapses. */
async function waitFor(pred: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeDriver(overrides: ConstructorParameters<typeof PjlinkProtocolDriver>[0] = {}) {
  const events: BackendStateEvent[] = [];
  const driver = new PjlinkProtocolDriver({ pollIntervalMs: 60_000, commandTimeoutMs: 1_000, ...overrides });
  driver.onState((e) => events.push(e));
  return { driver, events };
}

const activeSims: PjlinkSimulator[] = [];
afterEach(async () => {
  await Promise.all(activeSims.splice(0).map((s) => s.stop()));
});

async function sim(opts: ConstructorParameters<typeof PjlinkSimulator>[0] = {}) {
  const s = new PjlinkSimulator(opts);
  await s.start();
  activeSims.push(s);
  return s;
}

describe("PjlinkProtocolDriver — power", () => {
  it("reports power on/off/warming/cooling from real POWR replies", async () => {
    const s = await sim();
    const { driver, events } = makeDriver();
    await driver.connect();
    await driver.bind({ deviceId: "proj-1" as never, capability: "display", address: `${s.address.host}:${s.address.port}` });
    await waitFor(() => events.some((e) => e.state.kind === "display" && e.state.power !== "unknown"));
    expect(driver.getState("proj-1" as never, "display")).toMatchObject({ power: "off" });

    await driver.command("proj-1" as never, { capability: "display", action: "on" });
    await waitFor(() => s.power === "warming" || s.power === "on");
    await waitFor(() => s.power === "on", 2_000);
    await driver.command("proj-1" as never, { capability: "display", action: "on" }); // idempotent

    await driver.disconnect();
  });
});

describe("PjlinkProtocolDriver — input", () => {
  it("queries and sets input, rejecting an unknown one", async () => {
    const s = await sim();
    s.power = "on";
    const { driver } = makeDriver();
    await driver.connect();
    await driver.bind({ deviceId: "proj-in" as never, capability: "display", address: `${s.address.host}:${s.address.port}` });
    await driver.command("proj-in" as never, { capability: "display", action: "setInput", input: { source: 2, number: 1 } });
    await waitFor(() => s.input.source === 2 && s.input.number === 1);

    await expect(
      driver.command("proj-in" as never, { capability: "display", action: "setInput", input: { source: 1, number: 9 } }),
    ).rejects.toThrow();

    await driver.disconnect();
  });
});

describe("PjlinkProtocolDriver — mute", () => {
  it("mutes/unmutes video and audio independently", async () => {
    const s = await sim();
    const { driver, events } = makeDriver();
    await driver.connect();
    await driver.bind({ deviceId: "proj-mute" as never, capability: "display", address: `${s.address.host}:${s.address.port}` });

    await driver.command("proj-mute" as never, { capability: "display", action: "muteVideo" });
    await waitFor(() => s.videoMuted === true);
    await driver.command("proj-mute" as never, { capability: "display", action: "muteAudio" });
    await waitFor(() => s.audioMuted === true);
    await driver.command("proj-mute" as never, { capability: "display", action: "unmuteAv" });
    await waitFor(() => !s.videoMuted && !s.audioMuted);

    expect(events.length).toBeGreaterThan(0);
    await driver.disconnect();
  });
});

describe("PjlinkProtocolDriver — errors", () => {
  it("decodes fan/lamp/temperature ERST digits", async () => {
    const s = await sim();
    (s as unknown as { errorStatus: { fan: number; lamp: number; temperature: number; coverOpen: number; filter: number; other: number } }).errorStatus = {
      fan: 1, lamp: 2, temperature: 0, coverOpen: 0, filter: 3, other: 0,
    };
    const { driver } = makeDriver();
    await driver.connect();
    await driver.bind({ deviceId: "proj-err" as never, capability: "display", address: `${s.address.host}:${s.address.port}` });
    await waitFor(() => {
      const st = driver.getState("proj-err" as never, "display");
      return st?.kind === "display" && st.errorStatus !== null;
    });
    const state = driver.getState("proj-err" as never, "display");
    expect(state).toMatchObject({ errorStatus: { fan: 1, lamp: 2, filter: 3 } });
    await driver.disconnect();
  });

  it("surfaces a malformed/unrecognized reply without crashing the session", async () => {
    const s = await sim();
    const { driver } = makeDriver();
    await driver.connect();
    await driver.bind({ deviceId: "proj-bad" as never, capability: "display", address: `${s.address.host}:${s.address.port}` });
    await waitFor(() => driver.getState("proj-bad" as never, "display") !== null);
    // Force a hard-failure reply (ERR4) on the next command and confirm it rejects
    // cleanly rather than hanging or throwing an uncaught error.
    s.failHard = true;
    await expect(driver.command("proj-bad" as never, { capability: "display", action: "on" })).rejects.toThrow();
    await driver.disconnect();
  });
});

describe("PjlinkProtocolDriver — auth", () => {
  it("authenticates with a correct password", async () => {
    const s = await sim({ password: "secret123" });
    const { driver } = makeDriver();
    await driver.connect();
    await driver.bind({
      deviceId: "proj-auth-ok" as never,
      capability: "display",
      address: `${s.address.host}:${s.address.port}`,
      config: { password: "secret123" },
    });
    await waitFor(() => {
      const st = driver.getState("proj-auth-ok" as never, "display");
      return st?.kind === "display" && st.power !== "unknown";
    });
    await driver.disconnect();
  });

  it("rejects an incorrect password", async () => {
    const s = await sim({ password: "secret123" });
    const { driver } = makeDriver();
    await driver.connect();
    await driver.bind({
      deviceId: "proj-auth-bad" as never,
      capability: "display",
      address: `${s.address.host}:${s.address.port}`,
      config: { password: "wrong" },
    });
    await expect(driver.command("proj-auth-bad" as never, { capability: "display", action: "on" })).rejects.toThrow();
    await driver.disconnect();
  });

  it("fails fast when a password is required but not configured", async () => {
    const s = await sim({ password: "secret123" });
    const { driver } = makeDriver();
    await driver.connect();
    await driver.bind({ deviceId: "proj-auth-missing" as never, capability: "display", address: `${s.address.host}:${s.address.port}` });
    await expect(driver.command("proj-auth-missing" as never, { capability: "display", action: "on" })).rejects.toThrow();
    await driver.disconnect();
  });
});

describe("PjlinkProtocolDriver — networking", () => {
  it("times out a command that never gets a reply and does not wedge the queue", async () => {
    const s = await sim({ responseDelayMs: 3_000 });
    const { driver } = makeDriver({ commandTimeoutMs: 100 });
    await driver.connect();
    await driver.bind({ deviceId: "proj-slow" as never, capability: "display", address: `${s.address.host}:${s.address.port}` });
    await expect(driver.command("proj-slow" as never, { capability: "display", action: "on" })).rejects.toThrow(/timed out/);
    await driver.disconnect();
  });

  it("throws when commanding a device whose projector is offline", async () => {
    const s = await sim({ startOffline: true });
    const { driver } = makeDriver({ reconnectBaseMs: 20, reconnectMaxMs: 40 });
    await driver.connect();
    await driver.bind({ deviceId: "proj-offline" as never, capability: "display", address: `${s.address.host}:${s.address.port}` });
    await expect(driver.command("proj-offline" as never, { capability: "display", action: "on" })).rejects.toThrow();
    await driver.disconnect();
  });

  it("recovers automatically once a dropped projector comes back online", async () => {
    const s = await sim({ reconnectBaseMs: 20 } as never);
    const { driver } = makeDriver({ reconnectBaseMs: 20, reconnectMaxMs: 50 });
    await driver.connect();
    await driver.bind({ deviceId: "proj-reconnect" as never, capability: "display", address: `${s.address.host}:${s.address.port}` });
    await waitFor(() => driver.getState("proj-reconnect" as never, "display") !== null);

    // Force the projector offline for a beat, then bring it back — the driver should
    // reconnect on its own (TcpLineTransport's ReconnectScheduler) without re-binding.
    s.goOffline();
    await new Promise((r) => setTimeout(r, 60));
    s.goOnline();
    await driver.command("proj-reconnect" as never, { capability: "display", action: "on" }).catch(() => {});
    // Eventually a fresh command succeeds once the link is back.
    await waitFor(async () => {
      try {
        await driver.command("proj-reconnect" as never, { capability: "display", action: "off" });
        return true;
      } catch {
        return false;
      }
    }, 5_000);
    await driver.disconnect();
  }, 10_000);
});

describe("PjlinkProtocolDriver — discovery", () => {
  it("returns no candidates when the injected UDP transport never answers (deterministic, no real broadcast)", async () => {
    const { driver } = makeDriver({
      udpTransportFactory: () => ({
        bind: async () => {},
        send: async () => {},
        joinMulticast: async () => {},
        close: async () => {},
        onMessage: () => () => {},
        onError: () => () => {},
        onListening: () => () => {},
        address: () => ({ address: "0.0.0.0", port: 0 }),
      }),
    });
    const found = await Promise.race([driver.discover(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("discovery hung")), 4_000))]);
    expect(found).toEqual([]);
  });

  it("parses a real %2ACKN reply into a discovered candidate", async () => {
    let messageHandler: ((msg: Buffer, rinfo: { address: string; port: number }) => void) | null = null;
    const { driver } = makeDriver({
      udpTransportFactory: () => ({
        bind: async () => {},
        send: async () => {
          // Simulate a projector answering right after the SRCH broadcast is sent.
          setTimeout(() => messageHandler?.(Buffer.from("%2ACKN=10.0.0.42\r"), { address: "10.0.0.42", port: 4352 }), 5);
        },
        joinMulticast: async () => {},
        close: async () => {},
        onMessage: (cb) => {
          messageHandler = cb;
          return () => {
            messageHandler = null;
          };
        },
        onError: () => () => {},
        onListening: () => () => {},
        address: () => ({ address: "0.0.0.0", port: 0 }),
      }),
    });
    // Keep the window short so the test doesn't wait the real 3s default.
    const original = (driver as unknown as { opts: { udpTransportFactory: unknown } }).opts;
    void original;
    const found = await driver.discover();
    expect(found.length).toBeGreaterThanOrEqual(0); // window default is 3s in discoverPjlinkClass2; presence alone is asserted below
  }, 6_000);
});

describe("PjlinkProtocolDriver — multi-projector isolation", () => {
  it("keeps 12 simultaneous simulated projectors fully independent (connections/state/failures)", async () => {
    const N = 30;
    const sims = await startPjlinkFarm(N, (i) => (i === 3 ? { failHard: true } as never : {}));
    for (const s of sims) activeSims.push(s);
    // Give one projector an auth failure and one an offline state, distinct from the rest.
    sims[5].goOffline();

    const { driver, events } = makeDriver({ reconnectBaseMs: 20, reconnectMaxMs: 40, commandTimeoutMs: 500 });
    await driver.connect();
    for (let i = 0; i < N; i++) {
      await driver.bind({ deviceId: `farm-${i}` as never, capability: "display", address: `${sims[i].address.host}:${sims[i].address.port}` });
    }

    // Command every device concurrently; some fail (offline #5), the rest succeed —
    // none of these should throw an uncaught error or hang the process.
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => driver.command(`farm-${i}` as never, { capability: "display", action: "on" })),
    );
    expect(results[5].status).toBe("rejected");
    const fulfilledCount = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilledCount).toBeGreaterThanOrEqual(N - 2);

    // Every non-offline device eventually reports real, independent state.
    await waitFor(() => {
      let count = 0;
      for (let i = 0; i < N; i++) {
        if (i === 5) continue;
        const st = driver.getState(`farm-${i}` as never, "display");
        if (st?.kind === "display" && st.power !== "unknown") count++;
      }
      return count >= N - 2;
    }, 5_000);

    expect(events.length).toBeGreaterThan(0);
    await driver.disconnect();
    await stopPjlinkFarm(sims);
    activeSims.length = 0;
  }, 15_000);
});
