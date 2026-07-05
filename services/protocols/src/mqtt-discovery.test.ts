import { createServer, type Server } from "node:net";
import Aedes from "aedes";
import { connectAsync } from "mqtt";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { MqttProtocolDriver } from "./mqtt-driver.js";
import { discoveredFromZ2mBridge } from "./mqtt-discovery.js";

/** A representative Zigbee2MQTT bridge/devices payload. */
const BRIDGE = [
  { type: "Coordinator", friendly_name: "Coordinator" },
  {
    friendly_name: "living_lamp",
    type: "Router",
    definition: {
      vendor: "IKEA",
      model: "LED1545G12",
      exposes: [{ type: "light", features: [{ property: "state" }, { property: "brightness" }] }],
    },
  },
  {
    friendly_name: "hall_sensor",
    type: "EndDevice",
    definition: {
      vendor: "Aqara",
      model: "WSDCGQ11LM",
      exposes: [{ type: "numeric", property: "temperature" }],
    },
  },
  { friendly_name: "no_def", type: "EndDevice", definition: null },
];

describe("Zigbee2MQTT discovery mapping", () => {
  it("maps exposes to Supreme capabilities and skips coordinator/undescribed", () => {
    const found = discoveredFromZ2mBridge(BRIDGE, "zigbee2mqtt");
    expect(found.map((d) => d.suggestedName).sort()).toEqual(["hall_sensor", "living_lamp"]);
    const lamp = found.find((d) => d.suggestedName === "living_lamp")!;
    expect(lamp.backendId).toBe("zigbee2mqtt/living_lamp");
    expect(lamp.capabilities).toEqual(["onoff", "brightness"]);
    const sensor = found.find((d) => d.suggestedName === "hall_sensor")!;
    expect(sensor.capabilities).toEqual(["sensor"]);
  });
});

describe("MqttProtocolDriver discovery (embedded broker)", () => {
  const aedes = new Aedes();
  let server: Server;
  let port = 0;
  let driver: MqttProtocolDriver;

  beforeAll(async () => {
    server = createServer(aedes.handle as unknown as (s: unknown) => void);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    // Publish the retained bridge device list BEFORE the driver connects.
    const seeder = await connectAsync(`mqtt://127.0.0.1:${port}`);
    await seeder.publishAsync("zigbee2mqtt/bridge/devices", JSON.stringify(BRIDGE), { retain: true });
    await seeder.endAsync();

    driver = new MqttProtocolDriver({ url: `mqtt://127.0.0.1:${port}` });
    await driver.connect();
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => aedes.close(resolve));
  });

  it("surfaces retained bridge devices through discover()", async () => {
    // Allow the retained message to arrive after subscribe.
    await new Promise((r) => setTimeout(r, 120));
    const found = await driver.discover();
    expect(found.map((d) => d.suggestedName).sort()).toEqual(["hall_sensor", "living_lamp"]);
  });
});
