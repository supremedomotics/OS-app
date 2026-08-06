import { newId, type DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { HaUnavailableAdapter } from "./ha-unavailable-adapter.js";

describe("HaUnavailableAdapter — the honest 'HA compatibility plugin not installed' placeholder", () => {
  it("never connects and reports itself disconnected", async () => {
    const adapter = new HaUnavailableAdapter();
    expect(adapter.kind).toBe("ha-unavailable");
    expect(adapter.isConnected()).toBe(false);
    await adapter.connect();
    expect(adapter.isConnected()).toBe(false);
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });

  it("discovers zero devices — never fabricated, HA genuinely isn't there", async () => {
    const adapter = new HaUnavailableAdapter();
    await expect(adapter.discover()).resolves.toEqual([]);
  });

  it("reads no state for any device", async () => {
    const adapter = new HaUnavailableAdapter();
    const deviceId = newId("device") as DeviceId;
    await expect(adapter.getState(deviceId, "onoff")).resolves.toBeNull();
  });

  it("refuses every command with a clear, typed error instead of silently succeeding", async () => {
    const adapter = new HaUnavailableAdapter();
    const deviceId = newId("device") as DeviceId;
    await expect(adapter.command(deviceId, { capability: "onoff", action: "on" })).rejects.toThrow(
      /Home Assistant compatibility plugin is not enabled/,
    );
  });

  it("onState subscribes to nothing and unsubscribe is a safe no-op", () => {
    const adapter = new HaUnavailableAdapter();
    const unsub = adapter.onState(() => {
      throw new Error("must never fire — HaUnavailableAdapter emits no state");
    });
    expect(() => unsub()).not.toThrow();
  });
});
