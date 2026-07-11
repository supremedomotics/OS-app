import {
  newId,
  type Action,
  type HomeId,
  type ResourceType,
  type User,
  type UserId,
  type UserType,
} from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { BASELINE_ROLES, baselineAllows } from "./roles.js";
import { PolicyEngine } from "./policy.js";

/**
 * Authorization matrix (production-readiness §1). Locks down the RBAC baseline so a
 * future change can't silently grant privilege. Verifies the policy engine's
 * baseline decisions match BASELINE_ROLES across every user-type × resource ×
 * action, and pins critical privilege-escalation negatives.
 */
const engine = new PolicyEngine();
const USER_TYPES: UserType[] = ["master", "admin", "family", "child", "guest", "staff", "installer", "developer"];
const RESOURCES: ResourceType[] = ["room", "device", "scene", "automation", "camera", "integration", "user", "home"];
const ACTIONS: Action[] = ["view", "control", "create", "update", "delete", "admin"];

function user(userType: UserType): User {
  return {
    id: newId("user") as UserId,
    homeId: newId("home") as HomeId,
    email: "u@example.com",
    phone: null,
    displayName: "U",
    userType,
    status: "active",
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
}

describe("Authorization matrix — baseline RBAC", () => {
  it("engine baseline decisions match BASELINE_ROLES for every combination", () => {
    for (const ut of USER_TYPES) {
      const u = user(ut);
      for (const resource of RESOURCES) {
        for (const action of ACTIONS) {
          const expected = baselineAllows(ut, resource, action);
          const decided = engine.decide({ user: u, resourceType: resource, resourceId: null, action }, []).allowed;
          expect(decided, `${ut} ${action} ${resource}`).toBe(expected);
        }
      }
    }
  });

  it("baseline never grants an action a role doesn't list", () => {
    for (const ut of USER_TYPES) {
      const policy = BASELINE_ROLES[ut];
      for (const resource of RESOURCES) {
        const allowed = policy[resource] ?? [];
        for (const action of ACTIONS) {
          expect(baselineAllows(ut, resource, action)).toBe(allowed.includes(action));
        }
      }
    }
  });

  it("pins critical privilege-escalation negatives", () => {
    const deny = (ut: UserType, resource: ResourceType, action: Action) =>
      expect(engine.decide({ user: user(ut), resourceType: resource, resourceId: null, action }, []).allowed, `${ut} !${action} ${resource}`).toBe(false);

    // Non-admins cannot administer users or the home.
    for (const ut of ["family", "child", "guest", "staff", "installer", "developer"] as UserType[]) {
      deny(ut, "user", "admin");
      deny(ut, "user", "create");
      deny(ut, "home", "admin");
    }
    // Guests/children/staff cannot create or delete automations or scenes' deletion.
    deny("guest", "automation", "create");
    deny("child", "automation", "control");
    deny("staff", "scene", "delete");
    // Installers manage integrations but are not user admins.
    deny("installer", "user", "admin");
    // Developers get full build/debug access but are not user admins either.
    deny("developer", "user", "admin");
  });

  it("confirms the intended positives for each tier", () => {
    const allow = (ut: UserType, resource: ResourceType, action: Action) =>
      expect(engine.decide({ user: user(ut), resourceType: resource, resourceId: null, action }, []).allowed).toBe(true);

    allow("master", "user", "admin");
    allow("admin", "device", "delete");
    allow("installer", "integration", "admin");
    allow("developer", "integration", "admin");
    allow("family", "scene", "create");
    allow("guest", "device", "control");
    allow("child", "room", "view");
  });
});
