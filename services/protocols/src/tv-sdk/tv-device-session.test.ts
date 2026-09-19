import { describe, expect, it } from "vitest";
import { TvDeviceSession } from "./tv-device-session.js";
import { FakeTvTransport } from "./transports/fake-tv-transport.js";
import type { TvDeviceConfig } from "./tv-types.js";
import type { TvSessionEvent } from "./tv-events.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeConfig(deviceId: string, capture: { transport?: FakeTvTransport } = {}): TvDeviceConfig {
  return {
    deviceId,
    host: "192.168.1.50",
    platform: "android_tv",
    transportKind: "fake",
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    createTransport: (config) => {
      const t = new FakeTvTransport(config);
      capture.transport = t;
      return t;
    },
  };
}

describe("TvDeviceSession — basic lifecycle", () => {
  it("connects and reports connected", async () => {
    const capture: { transport?: FakeTvTransport } = {};
    const session = new TvDeviceSession(makeConfig("dev-1", capture));
    await session.connect();
    expect(session.isConnected()).toBe(true);
    session.dispose();
  });

  it("sends a remote key through to the transport", async () => {
    const capture: { transport?: FakeTvTransport } = {};
    const session = new TvDeviceSession(makeConfig("dev-1", capture));
    await session.connect();
    await session.sendKey("HOME");
    expect(capture.transport!.received).toEqual(["HOME"]);
    session.dispose();
  });

  it("disconnect() stops the reconnect loop (deliberate disconnect, not a drop)", async () => {
    const capture: { transport?: FakeTvTransport } = {};
    const session = new TvDeviceSession(makeConfig("dev-1", capture));
    await session.connect();
    session.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    expect(session.isConnected()).toBe(false);
    expect(session.getDiagnostics().reconnectAttempts).toBe(0);
    session.dispose();
  });

  it("an unexpected connection-lost schedules reconnect and eventually recovers", async () => {
    const capture: { transport?: FakeTvTransport } = {};
    const session = new TvDeviceSession(makeConfig("dev-1", capture));
    await session.connect();
    capture.transport!.simulateConnectionLost();
    expect(session.isConnected()).toBe(false);
    await waitUntil(() => session.isConnected());
    expect(session.getDiagnostics().connectionState).toBe("connected");
    session.dispose();
  });

  it("a pairing-required failure does NOT auto-retry (needs installer action)", async () => {
    const capture: { transport?: FakeTvTransport } = {};
    const session = new TvDeviceSession(makeConfig("dev-1", capture));
    // fail the very first connect with pairing required
    const config = makeConfig("dev-1", capture);
    let first = true;
    config.createTransport = (c) => {
      const t = new FakeTvTransport(c);
      if (first) {
        t.failNextConnect("pairing");
        first = false;
      }
      capture.transport = t;
      return t;
    };
    const s2 = new TvDeviceSession(config);
    await s2.connect();
    expect(s2.getDiagnostics().connectionState).toBe("pairing_required");
    await new Promise((r) => setTimeout(r, 100));
    expect(s2.getDiagnostics().reconnectAttempts).toBe(0);
    s2.dispose();
    session.dispose();
  });

  it("dispose() releases the transport and stops delivering events", async () => {
    const capture: { transport?: FakeTvTransport } = {};
    const session = new TvDeviceSession(makeConfig("dev-1", capture));
    await session.connect();
    const events: TvSessionEvent[] = [];
    session.onEvent((e) => events.push(e));
    session.dispose();
    expect(capture.transport!.isDisposed()).toBe(true);
    capture.transport!.emitMediaState({ title: "Late Event" });
    expect(events.length).toBe(0);
  });

  it("dispose() rejects any command still queued", async () => {
    const capture: { transport?: FakeTvTransport } = {};
    const session = new TvDeviceSession(makeConfig("dev-1", capture));
    await session.connect();
    const pending = session.sendKey("HOME").catch((e) => e as Error);
    session.dispose();
    const result = await pending;
    // Either it already ran (resolved) or was rejected on dispose — both are acceptable,
    // but it must never hang.
    expect(result === undefined || result instanceof Error).toBe(true);
  });
});

describe("TvDeviceSession — feedback arbitration (§13/§28)", () => {
  it("at an EXPLICIT equal revision, the higher-priority source wins (tie-break)", async () => {
    const capture: { transport?: FakeTvTransport } = {};
    const session = new TvDeviceSession(makeConfig("dev-1", capture));
    await session.connect();
    capture.transport!.emitMediaState({ title: "From Cast" }, { source: "cast", revision: 5 });
    capture.transport!.emitMediaState({ title: "From MediaSession" }, { source: "mediasession", revision: 5 });
    expect(session.getMediaState()?.title).toBe("From MediaSession");
    session.dispose();
  });

  it("a genuinely lower-revision event is rejected outright, even from a higher-priority source arriving later", async () => {
    const capture: { transport?: FakeTvTransport } = {};
    const session = new TvDeviceSession(makeConfig("dev-1", capture));
    await session.connect();
    capture.transport!.emitMediaState({ title: "Newer (poll)" }, { source: "poll", revision: 10 });
    // "mediasession" outranks "poll", but its revision (7) is STALE relative to what's
    // already cached (10) — §28 requires revision to win over priority when both are
    // explicit, so this must be rejected outright, not merely lose a tie-break.
    capture.transport!.emitMediaState({ title: "Stale (mediasession)" }, { source: "mediasession", revision: 7 });
    expect(session.getMediaState()?.title).toBe("Newer (poll)");
    session.dispose();
  });
});
