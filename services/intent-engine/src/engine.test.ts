import type { CapabilityCommand, CapabilityState, Device, DeviceId, RoomId } from "@supreme/domain-model";
import { newId } from "@supreme/domain-model";
import { describe, expect, it, vi } from "vitest";
import { CapabilityIndex } from "./capability-index.js";
import { registerBuiltinIntents } from "./catalog.js";
import { IntentEngine, type IntentEngineExecutors } from "./engine.js";
import { IntentRegistry } from "./registry.js";

function device(overrides: Partial<Device> & { capabilities: Device["capabilities"] }): Device {
  return {
    id: newId("device") as DeviceId,
    homeId: newId("home") as never,
    roomId: null,
    name: "Device",
    supremeType: "light",
    manufacturer: null,
    model: null,
    driverId: null,
    status: "online",
    state: {},
    metadata: {},
    ...overrides,
  };
}

function executors(overrides: Partial<IntentEngineExecutors> = {}): IntentEngineExecutors {
  return {
    command: vi.fn(async () => {}),
    getState: vi.fn(async () => null),
    activateScene: vi.fn(async () => {}),
    runAutomation: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("IntentEngine — the full pipeline", () => {
  it("Physical Input → Intent → Capability Engine → Best Device Capability → Driver Adapter: resolves and commands a single device target", async () => {
    const light = device({ capabilities: [{ kind: "onoff", config: {} }] });
    const index = new CapabilityIndex();
    index.hydrate([light]);
    const registry = new IntentRegistry<IntentEngineExecutors>();
    registerBuiltinIntents(registry);
    const ex = executors();
    const engine = new IntentEngine({ registry, capabilityIndex: index, executors: ex });

    const run = await engine.run("toggleLight", { kind: "device", deviceId: light.id }, {});

    expect(ex.command).toHaveBeenCalledWith(light.id, { capability: "onoff", action: "toggle" });
    expect(run.ok).toBe(true);
    expect(run.resolvedDeviceIds).toEqual([light.id]);
  });

  it("resolves EVERY compatible device in a room — the 'Movie Mode dims every light' case", async () => {
    const room = newId("room") as RoomId;
    const lampA = device({ roomId: room, capabilities: [{ kind: "brightness", config: {} }] });
    const lampB = device({ roomId: room, capabilities: [{ kind: "brightness", config: {} }] });
    const otherRoomLamp = device({ roomId: newId("room") as RoomId, capabilities: [{ kind: "brightness", config: {} }] });
    const index = new CapabilityIndex();
    index.hydrate([lampA, lampB, otherRoomLamp]);
    const registry = new IntentRegistry<IntentEngineExecutors>();
    registerBuiltinIntents(registry);
    const ex = executors();
    const engine = new IntentEngine({ registry, capabilityIndex: index, executors: ex });

    const run = await engine.run("setBrightness", { kind: "room", roomId: room }, { level: 20 });

    expect(ex.command).toHaveBeenCalledTimes(2);
    expect(ex.command).toHaveBeenCalledWith(lampA.id, { capability: "brightness", action: "set", level: 20 });
    expect(ex.command).toHaveBeenCalledWith(lampB.id, { capability: "brightness", action: "set", level: 20 });
    expect(run.resolvedDeviceIds.sort()).toEqual([lampA.id, lampB.id].sort());
  });

  it("migration readiness: the SAME intent + target keeps working when a different driver now owns the device", async () => {
    // No protocol/driver concept appears anywhere in this test — that's the point.
    // "Replacing KNX with Casambi" is invisible to the Intent Engine because it only
    // ever sees Device + CapabilityKind; the executors.command closure is where a
    // real gateway would route to whichever driver the SIL currently has bound.
    const light = device({ capabilities: [{ kind: "onoff", config: {} }] });
    const index = new CapabilityIndex();
    index.hydrate([light]);
    const registry = new IntentRegistry<IntentEngineExecutors>();
    registerBuiltinIntents(registry);

    const knxCommand = vi.fn(async () => {});
    const engineOnKnx = new IntentEngine({ registry, capabilityIndex: index, executors: executors({ command: knxCommand }) });
    await engineOnKnx.run("toggleLight", { kind: "device", deviceId: light.id }, {});
    expect(knxCommand).toHaveBeenCalledWith(light.id, { capability: "onoff", action: "toggle" });

    // The device is "migrated" — same Device id, same capability, a different
    // executors.command implementation (standing in for a different driver/SIL
    // routing decision). The exact same intent invocation still works, unchanged.
    const casambiCommand = vi.fn(async () => {});
    const engineOnCasambi = new IntentEngine({ registry, capabilityIndex: index, executors: executors({ command: casambiCommand }) });
    await engineOnCasambi.run("toggleLight", { kind: "device", deviceId: light.id }, {});
    expect(casambiCommand).toHaveBeenCalledWith(light.id, { capability: "onoff", action: "toggle" });
  });

  it("throws (and records a failed run) for an unregistered intent", async () => {
    const index = new CapabilityIndex();
    const registry = new IntentRegistry<IntentEngineExecutors>();
    const engine = new IntentEngine({ registry, capabilityIndex: index, executors: executors() });

    await expect(engine.run("notARealIntent", { kind: "home" }, {})).rejects.toThrow(/is not registered/);
    const runs = engine.recentRuns();
    expect(runs[0]!.ok).toBe(false);
    expect(runs[0]!.error).toMatch(/is not registered/);
  });

  it("throws when the target kind isn't accepted by the intent", async () => {
    const registry = new IntentRegistry<IntentEngineExecutors>();
    registerBuiltinIntents(registry);
    const engine = new IntentEngine({ registry, capabilityIndex: new CapabilityIndex(), executors: executors() });

    await expect(engine.run("toggleLight", { kind: "scene", sceneId: newId("scene") as never }, {})).rejects.toThrow(
      /does not accept a "scene" target/,
    );
  });

  it("throws when no device in scope supports the required capability", async () => {
    const registry = new IntentRegistry<IntentEngineExecutors>();
    registerBuiltinIntents(registry);
    const index = new CapabilityIndex();
    index.hydrate([device({ capabilities: [{ kind: "position", config: {} }] })]); // a blind, not a light
    const engine = new IntentEngine({ registry, capabilityIndex: index, executors: executors() });

    await expect(engine.run("toggleLight", { kind: "device", deviceId: newId("device") as DeviceId }, {})).rejects.toThrow(
      /no device compatible/,
    );
  });

  it("validates params before dispatch — rejects a missing required parameter", async () => {
    const registry = new IntentRegistry<IntentEngineExecutors>();
    registerBuiltinIntents(registry);
    const light = device({ capabilities: [{ kind: "brightness", config: {} }] });
    const index = new CapabilityIndex();
    index.hydrate([light]);
    const engine = new IntentEngine({ registry, capabilityIndex: index, executors: executors() });

    await expect(engine.run("setBrightness", { kind: "device", deviceId: light.id }, {})).rejects.toThrow(
      /missing required parameter "level"/,
    );
  });

  it("system intents skip capability resolution entirely", async () => {
    const registry = new IntentRegistry<IntentEngineExecutors>();
    registerBuiltinIntents(registry);
    const runAutomation = vi.fn(async () => {});
    const engine = new IntentEngine({ registry, capabilityIndex: new CapabilityIndex(), executors: executors({ runAutomation }) });
    const automationId = newId("automation") as never;

    const run = await engine.run("runAutomation", { kind: "automation", automationId }, {});

    expect(runAutomation).toHaveBeenCalledWith(automationId);
    expect(run.resolvedDeviceIds).toEqual([]);
  });

  it("a custom, externally-registered intent (never seeded by the built-in catalog) runs identically — proves the registry is genuinely extensible", async () => {
    const registry = new IntentRegistry<IntentEngineExecutors>();
    registry.register(
      {
        id: "customPulse",
        name: "Custom Pulse",
        category: "system",
        description: "A future driver's own intent.",
        requiredCapabilities: ["onoff"],
        parameters: [],
        targetKinds: ["device"],
        version: "1.0.0",
        i18nKey: null,
      },
      { translate: () => ({ capability: "onoff", action: "on" } as CapabilityCommand) },
    );
    const light = device({ capabilities: [{ kind: "onoff", config: {} }] });
    const index = new CapabilityIndex();
    index.hydrate([light]);
    const ex = executors();
    const engine = new IntentEngine({ registry, capabilityIndex: index, executors: ex });

    await engine.run("customPulse", { kind: "device", deviceId: light.id }, {});

    expect(ex.command).toHaveBeenCalledWith(light.id, { capability: "onoff", action: "on" });
  });

  it("passes real current state + capability config into the translator", async () => {
    const registry = new IntentRegistry<IntentEngineExecutors>();
    registerBuiltinIntents(registry);
    const light = device({ capabilities: [{ kind: "brightness", config: {} }] });
    const index = new CapabilityIndex();
    index.hydrate([light]);
    const state: CapabilityState = { kind: "brightness", on: true, level: 50 };
    const ex = executors({ getState: vi.fn(async () => state) });
    const engine = new IntentEngine({ registry, capabilityIndex: index, executors: ex });

    await engine.run("increaseBrightness", { kind: "device", deviceId: light.id }, { step: 15 });

    expect(ex.command).toHaveBeenCalledWith(light.id, { capability: "brightness", action: "set", level: 65 });
  });

  it("recentRuns() can be scoped to one intent id", async () => {
    const registry = new IntentRegistry<IntentEngineExecutors>();
    registerBuiltinIntents(registry);
    const light = device({ capabilities: [{ kind: "onoff", config: {} }] });
    const index = new CapabilityIndex();
    index.hydrate([light]);
    const engine = new IntentEngine({ registry, capabilityIndex: index, executors: executors() });

    await engine.run("toggleLight", { kind: "device", deviceId: light.id }, {});
    await engine.run("lightOn", { kind: "device", deviceId: light.id }, {});

    expect(engine.recentRuns("toggleLight")).toHaveLength(1);
    expect(engine.recentRuns()).toHaveLength(2);
  });
});
