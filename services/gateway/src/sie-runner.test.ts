import { describe, expect, it } from "vitest";
import { type AutoPilotSettings, type SuggestionState } from "@supreme/intelligence";
import { SieRunner, type SieDevice, type SieHistoryInput, type SieRunnerDeps } from "./sie-runner.js";

const NOW = Date.UTC(2026, 5, 29, 12, 0, 0);

function harness(over: Partial<SieRunnerDeps> = {}, deviceOver: Partial<SieDevice> = {}) {
  let now = NOW;
  let settings: AutoPilotSettings = { mode: "notify_only" };
  let states: Record<string, SuggestionState> = {};
  let online: string[] = [];
  const device: SieDevice = { id: "dev_fan", name: "Living Room Fan", roomId: "room_lr", on: true, watts: 75, intel: { ownerUserId: "usr_m" }, ...deviceOver };
  const commands: { id: string; on: boolean }[] = [];
  const notifs: { title: string; body: string }[] = [];
  const history: SieHistoryInput[] = [];
  const deps: SieRunnerDeps = {
    homeId: "home_1",
    getZones: async () => [{ id: "z_ground", name: "Ground Floor", roomIds: ["room_lr"] }],
    onlineUserIds: async () => online,
    listDevices: async () => [device],
    getSettings: async () => settings,
    setSettings: async (s) => void (settings = s),
    getRate: async () => ({ ratePerKwh: 8, currency: "INR" }),
    getSuggestionStates: async () => states,
    setSuggestionStates: async (m) => void (states = m),
    command: async (id, on) => void commands.push({ id, on }),
    notify: async (n) => void notifs.push({ title: n.title, body: n.body }),
    recordHistory: async (h) => void history.push(h),
    now: () => now,
    ...over,
  };
  const runner = new SieRunner(deps);
  return {
    runner,
    commands,
    notifs,
    history,
    setNow: (t: number) => void (now = t),
    setOnline: (u: string[]) => void (online = u),
    setMode: (m: AutoPilotSettings["mode"]) => void (settings = { mode: m, threshold: 0.8 }),
    setOff: () => void (device.on = false),
    getSettings: () => settings,
  };
}

const min = (n: number) => n * 60_000;

describe("SieRunner.tick", () => {
  it("waits out a freshly-on device, then notifies once when it's been on + the area is vacant", async () => {
    const h = harness(); // notify_only, nobody online → house vacant
    await h.runner.tick(); // onSince stamped now; onMinutes 0 → no suggestion
    expect(h.notifs).toHaveLength(0);
    expect(h.runner.suggestions).toHaveLength(0);

    h.setNow(NOW + min(32));
    await h.runner.tick(); // 32 min on, vacant → notify
    expect(h.runner.suggestions).toHaveLength(1);
    expect(h.notifs).toHaveLength(1);
    expect(h.notifs[0]!.body).toContain("75W");
    expect(h.history.some((r) => r.action === "notified")).toBe(true);
    expect(h.commands).toHaveLength(0); // notify_only never controls

    // Debounced: another tick a minute later does not re-notify.
    h.setNow(NOW + min(33));
    await h.runner.tick();
    expect(h.notifs).toHaveLength(1);
  });

  it("auto-executes in auto_pilot above threshold and records the saving", async () => {
    const h = harness();
    h.setMode("auto_pilot");
    await h.runner.tick();
    h.setNow(NOW + min(32));
    await h.runner.tick();
    expect(h.commands).toEqual([{ id: "dev_fan", on: false }]); // turned off automatically
    const auto = h.history.find((r) => r.action === "auto_off");
    expect(auto?.automatic).toBe(true);
    expect(auto?.estimatedKwhSaved).toBeCloseTo(0.075, 3); // 75W × 1h
    expect(auto?.estimatedCostSaved).toBeCloseTo(0.6, 2); // × INR 8
  });

  it("stops nagging once the user says Keep On", async () => {
    const h = harness();
    await h.runner.tick(); // prime onSince at NOW
    h.setNow(NOW + min(20));
    await h.runner.tick();
    expect(h.notifs).toHaveLength(1);
    await h.runner.respond("energy:idle:dev_fan", "keep_on");
    h.setNow(NOW + min(60));
    await h.runner.tick();
    expect(h.notifs).toHaveLength(1); // suppressed for this on-episode
  });

  it("turns the device off when the user responds Turn Off", async () => {
    const h = harness();
    await h.runner.tick(); // prime onSince at NOW
    h.setNow(NOW + min(20));
    await h.runner.tick();
    const res = await h.runner.respond("energy:idle:dev_fan", "turn_off");
    expect(res.executed).toBe(true);
    expect(h.commands).toEqual([{ id: "dev_fan", on: false }]);
    expect(h.history.some((r) => r.action === "user_off")).toBe(true);
  });

  it("flips to Auto Pilot when the user enables it", async () => {
    const h = harness();
    await h.runner.tick(); // prime onSince at NOW
    h.setNow(NOW + min(20));
    await h.runner.tick();
    await h.runner.respond("energy:idle:dev_fan", "enable_auto_pilot");
    expect(h.getSettings().mode).toBe("auto_pilot");
  });

  it("exposes a live presence + occupancy snapshot", async () => {
    const h = harness();
    h.setOnline(["usr_a"]);
    await h.runner.tick();
    expect(h.runner.presence.map((e) => e.userId)).toEqual(["usr_a"]);
    expect(h.runner.house?.occupied).toBe(true);
    expect(h.runner.house?.present).toEqual(["usr_a"]);
  });
});
