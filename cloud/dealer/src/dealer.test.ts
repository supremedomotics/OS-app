import { describe, expect, it } from "vitest";
import { DealerError, DealerService, InMemoryDealerStore } from "./index.js";

function svc(nowRef = { t: 1_750_000_000_000 }) {
  return new DealerService({ store: new InMemoryDealerStore(), now: () => nowRef.t });
}

describe("DealerService — orgs, technicians, sites", () => {
  it("creates an org with its creator as owner technician", () => {
    const d = svc();
    const org = d.createOrg("Acme AV", "owner-1");
    expect(d.isTechnician(org.id, "owner-1")).toBe(true);
    expect(d.technicians(org.id)[0]!.role).toBe("owner");
  });

  it("adds technicians and creates sites with hub assignment", () => {
    const d = svc();
    const org = d.createOrg("Acme AV", "owner-1");
    d.addTechnician(org.id, "tech-2");
    expect(d.isTechnician(org.id, "tech-2")).toBe(true);

    const site = d.createSite(org.id, "Mumbai Villa", "customer-9");
    d.assignHub(site.id, "hub-abc");
    expect(d.sites(org.id)[0]!.hubIds).toContain("hub-abc");
  });

  it("rejects sites/techs for an unknown org", () => {
    const d = svc();
    expect(() => d.createSite("nope", "X")).toThrow(DealerError);
    expect(() => d.addTechnician("nope", "t")).toThrow(/org not found/);
  });
});

describe("DealerService — time-boxed remote service", () => {
  it("grants active access within the window and denies after expiry", () => {
    const nowRef = { t: 1_750_000_000_000 };
    const d = svc(nowRef);
    const grant = d.grantRemoteService({ hubId: "hub-1", technicianAccountId: "tech-2", grantedByAccountId: "owner-9", durationMs: 1000 });
    expect(d.hasActiveServiceGrant("hub-1", "tech-2")).toBe(true);
    expect(grant.grantedByAccountId).toBe("owner-9");

    nowRef.t += 1001; // past expiry
    expect(d.hasActiveServiceGrant("hub-1", "tech-2")).toBe(false);
  });

  it("revokes an active grant immediately", () => {
    const d = svc();
    const grant = d.grantRemoteService({ hubId: "hub-1", technicianAccountId: "tech-2", grantedByAccountId: "owner-9" });
    expect(d.hasActiveServiceGrant("hub-1", "tech-2")).toBe(true);
    d.revokeRemoteService(grant.id, "hub-1");
    expect(d.hasActiveServiceGrant("hub-1", "tech-2")).toBe(false);
  });

  it("does not grant standing access to other technicians", () => {
    const d = svc();
    d.grantRemoteService({ hubId: "hub-1", technicianAccountId: "tech-2", grantedByAccountId: "owner-9" });
    expect(d.hasActiveServiceGrant("hub-1", "tech-other")).toBe(false);
  });
});
