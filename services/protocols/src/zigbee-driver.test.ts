import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import {
  ZigbeeProtocolDriver,
  type ZigbeeAddress,
  type ZigbeeController,
  type ZigbeeDeviceInfo,
  type ZigbeeReport,
} from "./zigbee-driver.js";
import { commandToZcl, capabilitiesFromZclClusters } from "./zigbee-codec.js";

/** A fake Zigbee coordinator: records ZCL commands, replays reports, lists devices. */
class FakeCoordinator implements ZigbeeController {
  readonly sent: Array<{ addr: ZigbeeAddress; cluster: string; command: string; payload: Record<string, unknown> }> = [];
  private handler: ((r: ZigbeeReport) => void) | null = null;
  started = false;
  async start() {
    this.started = true;
  }
  async stop() {
    this.started = false;
  }
  async command(addr: ZigbeeAddress, cluster: string, command: string, payload: Record<string, unknown>) {
    this.sent.push({ addr, cluster, command, payload });
  }
  onReport(handler: (r: ZigbeeReport) => void) {
    this.handler = handler;
  }
  async devices(): Promise<ZigbeeDeviceInfo[]> {
    return [
      { ieeeAddr: "0x00124b001f8d2c3e", endpoint: 1, clusters: ["genOnOff", "genLevelCtrl"], manufacturerName: "IKEA", modelId: "LED1545G12" },
      { ieeeAddr: "0xffffffffffffffff", endpoint: 1, clusters: ["genBasic"] }, // no capability → filtered
    ];
  }
  report(r: ZigbeeReport) {
    this.handler?.(r);
  }
}

describe("Zigbee ZCL codec", () => {
  it("maps commands to ZCL cluster commands", () => {
    expect(commandToZcl({ capability: "onoff", action: "off" }, null)).toEqual({
      cluster: "genOnOff",
      command: "off",
      payload: {},
    });
    expect(commandToZcl({ capability: "brightness", action: "set", level: 100 }, null)).toEqual({
      cluster: "genLevelCtrl",
      command: "moveToLevelWithOnOff",
      payload: { level: 254, transtime: 0 },
    });
  });
  it("maps ZCL clusters to capabilities", () => {
    expect(capabilitiesFromZclClusters(["genOnOff", "genLevelCtrl", "lightingColorCtrl"])).toEqual([
      "onoff",
      "brightness",
      "color",
    ]);
  });
});

describe("ZigbeeProtocolDriver (fake coordinator)", () => {
  it("sends ZCL commands and normalizes attribute reports", async () => {
    const radio = new FakeCoordinator();
    const driver = new ZigbeeProtocolDriver({ createController: async () => radio });
    await driver.connect();
    expect(radio.started).toBe(true);

    const dev = "device-zb-lamp" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "onoff", address: "0x00124b001f8d2c3e/1" });

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));

    await driver.command(dev, { capability: "onoff", action: "on" });
    expect(radio.sent).toHaveLength(1);
    expect(radio.sent[0]).toMatchObject({
      addr: { ieeeAddr: "0x00124b001f8d2c3e", endpoint: 1 },
      cluster: "genOnOff",
      command: "on",
    });

    // Device reports its on/off attribute → normalized + emitted.
    radio.report({ ieeeAddr: "0x00124b001f8d2c3e", endpoint: 1, cluster: "genOnOff", data: { onOff: 1 } });
    expect(events.at(-1)?.state).toEqual({ kind: "onoff", on: true });
    expect(driver.getState(dev, "onoff")).toEqual({ kind: "onoff", on: true });

    // A report from another device is ignored.
    const before = events.length;
    radio.report({ ieeeAddr: "0xother", endpoint: 1, cluster: "genOnOff", data: { onOff: 0 } });
    expect(events.length).toBe(before);
  });

  it("discovers paired devices and maps their clusters", async () => {
    const radio = new FakeCoordinator();
    const driver = new ZigbeeProtocolDriver({ createController: async () => radio });
    await driver.connect();
    const found = await driver.discover();
    expect(found).toHaveLength(1);
    expect(found[0]?.backendId).toBe("0x00124b001f8d2c3e/1");
    expect(found[0]?.capabilities).toEqual(["onoff", "brightness"]);
  });
});
