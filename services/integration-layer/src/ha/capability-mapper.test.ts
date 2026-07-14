import { describe, expect, it } from "vitest";
import { commandToHaService } from "./capability-mapper.js";

/**
 * BUG-010: HA entity_ids are contractually lowercase. An onoff command built from a
 * backend id that reached the SIL with its original casing intact (e.g. CoolMaster's own
 * "L1.104" UID format) must still target the lowercase HA domain, or the real service
 * ("l1.turn_off") 404s as "child_service_not_found" against the wrong-cased one.
 */
describe("commandToHaService — onoff domain casing", () => {
  it("lowercases an uppercase-prefixed entity id's domain", () => {
    const call = commandToHaService("L1.104", { capability: "onoff", action: "off" });
    expect(call.domain).toBe("l1");
    expect(call.service).toBe("turn_off");
  });

  it("leaves an already-lowercase domain unchanged", () => {
    const call = commandToHaService("switch.kitchen", { capability: "onoff", action: "on" });
    expect(call.domain).toBe("switch");
    expect(call.service).toBe("turn_on");
  });
});
