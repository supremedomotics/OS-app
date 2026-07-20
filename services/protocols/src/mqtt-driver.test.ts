import { createServer, type Server } from "node:net";
import Aedes from "aedes";
import { connectAsync } from "mqtt";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MqttProtocolDriver } from "./mqtt-driver.js";

/**
 * Drives the real MQTT driver against an EMBEDDED broker (aedes) — exercising real
 * publish/subscribe + the Zigbee2MQTT payload convention end-to-end, with no
 * external broker. Proves: commands publish to `{base}/set`, and inbound device
 * state on `{base}` normalizes into Supreme capability events.
 */
describe("MqttProtocolDriver (embedded broker)", () => {
  const aedes = new Aedes();
  let server: Server;
  let port = 0;
  let driver: MqttProtocolDriver;

  beforeAll(async () => {
    server = createServer(aedes.handle as unknown as (s: unknown) => void);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    driver = new MqttProtocolDriver({ url: `mqtt://127.0.0.1:${port}` });
    await driver.connect();
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => aedes.close(resolve));
  });

  it("publishes a Zigbee2MQTT command and normalizes inbound state", async () => {
    const dev = "device-light-1" as DeviceId;
    const base = "zigbee2mqtt/living_lamp";
    await driver.bind({ deviceId: dev, capability: "onoff", address: base });
    await driver.bind({ deviceId: dev, capability: "brightness", address: base });

    // Independent client to observe the command the driver publishes to {base}/set.
    const spy = await connectAsync(`mqtt://127.0.0.1:${port}`);
    const setMsg = new Promise<string>((resolve) => {
      spy.on("message", (_t, p) => resolve(p.toString()));
    });
    await spy.subscribeAsync(`${base}/set`);

    await driver.command(dev, { capability: "brightness", action: "set", level: 50 });
    const published = JSON.parse(await setMsg);
    expect(published.state).toBe("ON");
    expect(published.brightness).toBe(127); // 50% → 127/254

    // Simulate the device reporting its state back on the base topic.
    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));
    const settled = new Promise<void>((resolve) => {
      driver.onState((e) => {
        if (e.capability === "brightness") resolve();
      });
    });
    await spy.publishAsync(base, JSON.stringify({ state: "ON", brightness: 254 }));
    await settled;

    const bright = events.find((e) => e.capability === "brightness");
    expect(bright?.state).toEqual({ kind: "brightness", on: true, level: 100 });
    expect(driver.getState(dev, "onoff")).toEqual({ kind: "onoff", on: true });

    await spy.endAsync();
  });

  it("unbind releases one device's topic subscription without disturbing a sibling on the same topic (§ Driver Lifecycle Completion)", async () => {
    const devA = "device-lamp-a" as DeviceId;
    const devB = "device-lamp-b" as DeviceId;
    const shared = "zigbee2mqtt/shared_lamp";
    const solo = "zigbee2mqtt/solo_lamp";
    await driver.bind({ deviceId: devA, capability: "onoff", address: shared });
    await driver.bind({ deviceId: devB, capability: "brightness", address: shared });
    await driver.bind({ deviceId: devA, capability: "brightness", address: solo });

    const spy = await connectAsync(`mqtt://127.0.0.1:${port}`);

    // Unbind devA entirely: its solo topic must be unsubscribed; the shared topic
    // must stay subscribed because devB still has a capability bound to it.
    await driver.unbind(devA);
    expect(driver.manages(devA)).toBe(false);
    expect(driver.getState(devA, "brightness")).toBeNull();

    const devBEvents: BackendStateEvent[] = [];
    const devBSeen = new Promise<void>((resolve) => {
      driver.onState((e) => {
        if (e.deviceId === devB) {
          devBEvents.push(e);
          resolve();
        }
      });
    });
    await spy.publishAsync(shared, JSON.stringify({ state: "ON", brightness: 254 }));
    await devBSeen;
    expect(driver.getState(devB, "brightness")).toEqual({ kind: "brightness", on: true, level: 100 });

    // The solo topic was fully released — a message there must not resurrect devA's state.
    await spy.publishAsync(solo, JSON.stringify({ state: "ON", brightness: 254 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(driver.getState(devA, "brightness")).toBeNull();

    await driver.unbind(devB);
    expect(driver.manages(devB)).toBe(false);

    await spy.endAsync();
  });
});
