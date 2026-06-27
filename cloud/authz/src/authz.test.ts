import { describe, expect, it } from "vitest";
import { decide, roleLevel, type Grant } from "./index.js";

const T0 = 1_750_000_000_000;

describe("AuthZ — baseline RBAC matrix", () => {
  it("owner can manage everything", () => {
    expect(decide({ membership: { role: "owner" }, domain: "security", action: "manage" }).allow).toBe(true);
    expect(decide({ membership: { role: "owner" }, domain: "firmware", action: "manage" }).allow).toBe(true);
  });

  it("guest cannot touch security or automation", () => {
    expect(decide({ membership: { role: "guest" }, domain: "security", action: "view" }).allow).toBe(false);
    expect(decide({ membership: { role: "guest" }, domain: "automation", action: "control" }).allow).toBe(false);
    // …but can control a permitted device (scoped).
    expect(decide({ membership: { role: "guest" }, domain: "devices", action: "control" }).allow).toBe(true);
  });

  it("installer owns commissioning/firmware but not security", () => {
    expect(decide({ membership: { role: "installer" }, domain: "installer_portal", action: "manage" }).allow).toBe(true);
    expect(decide({ membership: { role: "installer" }, domain: "firmware", action: "manage" }).allow).toBe(true);
    expect(decide({ membership: { role: "installer" }, domain: "security", action: "view" }).allow).toBe(false);
  });

  it("a scoped role cannot perform a manage action (needs full)", () => {
    expect(decide({ membership: { role: "family" }, domain: "devices", action: "control" }).allow).toBe(true);
    expect(decide({ membership: { role: "family" }, domain: "devices", action: "manage" }).allow).toBe(false);
  });

  it("exposes role levels for UI affordances", () => {
    expect(roleLevel("owner", "security")).toBe("full");
    expect(roleLevel("guest", "security")).toBe("none");
    expect(roleLevel("homeowner", "cameras")).toBe("scoped");
  });
});

describe("AuthZ — membership time windows", () => {
  it("denies an expired (time-boxed) membership", () => {
    const m = { role: "service" as const, validUntil: T0 };
    expect(decide({ membership: m, domain: "diagnostics", action: "view", now: T0 - 1 }).allow).toBe(true);
    expect(decide({ membership: m, domain: "diagnostics", action: "view", now: T0 + 1 }).allow).toBe(false);
  });

  it("denies a not-yet-active membership", () => {
    const m = { role: "guest" as const, validFrom: T0 };
    expect(decide({ membership: m, domain: "devices", action: "control", now: T0 - 1 }).allow).toBe(false);
  });
});

describe("AuthZ — ABAC grant overlay", () => {
  it("an allow grant lifts a guest above the baseline for a specific resource", () => {
    const grants: Grant[] = [{ domain: "cameras", resourceId: "cam-front", action: "view", effect: "allow" }];
    expect(decide({ membership: { role: "guest" }, domain: "cameras", action: "view", resourceId: "cam-front", grants }).allow).toBe(true);
    // A different camera is still denied (grant is resource-scoped).
    expect(decide({ membership: { role: "guest" }, domain: "cameras", action: "view", resourceId: "cam-back", grants }).allow).toBe(false);
  });

  it("a deny grant overrides the baseline (deny wins)", () => {
    const grants: Grant[] = [{ domain: "devices", resourceId: "lock-front", action: "control", effect: "deny" }];
    expect(decide({ membership: { role: "homeowner" }, domain: "devices", action: "control", resourceId: "lock-front", grants }).allow).toBe(false);
  });

  it("ignores an expired grant", () => {
    const grants: Grant[] = [{ domain: "security", action: "control", effect: "allow", validUntil: T0 }];
    expect(decide({ membership: { role: "guest" }, domain: "security", action: "control", grants, now: T0 + 1 }).allow).toBe(false);
  });
});
