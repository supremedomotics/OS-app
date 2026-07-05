import { describe, expect, it } from "vitest";
import { MatterCloudService, InMemoryMatterStore } from "./index.js";

function svc() {
  return new MatterCloudService({ store: new InMemoryMatterStore(), now: () => 1_750_000_000_000 });
}

describe("MatterCloudService", () => {
  it("creates a fabric with the Supreme hub as founding admin", () => {
    const m = svc();
    const fabric = m.createFabric("home-1");
    expect(fabric.homeId).toBe("home-1");
    expect(fabric.rootRef).toContain("rcac-");
    const admins = m.admins(fabric.fabricId);
    expect(admins).toHaveLength(1);
    expect(admins[0]!.label).toBe("Supreme Hub");
  });

  it("supports multi-admin (share the fabric with Apple Home + Google)", () => {
    const m = svc();
    const fabric = m.createFabric("home-1");
    m.addAdmin(fabric.fabricId, "0xA", "Apple Home");
    m.addAdmin(fabric.fabricId, "0xG", "Google");
    expect(m.admins(fabric.fabricId).map((a) => a.label)).toEqual(["Supreme Hub", "Apple Home", "Google"]);
  });

  it("commissions nodes into the fabric with operational credentials", () => {
    const m = svc();
    const fabric = m.createFabric("home-1");
    m.commissionNode({ fabricId: fabric.fabricId, nodeId: "0x100", vendorId: 0x1234, productId: 0x1 });
    m.commissionNode({ fabricId: fabric.fabricId, nodeId: "0x101", vendorId: 0x1234, productId: 0x2 });
    const nodes = m.nodes(fabric.fabricId);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.nocRef).toContain("noc-");
  });

  it("lists fabrics per home", () => {
    const m = svc();
    m.createFabric("home-1");
    m.createFabric("home-1");
    m.createFabric("home-2");
    expect(m.fabricsForHome("home-1")).toHaveLength(2);
    expect(m.fabricsForHome("home-2")).toHaveLength(1);
  });
});
