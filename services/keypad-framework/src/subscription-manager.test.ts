import type { DeviceId, HomeId } from "@supreme/domain-model";
import { newId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { InMemoryKeypadSubscriptionStore, SubscriptionManager } from "./subscription-manager.js";

const deviceId = () => newId("device") as DeviceId;
const homeId = () => newId("home") as HomeId;

describe("SubscriptionManager", () => {
  it("fans one device+capability out to every subscribing keypad control (the brief's example)", async () => {
    const subs = new SubscriptionManager(new InMemoryKeypadSubscriptionStore());
    const home = homeId();
    const light = deviceId();
    const knx = deviceId();
    const casambi = deviceId();
    const lutron = deviceId();

    await subs.subscribe({ homeId: home, deviceId: light, capability: "onoff", keypadId: knx, control: "btn1" });
    await subs.subscribe({ homeId: home, deviceId: light, capability: "onoff", keypadId: casambi, control: "btn2" });
    await subs.subscribe({ homeId: home, deviceId: light, capability: "onoff", keypadId: lutron, control: "led3" });

    const subscribers = subs.subscribersFor(light, "onoff");
    expect(subscribers).toHaveLength(3);
    expect(subscribers.map((s) => s.keypadId).sort()).toEqual([casambi, knx, lutron].sort());
  });

  it("returns no subscribers for a device+capability nobody watches", () => {
    const subs = new SubscriptionManager(new InMemoryKeypadSubscriptionStore());
    expect(subs.subscribersFor(deviceId(), "brightness")).toEqual([]);
  });

  it("unsubscribe removes exactly that subscription", async () => {
    const subs = new SubscriptionManager(new InMemoryKeypadSubscriptionStore());
    const home = homeId();
    const light = deviceId();
    const kp1 = deviceId();
    const kp2 = deviceId();
    const a = await subs.subscribe({ homeId: home, deviceId: light, capability: "onoff", keypadId: kp1, control: "btn1" });
    await subs.subscribe({ homeId: home, deviceId: light, capability: "onoff", keypadId: kp2, control: "btn1" });

    await subs.unsubscribe(a.id);

    const remaining = subs.subscribersFor(light, "onoff");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.keypadId).toBe(kp2);
  });

  it("hydrate() rebuilds the in-memory index from the store (boot path)", async () => {
    const store = new InMemoryKeypadSubscriptionStore();
    const first = new SubscriptionManager(store);
    const home = homeId();
    const light = deviceId();
    const kp = deviceId();
    await first.subscribe({ homeId: home, deviceId: light, capability: "onoff", keypadId: kp, control: "btn1" });

    const second = new SubscriptionManager(store);
    expect(second.subscribersFor(light, "onoff")).toEqual([]); // not hydrated yet
    await second.hydrate();
    expect(second.subscribersFor(light, "onoff")).toHaveLength(1);
  });

  it("scopes subscriptions per device+capability — a different capability on the same device sees nothing", async () => {
    const subs = new SubscriptionManager(new InMemoryKeypadSubscriptionStore());
    const home = homeId();
    const avr = deviceId();
    const kp = deviceId();
    await subs.subscribe({ homeId: home, deviceId: avr, capability: "media", keypadId: kp, control: "btn1" });
    expect(subs.subscribersFor(avr, "onoff")).toEqual([]);
    expect(subs.subscribersFor(avr, "media")).toHaveLength(1);
  });
});
