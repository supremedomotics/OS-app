import { describe, expect, it } from "vitest";
import { CapabilityCommand, CapabilityState } from "./capabilities.js";
import { newId } from "./ids.js";
import { DeviceId } from "./ids.js";

describe("ids", () => {
  it("generates prefixed ULID-style ids that validate", () => {
    const id = newId("device");
    expect(id.startsWith("dev_")).toBe(true);
    expect(() => DeviceId.parse(id)).not.toThrow();
  });

  it("sorts roughly by creation time", () => {
    const a = newId("device", 1_000_000_000_000);
    const b = newId("device", 2_000_000_000_000);
    expect(a < b).toBe(true);
  });
});

describe("capability commands", () => {
  it("accepts a brightness set command", () => {
    const cmd = CapabilityCommand.parse({
      capability: "brightness",
      action: "set",
      level: 60,
    });
    expect(cmd.capability).toBe("brightness");
  });

  it("rejects out-of-range brightness", () => {
    expect(() =>
      CapabilityCommand.parse({ capability: "brightness", action: "set", level: 140 }),
    ).toThrow();
  });
});

describe("capability state", () => {
  it("discriminates by kind", () => {
    const state = CapabilityState.parse({ kind: "brightness", on: true, level: 42 });
    expect(state.kind).toBe("brightness");
  });
});
