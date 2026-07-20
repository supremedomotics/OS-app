import type { CapabilityState, DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import { recordCapabilityState } from "./state-cache.js";

describe("recordCapabilityState (§ Universal AV SDK — state-cache)", () => {
  it("stores the state and notifies every listener, exactly once per call", () => {
    const states = new Map<string, CapabilityState>();
    const events: BackendStateEvent[] = [];
    const listeners = new Set<(e: BackendStateEvent) => void>([(e) => events.push(e)]);
    const dev = "device-1" as DeviceId;

    recordCapabilityState(states, listeners, dev, "onoff", { kind: "onoff", on: true });

    expect(states.get("device-1:onoff")).toEqual({ kind: "onoff", on: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ deviceId: dev, capability: "onoff", state: { kind: "onoff", on: true } });
    expect(typeof events[0]?.ts).toBe("string");
  });

  it("dedupes an identical repeat — no state overwrite, no listener notification", () => {
    const states = new Map<string, CapabilityState>();
    const events: BackendStateEvent[] = [];
    const listeners = new Set<(e: BackendStateEvent) => void>([(e) => events.push(e)]);
    const dev = "device-1" as DeviceId;

    recordCapabilityState(states, listeners, dev, "onoff", { kind: "onoff", on: true });
    recordCapabilityState(states, listeners, dev, "onoff", { kind: "onoff", on: true });

    expect(events).toHaveLength(1); // second call was a no-op dedupe
  });

  it("does not dedupe a genuinely different state", () => {
    const states = new Map<string, CapabilityState>();
    const events: BackendStateEvent[] = [];
    const listeners = new Set<(e: BackendStateEvent) => void>([(e) => events.push(e)]);
    const dev = "device-1" as DeviceId;

    recordCapabilityState(states, listeners, dev, "onoff", { kind: "onoff", on: true });
    recordCapabilityState(states, listeners, dev, "onoff", { kind: "onoff", on: false });

    expect(events).toHaveLength(2);
    expect(states.get("device-1:onoff")).toEqual({ kind: "onoff", on: false });
  });

  it("keys independently per device+capability — no cross-talk", () => {
    const states = new Map<string, CapabilityState>();
    const listeners = new Set<(e: BackendStateEvent) => void>();
    recordCapabilityState(states, listeners, "device-1" as DeviceId, "onoff", { kind: "onoff", on: true });
    recordCapabilityState(states, listeners, "device-1" as DeviceId, "media", {
      kind: "media", playback: "playing", volume: 50, muted: false, title: null, artist: null, source: null, artworkUrl: null,
    });
    recordCapabilityState(states, listeners, "device-2" as DeviceId, "onoff", { kind: "onoff", on: false });

    expect(states.size).toBe(3);
    expect((states.get("device-1:onoff") as { on: boolean }).on).toBe(true);
    expect((states.get("device-2:onoff") as { on: boolean }).on).toBe(false);
  });

  it("notifies every registered listener, not just the first", () => {
    const states = new Map<string, CapabilityState>();
    const a: BackendStateEvent[] = [];
    const b: BackendStateEvent[] = [];
    const listeners = new Set<(e: BackendStateEvent) => void>([(e) => a.push(e), (e) => b.push(e)]);
    recordCapabilityState(states, listeners, "device-1" as DeviceId, "onoff", { kind: "onoff", on: true });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
