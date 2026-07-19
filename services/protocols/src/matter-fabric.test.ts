import { describe, expect, it } from "vitest";
import {
  MatterFabricManager,
  type MatterFabricSync,
} from "./matter-fabric.js";
import { MatterProtocolDriver, type MatterAddress, type MatterAttributeReport, type MatterController, type MatterNodeInfo } from "./matter-driver.js";
import type { MatterOnboardingPayload } from "./matter-pairing.js";

/** A fake fabric controller that commissions a fixed node. */
class FakeController implements MatterController {
  async connect() {}
  async disconnect() {}
  async invoke(_a: MatterAddress, _c: string, _cmd: string, _f: Record<string, unknown>) {}
  subscribe(_a: MatterAddress, _h: (r: MatterAttributeReport) => void) {
    return () => {};
  }
  async nodes(): Promise<MatterNodeInfo[]> {
    return [];
  }
  async commission(_p: MatterOnboardingPayload): Promise<MatterNodeInfo> {
    return { nodeId: "42", endpoint: 1, clusters: ["OnOff"], vendor: "Acme", product: "Plug" };
  }
}

class FakeSync implements MatterFabricSync {
  ensured: string[] = [];
  nodes: { fabricId: string; nodeId: string }[] = [];
  failEnsure = false;
  failRecord = false;
  async ensureFabric(homeId: string) {
    if (this.failEnsure) throw new Error("cloud down");
    this.ensured.push(homeId);
    return { fabricId: "0xFAB1" };
  }
  async recordNode(fabricId: string, node: { nodeId: string }) {
    if (this.failRecord) throw new Error("cloud down");
    this.nodes.push({ fabricId, nodeId: node.nodeId });
  }
}

describe("MatterFabricManager", () => {
  it("ensures a fabric on start and mirrors commissioned nodes to the cloud", async () => {
    const driver = new MatterProtocolDriver({ createController: async () => new FakeController() });
    await driver.connect();
    const sync = new FakeSync();
    const mgr = new MatterFabricManager({ driver, homeId: "home-1", sync });
    await mgr.start();
    expect(sync.ensured).toEqual(["home-1"]);
    expect(mgr.currentFabricId).toBe("0xFAB1");

    await driver.commission("3497-011-2332");
    expect(sync.nodes).toEqual([{ fabricId: "0xFAB1", nodeId: "42" }]);
    mgr.stop();
  });

  it("keeps commissioning working when the cloud is unreachable (local-only, non-fatal)", async () => {
    const driver = new MatterProtocolDriver({ createController: async () => new FakeController() });
    await driver.connect();
    const sync = new FakeSync();
    sync.failEnsure = true;
    const mgr = new MatterFabricManager({ driver, homeId: "home-1", sync });
    await mgr.start();
    expect(mgr.currentFabricId).toBeNull();
    // Commissioning still succeeds locally even though the fabric never synced.
    const device = await driver.commission("3497-011-2332");
    expect(device.backendId).toBe("42/1");
    expect(sync.nodes).toEqual([]);
    mgr.stop();
  });

  it("runs fully local with no sync configured", async () => {
    const driver = new MatterProtocolDriver({ createController: async () => new FakeController() });
    await driver.connect();
    const mgr = new MatterFabricManager({ driver, homeId: "home-1" });
    await mgr.start();
    await expect(driver.commission("3497-011-2332")).resolves.toBeDefined();
    mgr.stop();
  });
});
