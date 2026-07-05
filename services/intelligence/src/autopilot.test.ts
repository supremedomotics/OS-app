import { describe, expect, it } from "vitest";
import { applyResponse, type AutoPilotSettings, decideAutoPilot, resetEpisode, startOfNextUtcDay, type SuggestionState } from "./autopilot.js";
import type { Suggestion } from "./engine.js";

const NOW = Date.UTC(2026, 5, 29, 12, 0, 0); // 2026-06-29T12:00:00Z
const sug = (decision: number): Suggestion => ({
  key: "energy:idle:dev_fan",
  module: "energy",
  kind: "idle_device_vacant_area",
  title: "t",
  body: "b",
  deviceId: "dev_fan",
  actions: ["turn_off", "keep_on", "ignore_today", "always_ignore", "enable_auto_pilot"],
  confidence: { decision },
  ts: NOW,
});
const settings = (over: Partial<AutoPilotSettings> = {}): AutoPilotSettings => ({ mode: "notify_only", threshold: 0.8, reminderMinutes: 30, ...over });

describe("decideAutoPilot", () => {
  it("notifies once, then debounces until the reminder gap", () => {
    const first = decideAutoPilot(sug(0.9), undefined, settings(), NOW);
    expect(first).toMatchObject({ action: "notify", kind: "suggest" });

    const justNotified: SuggestionState = { key: "energy:idle:dev_fan", firstNotifiedAt: NOW, lastNotifiedAt: NOW };
    expect(decideAutoPilot(sug(0.9), justNotified, settings(), NOW + 5 * 60_000).action).toBe("suppress");
    // After the 30-min gap, with confidence still high → remind.
    expect(decideAutoPilot(sug(0.9), justNotified, settings(), NOW + 31 * 60_000).action).toBe("notify");
    // ...but not if confidence has dropped below threshold.
    expect(decideAutoPilot(sug(0.5), justNotified, settings(), NOW + 31 * 60_000).action).toBe("suppress");
  });

  it("auto-executes only in auto_pilot/adaptive above threshold, else asks", () => {
    expect(decideAutoPilot(sug(0.9), undefined, settings({ mode: "auto_pilot" }), NOW)).toMatchObject({ action: "execute" });
    expect(decideAutoPilot(sug(0.7), undefined, settings({ mode: "auto_pilot" }), NOW)).toMatchObject({ action: "notify" });
    expect(decideAutoPilot(sug(0.95), undefined, settings({ mode: "adaptive" }), NOW)).toMatchObject({ action: "execute" });
    // Approval mode never auto-executes; it asks.
    expect(decideAutoPilot(sug(0.99), undefined, settings({ mode: "approval" }), NOW)).toMatchObject({ action: "notify", kind: "approval" });
  });

  it("honours keep_on / ignore_today / always_ignore / already-executed", () => {
    expect(decideAutoPilot(sug(0.9), { key: "k", alwaysIgnore: true }, settings(), NOW).reason).toBe("always_ignore");
    expect(decideAutoPilot(sug(0.9), { key: "k", keptOnEpisode: true }, settings(), NOW).reason).toBe("kept_on");
    expect(decideAutoPilot(sug(0.9), { key: "k", executedAt: NOW }, settings(), NOW).reason).toBe("already_executed");
    const ignoredToday: SuggestionState = { key: "k", ignoreUntilMs: startOfNextUtcDay(NOW) };
    expect(decideAutoPilot(sug(0.9), ignoredToday, settings(), NOW).reason).toBe("ignore_today");
    // Next day → no longer ignored.
    expect(decideAutoPilot(sug(0.9), ignoredToday, settings(), startOfNextUtcDay(NOW) + 1000).action).toBe("notify");
  });
});

describe("applyResponse", () => {
  it("maps each action to the right durable state", () => {
    expect(applyResponse({ key: "k" }, "keep_on", NOW).keptOnEpisode).toBe(true);
    expect(applyResponse({ key: "k" }, "always_ignore", NOW).alwaysIgnore).toBe(true);
    expect(applyResponse({ key: "k" }, "turn_off", NOW).executedAt).toBe(NOW);
    expect(applyResponse({ key: "k" }, "ignore_today", NOW).ignoreUntilMs).toBe(startOfNextUtcDay(NOW));
  });
});

describe("resetEpisode", () => {
  it("clears episode flags but keeps permanent + day-scoped suppressions", () => {
    const state: SuggestionState = { key: "k", keptOnEpisode: true, firstNotifiedAt: NOW, alwaysIgnore: true, ignoreUntilMs: 123 };
    const reset = resetEpisode(state);
    expect(reset.keptOnEpisode).toBeUndefined();
    expect(reset.firstNotifiedAt).toBeUndefined();
    expect(reset.alwaysIgnore).toBe(true);
    expect(reset.ignoreUntilMs).toBe(123);
  });
});
