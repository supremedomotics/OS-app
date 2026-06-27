import { describe, expect, it } from "vitest";
import { AdminService } from "./index.js";

describe("AdminService — feature flags", () => {
  it("toggles flags and respects full/zero rollout", () => {
    const a = new AdminService();
    a.setFlag("new_ui", true, 100);
    expect(a.isEnabled("new_ui", "acct-1")).toBe(true);
    a.setFlag("new_ui", false);
    expect(a.isEnabled("new_ui", "acct-1")).toBe(false);
    a.setFlag("beta", true, 0);
    expect(a.isEnabled("beta", "acct-1")).toBe(false);
  });

  it("a partial rollout is deterministic and roughly proportional", () => {
    const a = new AdminService();
    a.setFlag("gradual", true, 30);
    const subjects = Array.from({ length: 1000 }, (_, i) => `s${i}`);
    const on = subjects.filter((s) => a.isEnabled("gradual", s));
    expect(on.length).toBeGreaterThan(200);
    expect(on.length).toBeLessThan(400);
    expect(a.isEnabled("gradual", on[0]!)).toBe(true); // stable
  });

  it("an unknown flag is disabled", () => {
    expect(new AdminService().isEnabled("missing")).toBe(false);
  });
});

describe("AdminService — audited impersonation", () => {
  it("starts a time-boxed impersonation and emits an audit record", () => {
    const ref = { t: 1_750_000_000_000 };
    const a = new AdminService({ now: () => ref.t, impersonationTtlMs: 1000 });
    const { grant, audit } = a.startImpersonation({ adminAccountId: "admin-1", targetAccountId: "user-9", reason: "support ticket #42" });
    expect(a.isImpersonationActive(grant.id)).toBe(true);
    expect(audit.action).toBe("admin.impersonation.start");
    expect(audit.metadata.reason).toBe("support ticket #42");

    ref.t += 1001; // expire
    expect(a.isImpersonationActive(grant.id)).toBe(false);
  });

  it("requires a justification", () => {
    const a = new AdminService();
    expect(() => a.startImpersonation({ adminAccountId: "admin-1", targetAccountId: "u", reason: "" })).toThrow(/justification/);
  });

  it("can be ended early", () => {
    const a = new AdminService();
    const { grant } = a.startImpersonation({ adminAccountId: "admin-1", targetAccountId: "u", reason: "x" });
    a.endImpersonation(grant.id);
    expect(a.isImpersonationActive(grant.id)).toBe(false);
  });
});
