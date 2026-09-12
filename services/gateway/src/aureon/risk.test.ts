import { describe, expect, it } from "vitest";
import type { ProposedCommand } from "@supreme/ai";
import { classifyCommand, maxRisk } from "./risk.js";

function cmd(command: ProposedCommand["command"]): ProposedCommand {
  return { deviceId: "dev_x", deviceName: "x", command };
}

describe("Aureon risk classification", () => {
  it("classifies lock actions as HIGH_RISK (3) regardless of direction", () => {
    expect(classifyCommand({ capability: "lock", action: "unlock" })).toBe(3);
    expect(classifyCommand({ capability: "lock", action: "lock" })).toBe(3);
  });

  it("classifies position (covers/gates) as MODERATE (2)", () => {
    expect(classifyCommand({ capability: "position", action: "open" })).toBe(2);
  });

  it("classifies lighting/HVAC/media as LOW_RISK (1)", () => {
    expect(classifyCommand({ capability: "onoff", action: "on" })).toBe(1);
    expect(classifyCommand({ capability: "brightness", action: "set", level: 50 })).toBe(1);
    expect(classifyCommand({ capability: "temperature", targetC: 22 })).toBe(1);
  });

  it("maxRisk takes the highest tier across a mixed plan", () => {
    const plan = [
      cmd({ capability: "onoff", action: "on" }),
      cmd({ capability: "lock", action: "unlock" }),
      cmd({ capability: "position", action: "close" }),
    ];
    expect(maxRisk(plan)).toBe(3);
  });

  it("maxRisk of an all-lighting plan stays LOW_RISK", () => {
    const plan = [cmd({ capability: "onoff", action: "off" }), cmd({ capability: "brightness", action: "off" })];
    expect(maxRisk(plan)).toBe(1);
  });
});
