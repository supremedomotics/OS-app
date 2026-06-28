import { describe, expect, it } from "vitest";
import { HapBridge, type CharacteristicWrite, type HapAccessory, type HapTransport } from "./bridge.js";
import type { HapCommand } from "./hap-mapping.js";

/** A fake HAP transport: records published accessories + characteristic updates, replays writes. */
class FakeTransport implements HapTransport {
  published: HapAccessory[] = [];
  updates: { accessoryId: string; characteristic: string; value: number | boolean }[] = [];
  started = false;
  private writeHandler?: (w: CharacteristicWrite) => void;
  publishAccessory(a: HapAccessory) {
    this.published.push(a);
  }
  updateCharacteristic(accessoryId: string, characteristic: string, value: number | boolean) {
    this.updates.push({ accessoryId, characteristic, value });
  }
  onWrite(handler: (w: CharacteristicWrite) => void) {
    this.writeHandler = handler;
  }
  async start() {
    this.started = true;
  }
  async stop() {
    this.started = false;
  }
  /** Simulate a HomeKit controller writing a characteristic. */
  emitWrite(w: CharacteristicWrite) {
    this.writeHandler?.(w);
  }
}

describe("HapBridge", () => {
  it("publishes a device as an accessory with merged services", () => {
    const transport = new FakeTransport();
    const bridge = new HapBridge({ transport, onCommand: () => {} });
    const acc = bridge.addDevice({ id: "lamp", name: "Reading Lamp", capabilities: ["onoff", "brightness", "color"] });
    // onoff→Switch, brightness/color→Lightbulb: Lightbulb merges On+Brightness+Hue+Saturation+ColorTemperature.
    const lightbulb = acc.services.find((s) => s.type === "Lightbulb");
    expect(lightbulb?.characteristics).toEqual(expect.arrayContaining(["On", "Brightness", "Hue", "Saturation", "ColorTemperature"]));
    expect(transport.published).toHaveLength(1);
    expect(bridge.accessoryCount()).toBe(1);
  });

  it("turns a HomeKit characteristic write into a Supreme command", async () => {
    const transport = new FakeTransport();
    const commands: { deviceId: string; command: HapCommand }[] = [];
    const bridge = new HapBridge({ transport, onCommand: (deviceId, command) => void commands.push({ deviceId, command }) });
    bridge.addDevice({ id: "door", name: "Front Door", capabilities: ["lock"] });

    transport.emitWrite({ accessoryId: "door", characteristic: "LockTargetState", value: 1 });
    await Promise.resolve();
    expect(commands).toEqual([{ deviceId: "door", command: { capability: "lock", action: "lock" } }]);
  });

  it("ignores writes to unknown accessories and read-only characteristics", async () => {
    const transport = new FakeTransport();
    const commands: unknown[] = [];
    const bridge = new HapBridge({ transport, onCommand: () => void commands.push(1) });
    bridge.addDevice({ id: "lamp", name: "Lamp", capabilities: ["onoff"] });

    transport.emitWrite({ accessoryId: "ghost", characteristic: "On", value: true }); // unknown device
    transport.emitWrite({ accessoryId: "lamp", characteristic: "CurrentTemperature", value: 20 }); // read-only
    await Promise.resolve();
    expect(commands).toHaveLength(0);
  });

  it("pushes Supreme state to HomeKit characteristics", () => {
    const transport = new FakeTransport();
    const bridge = new HapBridge({ transport, onCommand: () => {} });
    bridge.addDevice({ id: "lamp", name: "Lamp", capabilities: ["brightness"] });

    bridge.pushState("lamp", "brightness", { on: true, level: 80 });
    expect(transport.updates).toEqual(
      expect.arrayContaining([
        { accessoryId: "lamp", characteristic: "On", value: true },
        { accessoryId: "lamp", characteristic: "Brightness", value: 80 },
      ]),
    );
  });

  it("starts and stops the transport", async () => {
    const transport = new FakeTransport();
    const bridge = new HapBridge({ transport, onCommand: () => {} });
    await bridge.start();
    expect(transport.started).toBe(true);
    await bridge.stop();
    expect(transport.started).toBe(false);
  });
});
