import { newId, type HomeId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { FleetService } from "./index.js";

describe("FleetService", () => {
  it("registers hubs per org and lists them with status", async () => {
    let clock = 1_000_000;
    const fleet = new FleetService({ offlineAfterMs: 90_000, now: () => clock });

    const a = await fleet.register({ orgId: "org_acme", homeId: newId("home") as HomeId, name: "Penthouse", version: "0.3.0" });
    await fleet.register({ orgId: "org_acme", homeId: newId("home") as HomeId, name: "Villa", version: "0.3.0" });
    await fleet.register({ orgId: "org_other", homeId: newId("home") as HomeId, name: "Other", version: "0.3.0" });

    const acme = await fleet.listForOrg("org_acme");
    expect(acme).toHaveLength(2);
    expect(acme.every((h) => h.status === "online")).toBe(true);

    // Advance past the offline window without a heartbeat → hub goes offline.
    clock += 120_000;
    const stale = await fleet.listForOrg("org_acme");
    expect(stale.every((h) => h.status === "offline")).toBe(true);

    // A heartbeat brings it back online.
    await fleet.heartbeat(a.id, "0.3.1");
    const refreshed = (await fleet.listForOrg("org_acme")).find((h) => h.id === a.id)!;
    expect(refreshed.status).toBe("online");
    expect(refreshed.version).toBe("0.3.1");
  });

  it("isolates tenants by org", async () => {
    const fleet = new FleetService();
    await fleet.register({ orgId: "org_a", homeId: newId("home") as HomeId, name: "H", version: "0.3.0" });
    expect(await fleet.listForOrg("org_b")).toHaveLength(0);
  });
});
