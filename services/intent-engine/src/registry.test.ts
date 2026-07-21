import type { IntentDefinition } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { IntentRegistry } from "./registry.js";

function def(overrides: Partial<IntentDefinition> = {}): IntentDefinition {
  return {
    id: "toggleLight",
    name: "Toggle Light",
    category: "lighting",
    description: "",
    requiredCapabilities: ["onoff"],
    parameters: [],
    targetKinds: ["device"],
    version: "1.0.0",
    i18nKey: null,
    ...overrides,
  };
}

describe("IntentRegistry", () => {
  it("registers a capability-driven intent with a translate handler", () => {
    const registry = new IntentRegistry();
    registry.register(def(), { translate: () => ({ capability: "onoff", action: "toggle" }) });
    expect(registry.get("toggleLight")?.definition.id).toBe("toggleLight");
  });

  it("registers a system-level intent with a runSystem handler", () => {
    const registry = new IntentRegistry();
    registry.register(def({ id: "runScene", requiredCapabilities: [], targetKinds: ["scene"] }), { runSystem: async () => {} });
    expect(registry.get("runScene")?.definition.id).toBe("runScene");
  });

  it("throws at registration when a capability-driven intent has no translate handler", () => {
    const registry = new IntentRegistry();
    expect(() => registry.register(def(), {})).toThrow(/registered no translate handler/);
  });

  it("throws at registration when a system intent has no runSystem handler", () => {
    const registry = new IntentRegistry();
    expect(() => registry.register(def({ requiredCapabilities: [] }), {})).toThrow(/registered no runSystem handler/);
  });

  it("throws at registration when both handlers are given for a capability-driven intent", () => {
    const registry = new IntentRegistry();
    expect(() =>
      registry.register(def(), { translate: () => ({ capability: "onoff", action: "toggle" }), runSystem: async () => {} }),
    ).toThrow(/cannot have both/);
  });

  it("get() returns null for an unregistered intent", () => {
    expect(new IntentRegistry().get("nope")).toBeNull();
  });

  it("list() and listByCategory() reflect every registered definition", () => {
    const registry = new IntentRegistry();
    registry.register(def({ id: "toggleLight" }), { translate: () => ({ capability: "onoff", action: "toggle" }) });
    registry.register(def({ id: "lightOn", category: "lighting" }), { translate: () => ({ capability: "onoff", action: "on" }) });
    registry.register(def({ id: "lock", category: "security", requiredCapabilities: ["lock"] }), {
      translate: () => ({ capability: "lock", action: "lock" }),
    });

    expect(registry.list()).toHaveLength(3);
    expect(registry.listByCategory("lighting").map((d) => d.id).sort()).toEqual(["lightOn", "toggleLight"]);
    expect(registry.listByCategory("security").map((d) => d.id)).toEqual(["lock"]);
  });

  it("register() replaces an existing entry for the same id", () => {
    const registry = new IntentRegistry();
    registry.register(def(), { translate: () => ({ capability: "onoff", action: "toggle" }) });
    registry.register(def({ name: "Toggle Light v2" }), { translate: () => ({ capability: "onoff", action: "toggle" }) });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("toggleLight")?.definition.name).toBe("Toggle Light v2");
  });
});
