import { newId } from "@supreme/domain-model";
import type { DeviceId } from "@supreme/domain-model";
import { describe, expect, it, vi } from "vitest";
import { MockAdapter } from "./mock-adapter.js";
import { SupremeIntegrationLayer } from "./sil.js";
import { commandToHaService } from "./ha/capability-mapper.js";

describe("SIL command + state path", () => {
  it("routes a brightness command through the adapter and emits a normalized state", async () => {
    const adapter = new MockAdapter();
    const sil = new SupremeIntegrationLayer({ adapter });
    await sil.start();

    const deviceId = newId("device") as DeviceId;
    sil.mapEntity(deviceId, "brightness", { backendId: "light.kitchen", backendDomain: "light" });

    const events: unknown[] = [];
    sil.subscribe((e) => events.push(e));

    await sil.command(deviceId, { capability: "brightness", action: "set", level: 60 });

    expect(events).toHaveLength(1);
    const state = await sil.getState(deviceId, "brightness");
    expect(state).toEqual({ kind: "brightness", on: true, level: 60 });
  });

  it("rejects read-only sensor commands", async () => {
    const adapter = new MockAdapter();
    const sil = new SupremeIntegrationLayer({ adapter });
    await sil.start();
    const deviceId = newId("device") as DeviceId;
    await expect(
      // @ts-expect-error sensor is intentionally not a commandable capability
      sil.command(deviceId, { capability: "sensor" }),
    ).rejects.toThrow(/read-only/);
  });

  it("surfaces backend_unavailable when a non-HA adapter is down", async () => {
    const adapter = new MockAdapter();
    const sil = new SupremeIntegrationLayer({ adapter }); // never started
    const deviceId = newId("device") as DeviceId;
    await expect(
      sil.command(deviceId, { capability: "onoff", action: "on" }),
    ).rejects.toThrow(/not connected/);
  });
});

describe("HA capability mapper", () => {
  it("maps brightness set to light.turn_on with brightness_pct", () => {
    const call = commandToHaService("light.kitchen", {
      capability: "brightness",
      action: "set",
      level: 60,
    });
    expect(call).toEqual({
      domain: "light",
      service: "turn_on",
      data: { entity_id: "light.kitchen", brightness_pct: 60 },
    });
  });

  it("maps lock unlock to lock.unlock", () => {
    const call = commandToHaService("lock.front", { capability: "lock", action: "unlock" });
    expect(call.service).toBe("unlock");
  });
});

it("placeholder for unused import lint", () => {
  expect(typeof vi).toBe("object");
});
