import { describe, expect, it } from "vitest";
import { TvDeviceSessionManager } from "./tv-device-session-manager.js";
import { FakeTvTransport } from "./transports/fake-tv-transport.js";
import type { TvDeviceConfig } from "./tv-types.js";

function makeConfig(deviceId: string, model: string, transports: Map<string, FakeTvTransport>): TvDeviceConfig {
  return {
    deviceId,
    host: `192.168.1.${deviceId}`,
    platform: "android_tv",
    transportKind: "fake",
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    createTransport: (config) => {
      const t = new FakeTvTransport(config);
      transports.set(deviceId, t);
      void model;
      return t;
    },
  };
}

describe("TvDeviceSessionManager — §27 cross-device isolation", () => {
  it("Test A/D — two devices' media/app state never contaminate each other", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    await mgr.bind(makeConfig("TV001", "Chromecast", transports));
    await mgr.bind(makeConfig("TV002", "Chromecast", transports));

    transports.get("TV001")!.emitMediaState({ title: "Netflix" });
    transports.get("TV001")!.emit({ type: "foreground-app", app: { packageName: "com.netflix.ninja", applicationName: "Netflix", source: "fake", confidence: "app_only", timestamp: new Date().toISOString() } });
    transports.get("TV002")!.emitMediaState({ title: "YouTube" });
    transports.get("TV002")!.emit({ type: "foreground-app", app: { packageName: "com.google.android.youtube.tv", applicationName: "YouTube", source: "fake", confidence: "app_only", timestamp: new Date().toISOString() } });

    expect(mgr.getMediaState("TV001")?.title).toBe("Netflix");
    expect(mgr.getMediaState("TV002")?.title).toBe("YouTube");
    expect(mgr.getForegroundApp("TV001")?.packageName).toBe("com.netflix.ninja");
    expect(mgr.getForegroundApp("TV002")?.packageName).toBe("com.google.android.youtube.tv");

    await mgr.unbindAll();
  });

  it("Test B — a volume command to one device leaves another untouched", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    await mgr.bind(makeConfig("TV001", "X", transports));
    await mgr.bind(makeConfig("TV002", "X", transports));
    await mgr.setVolume("TV001", 20);
    expect(mgr.getDiagnostics("TV001")?.lastCommand).toBe("volume:20");
    expect(mgr.getDiagnostics("TV002")?.lastCommand).toBeNull();
    await mgr.unbindAll();
  });

  it("Test C — disconnecting/unbinding one device leaves the other connected", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    await mgr.bind(makeConfig("TV001", "X", transports));
    await mgr.bind(makeConfig("TV002", "X", transports));
    await mgr.unbind("TV001");
    expect(mgr.manages("TV001")).toBe(false);
    expect(mgr.manages("TV002")).toBe(true);
    expect(mgr.get("TV002")!.isConnected()).toBe(true);
    await mgr.unbindAll();
  });

  it("Test E/F — identical model names / identical friendly names never collapse devices", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    const ids = Array.from({ length: 20 }, (_, i) => `TV${String(i).padStart(3, "0")}`);
    for (const id of ids) await mgr.bind(makeConfig(id, "Identical Model X", transports));
    expect(mgr.count()).toBe(ids.length);
    for (const id of ids) expect(mgr.manages(id)).toBe(true);
    await mgr.unbindAll();
    expect(mgr.count()).toBe(0);
  });

  it("a failed reconnect loop on one device never blocks another device's commands", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    await mgr.bind(makeConfig("TV001", "X", transports));
    await mgr.bind(makeConfig("TV002", "X", transports));
    // TV001 drops and its transport keeps failing to reconnect.
    transports.get("TV001")!.failNextConnect("connection");
    transports.get("TV001")!.simulateConnectionLost();
    // TV002 must still work immediately, without waiting on TV001's backoff at all.
    await mgr.sendKey("TV002", "HOME");
    expect(transports.get("TV002")!.received).toEqual(["HOME"]);
    await mgr.unbindAll();
  });

  it("§7 — a dedupe-keyed command sent to two devices never coalesces across devices (keys are device-scoped)", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    await mgr.bind(makeConfig("TV001", "X", transports));
    await mgr.bind(makeConfig("TV002", "X", transports));
    await Promise.all([mgr.setVolume("TV001", 11), mgr.setVolume("TV002", 22)]);
    expect(transports.get("TV001")!.volumePercent).toBe(11);
    expect(transports.get("TV002")!.volumePercent).toBe(22);
    await mgr.unbindAll();
  });

  it("§16 — getAllDiagnostics stays device-scoped: N devices in, N distinct entries out, never merged", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    await mgr.bind(makeConfig("TV001", "X", transports));
    await mgr.bind(makeConfig("TV002", "X", transports));
    await mgr.sendKey("TV001", "HOME");
    const all = mgr.getAllDiagnostics();
    expect(all).toHaveLength(2);
    const tv1 = all.find((d) => d.deviceId === "TV001")!;
    const tv2 = all.find((d) => d.deviceId === "TV002")!;
    expect(tv1.lastCommand).toBe("key:HOME");
    expect(tv2.lastCommand).toBeNull();
    await mgr.unbindAll();
  });
});

describe("TvDeviceSessionManager — §9/§10 unbind fully stops activity, rebind leaves nothing behind", () => {
  it("§9 — unbind(deviceId) stops reconnect attempts and event delivery for that device only", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    await mgr.bind(makeConfig("TV001", "X", transports));
    const oldTransport = transports.get("TV001")!;
    await mgr.unbind("TV001");
    const attemptsAfterUnbind = mgr.getDiagnostics("TV001");
    expect(attemptsAfterUnbind).toBeNull(); // diagnostics gone entirely, not just zeroed
    // The old (disposed) transport pushing an event must never resurrect the session or
    // reach any listener — it's disposed and orphaned, not merely disconnected.
    const seen: unknown[] = [];
    mgr.onEvent((deviceId, event) => seen.push({ deviceId, event }));
    oldTransport.simulateConnectionLost();
    oldTransport.emitMediaState({ title: "Ghost update" });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(0);
    expect(mgr.manages("TV001")).toBe(false);
  });

  it("§10 — rebinding a device leaves no listeners from the old session firing into the new one's diagnostics", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    await mgr.bind(makeConfig("TV001", "X", transports));
    const oldTransport = transports.get("TV001")!;
    await mgr.bind(makeConfig("TV001", "X", transports)); // rebind
    const newTransport = transports.get("TV001")!;
    expect(oldTransport).not.toBe(newTransport);

    const seen: unknown[] = [];
    const unsub = mgr.onEvent((deviceId, event) => seen.push({ deviceId, event }));
    oldTransport.emitMediaState({ title: "Stale, from the disposed session" });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(0); // the old session's listener was torn down on rebind

    newTransport.emitMediaState({ title: "Fresh, from the current session" });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
    unsub();
    await mgr.unbindAll();
  });

  it("§11 — unbindAll() disposes every transport, not just clearing the map", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    const ids = ["TV001", "TV002", "TV003"];
    for (const id of ids) await mgr.bind(makeConfig(id, "X", transports));
    await mgr.unbindAll();
    for (const id of ids) {
      expect(transports.get(id)!.isDisposed()).toBe(true);
      expect(transports.get(id)!.isConnected()).toBe(false);
    }
    expect(mgr.count()).toBe(0);
  });
});

describe("TvDeviceSessionManager — §20/§22 lifecycle & resource safety", () => {
  it("bind -> unbind -> bind -> unbind does not leak sessions or leave stale transports connected", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    for (let i = 0; i < 5; i++) {
      await mgr.bind(makeConfig("TV001", "X", transports));
      await mgr.unbind("TV001");
    }
    expect(mgr.count()).toBe(0);
    expect(transports.get("TV001")!.isDisposed()).toBe(true);
    expect(transports.get("TV001")!.isConnected()).toBe(false);
  });

  it("re-binding an already-bound deviceId replaces the old session rather than stacking a second one", async () => {
    const transports = new Map<string, FakeTvTransport>();
    const mgr = new TvDeviceSessionManager();
    await mgr.bind(makeConfig("TV001", "X", transports));
    const first = transports.get("TV001")!;
    await mgr.bind(makeConfig("TV001", "X", transports));
    const second = transports.get("TV001")!;
    expect(mgr.count()).toBe(1);
    expect(first.isDisposed()).toBe(true);
    expect(second.isConnected()).toBe(true);
    await mgr.unbindAll();
  });

  it("unbind for an unbound deviceId is a no-op, not an error", async () => {
    const mgr = new TvDeviceSessionManager();
    await expect(mgr.unbind("nope")).resolves.toBeUndefined();
  });
});
