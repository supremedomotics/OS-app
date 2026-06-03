import { newId, type Grant, type GrantId, type User, type UserId, type HomeId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "./policy.js";

const engine = new PolicyEngine();

function user(overrides: Partial<User> = {}): User {
  return {
    id: newId("user") as UserId,
    homeId: newId("home") as HomeId,
    email: "u@example.com",
    phone: null,
    displayName: "U",
    userType: "guest",
    status: "active",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    ...overrides,
  };
}

describe("RBAC baseline", () => {
  it("master can admin users; guest cannot", () => {
    const m = user({ userType: "master" });
    const g = user({ userType: "guest" });
    expect(engine.decide({ user: m, resourceType: "user", resourceId: null, action: "admin" }, []).allowed).toBe(true);
    expect(engine.decide({ user: g, resourceType: "user", resourceId: null, action: "admin" }, []).allowed).toBe(false);
  });

  it("guest can control a device by baseline", () => {
    const g = user({ userType: "guest" });
    expect(engine.decide({ user: g, resourceType: "device", resourceId: "dev_x", action: "control" }, []).allowed).toBe(true);
  });
});

describe("ABAC grants", () => {
  it("deny overrides baseline", () => {
    const g = user({ userType: "family" });
    const grant: Grant = {
      id: newId("grant") as GrantId,
      userId: g.id,
      resourceType: "device",
      resourceId: "dev_locked",
      action: "control",
      effect: "deny",
      validFrom: null,
      validUntil: null,
      schedule: null,
    };
    expect(engine.decide({ user: g, resourceType: "device", resourceId: "dev_locked", action: "control" }, [grant]).allowed).toBe(false);
  });

  it("expired grant does not apply", () => {
    const g = user({ userType: "guest" });
    const grant: Grant = {
      id: newId("grant") as GrantId,
      userId: g.id,
      resourceType: "scene",
      resourceId: null,
      action: "create",
      effect: "allow",
      validFrom: null,
      validUntil: new Date(Date.now() - 1000).toISOString(),
      schedule: null,
    };
    // guest has no baseline scene:create, and the allow grant is expired
    expect(engine.decide({ user: g, resourceType: "scene", resourceId: null, action: "create" }, [grant]).allowed).toBe(false);
  });

  it("time-window grant allows only inside the window", () => {
    const g = user({ userType: "guest" });
    const monday9to5: Grant = {
      id: newId("grant") as GrantId,
      userId: g.id,
      resourceType: "device",
      resourceId: null,
      action: "update",
      effect: "allow",
      validFrom: null,
      validUntil: null,
      schedule: [{ days: [1], start: "09:00", end: "17:00" }],
    };
    const insideMonday = new Date("2026-06-01T12:00:00"); // Monday
    const sunday = new Date("2026-05-31T12:00:00");
    expect(engine.decide({ user: g, resourceType: "device", resourceId: "dev_a", action: "update", now: insideMonday }, [monday9to5]).allowed).toBe(true);
    expect(engine.decide({ user: g, resourceType: "device", resourceId: "dev_a", action: "update", now: sunday }, [monday9to5]).allowed).toBe(false);
  });

  it("expired user is denied everything", () => {
    const g = user({ userType: "master", expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(engine.decide({ user: g, resourceType: "home", resourceId: null, action: "view" }, []).allowed).toBe(false);
  });
});
