import { describe, expect, it } from "vitest";
import { CoreEventBus, type DeviceEvent, type ButtonEvent, type DriverEvent } from "./event-bus.js";

describe("CoreEventBus", () => {
  it("delivers a published event to every listener", () => {
    const bus = new CoreEventBus();
    const received: unknown[] = [];
    bus.on((e) => received.push(e));
    bus.on((e) => received.push(e));
    const event: DeviceEvent = {
      type: "device",
      driver: "casambi",
      ts: "2026-01-01T00:00:00.000Z",
      deviceId: "d1" as never,
      capability: "onoff",
      state: { kind: "onoff", on: true },
    };
    bus.publish(event);
    expect(received).toEqual([event, event]);
  });

  it("unsubscribe stops delivering further events to that listener only", () => {
    const bus = new CoreEventBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = bus.on((e) => a.push(e));
    bus.on((e) => b.push(e));
    const event: ButtonEvent = { type: "button", driver: "casambi", ts: "now", nativeId: "1", button: 0, action: "short_press" };
    bus.publish(event);
    unsubA();
    bus.publish(event);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("a listener throwing propagates (no built-in isolation, by design)", () => {
    const bus = new CoreEventBus();
    let secondCalled = false;
    bus.on(() => {
      throw new Error("boom");
    });
    bus.on(() => {
      secondCalled = true;
    });
    const event: DriverEvent = { type: "driver", driver: "casambi", ts: "now", kind: "connected" };
    expect(() => bus.publish(event)).toThrow("boom");
    expect(secondCalled).toBe(false);
  });
});
