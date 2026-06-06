import { createServer, type Server } from "node:net";
import Aedes from "aedes";
import { connectAsync } from "mqtt";
import type { DeviceId } from "@supreme/domain-model";
import {
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type BackendStateEvent,
} from "@supreme/integration-layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MqttProtocolDriver } from "./mqtt-driver.js";

/**
 * Full native path: SIL → SupremeNativeAdapter → real MqttProtocolDriver → broker.
 * Commanding a device through the SIL (pure Supreme) publishes a real MQTT message,
 * and a device's MQTT state report surfaces back through the SIL as a normalized
 * capability event — with no protocol detail leaking above the adapter.
 */
describe("SIL over the native MQTT engine (embedded broker)", () => {
  const aedes = new Aedes();
  let server: Server;
  let port = 0;
  let sil: SupremeIntegrationLayer;
  let driver: MqttProtocolDriver;

  beforeAll(async () => {
    server = createServer(aedes.handle as unknown as (s: unknown) => void);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    driver = new MqttProtocolDriver({ url: `mqtt://127.0.0.1:${port}` });
    const native = new SupremeNativeAdapter({ drivers: [driver] });
    sil = new SupremeIntegrationLayer({ adapter: native });
    await sil.start();
    await native.bind({ deviceId: "dev-lamp" as DeviceId, capability: "onoff", address: "z2m/lamp" }, "mqtt");
  });
  afterAll(async () => {
    await sil.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => aedes.close(resolve));
  });

  it("commands publish over MQTT and device reports surface through the SIL", async () => {
    const dev = "dev-lamp" as DeviceId;

    const spy = await connectAsync(`mqtt://127.0.0.1:${port}`);
    const onSet = new Promise<string>((resolve) => spy.on("message", (_t, p) => resolve(p.toString())));
    await spy.subscribeAsync("z2m/lamp/set");

    await sil.command(dev, { capability: "onoff", action: "on" });
    expect(JSON.parse(await onSet).state).toBe("ON");

    const events: BackendStateEvent[] = [];
    const got = new Promise<void>((resolve) => sil.subscribe((e) => {
      events.push(e);
      resolve();
    }));
    await spy.publishAsync("z2m/lamp", JSON.stringify({ state: "ON" }));
    await got;

    expect(events[0]?.deviceId).toBe(dev);
    expect(events[0]?.state).toEqual({ kind: "onoff", on: true });

    await spy.endAsync();
  });
});
