import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { describe, expect, it } from "vitest";
import {
  MatterProtocolDriver,
  type MatterAddress,
  type MatterAttributeReport,
  type MatterController,
  type MatterNodeInfo,
} from "./matter-driver.js";
import { invocationFromCommand, capabilitiesFromClusters } from "./matter-codec.js";
import type { MatterOnboardingPayload } from "./matter-pairing.js";

/** A fake Matter fabric: records invokes, replays attribute reports, lists nodes. */
class FakeFabric implements MatterController {
  readonly invokes: Array<{ addr: MatterAddress; cluster: string; command: string; fields: Record<string, unknown> }> = [];
  private readonly subs = new Map<string, (r: MatterAttributeReport) => void>();
  connected = false;
  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  async invoke(addr: MatterAddress, cluster: string, command: string, fields: Record<string, unknown>) {
    this.invokes.push({ addr, cluster, command, fields });
  }
  subscribe(addr: MatterAddress, handler: (r: MatterAttributeReport) => void) {
    const key = `${addr.nodeId}/${addr.endpoint}`;
    this.subs.set(key, handler);
    return () => {
      if (this.subs.get(key) === handler) this.subs.delete(key);
    };
  }
  async nodes(): Promise<MatterNodeInfo[]> {
    return [
      { nodeId: "5", endpoint: 1, clusters: ["OnOff", "LevelControl"], vendor: "Acme", product: "Dimmable Bulb" },
      { nodeId: "6", endpoint: 1, clusters: ["Descriptor"] }, // no Supreme capability mapping
    ];
  }
  commissioned: MatterOnboardingPayload[] = [];
  async commission(payload: MatterOnboardingPayload): Promise<MatterNodeInfo> {
    this.commissioned.push(payload);
    return { nodeId: "9", endpoint: 1, clusters: ["OnOff"], vendor: "Acme", product: "Smart Plug" };
  }
  report(addr: string, report: MatterAttributeReport) {
    this.subs.get(addr)?.(report);
  }
}

describe("Matter codec", () => {
  it("maps commands to cluster invocations", () => {
    expect(invocationFromCommand({ capability: "onoff", action: "on" }, null)).toEqual({
      cluster: "OnOff",
      command: "On",
      fields: {},
    });
    const dim = invocationFromCommand({ capability: "brightness", action: "set", level: 100 }, null);
    expect(dim).toEqual({ cluster: "LevelControl", command: "MoveToLevel", fields: { level: 254, transitionTime: 0 } });
  });
  it("maps endpoint clusters to capabilities", () => {
    expect(capabilitiesFromClusters(["OnOff", "LevelControl", "ColorControl"])).toEqual([
      "onoff",
      "brightness",
      "color",
    ]);
  });
});

describe("MatterProtocolDriver (fake fabric)", () => {
  it("invokes clusters for commands and normalizes attribute reports", async () => {
    const fabric = new FakeFabric();
    const driver = new MatterProtocolDriver({ createController: async () => fabric });
    await driver.connect();
    expect(fabric.connected).toBe(true);

    const dev = "device-matter-bulb" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "brightness", address: "5/1" });

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));

    await driver.command(dev, { capability: "brightness", action: "set", level: 50 });
    expect(fabric.invokes).toHaveLength(1);
    expect(fabric.invokes[0]).toMatchObject({
      addr: { nodeId: "5", endpoint: 1 },
      cluster: "LevelControl",
      command: "MoveToLevel",
    });
    expect(fabric.invokes[0]?.fields.level).toBe(127); // 50% → 127/254

    // The bulb reports its level → normalized to a Supreme brightness state.
    fabric.report("5/1", { cluster: "LevelControl", attribute: "CurrentLevel", value: 254 });
    expect(events.at(-1)?.state).toEqual({ kind: "brightness", on: true, level: 100 });
    expect(driver.getState(dev, "brightness")).toEqual({ kind: "brightness", on: true, level: 100 });
  });

  it("discovers commissioned nodes and maps their clusters", async () => {
    const fabric = new FakeFabric();
    const driver = new MatterProtocolDriver({ createController: async () => fabric });
    await driver.connect();
    const found = await driver.discover();
    expect(found).toHaveLength(2);
    expect(found[0]?.backendId).toBe("5/1");
    expect(found[0]?.capabilities).toEqual(["onoff", "brightness"]);
  });

  it("§ Correctness Fix — never silently drops a node whose clusters map to zero capabilities; discloses why instead", async () => {
    const fabric = new FakeFabric();
    const logs: { level: string; message: string }[] = [];
    const driver = new MatterProtocolDriver({
      createController: async () => fabric,
      onLog: (level, message) => logs.push({ level, message }),
    });
    await driver.connect();
    const found = await driver.discover();

    const unmapped = found.find((d) => d.backendId === "6/1");
    expect(unmapped).toBeDefined();
    expect(unmapped?.capabilities).toEqual([]);
    expect(unmapped?.raw.unmappedClusters).toEqual(["Descriptor"]);

    // The gap is observable, not silent.
    expect(logs).toContainEqual({
      level: "warn",
      message: "matter: node 6/1 exposes no Supreme-mapped capability — clusters: Descriptor",
    });
  });

  it("commissions a node from a setup code and emits the onCommissioned event", async () => {
    const fabric = new FakeFabric();
    const driver = new MatterProtocolDriver({ createController: async () => fabric });
    await driver.connect();

    const commissioned: MatterNodeInfo[] = [];
    driver.onCommissioned((n) => commissioned.push(n));

    const device = await driver.commission("3497-011-2332"); // canonical manual code
    expect(fabric.commissioned[0]?.passcode).toBe(20202021);
    expect(device.backendId).toBe("9/1");
    expect(device.capabilities).toEqual(["onoff"]);
    expect(commissioned).toHaveLength(1);
    expect(commissioned[0]?.product).toBe("Smart Plug");
  });

  it("refuses to commission when not connected", async () => {
    const driver = new MatterProtocolDriver({ createController: async () => new FakeFabric() });
    await expect(driver.commission("3497-011-2332")).rejects.toThrow(/not connected/);
  });
});
