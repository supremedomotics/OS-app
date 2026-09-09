import { describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { KeypadMapping } from "./keypad-mapping.js";

/**
 * § Universal Keypad Framework, Stage 5A-3 — Capability Compatibility Validation.
 * Proves `KeypadMapping`'s schema rejects a behavior/target capability combination
 * `resolveBehaviorCommand` (`@supreme/keypad-framework`'s behavior.ts) would otherwise
 * only discover on first firing, using the SAME `TOGGLE_CAPABLE_CAPABILITIES`/
 * `LEVEL_STEP_CAPABLE_CAPABILITIES` sets that module enforces at execution time.
 */
const base = () => ({
  id: newId("keypadMapping") as never,
  homeId: newId("home") as never,
  name: "Test mapping",
  input: { keypadId: newId("device") as never, control: "1", event: "short_press" as const },
});

describe("KeypadMapping — capability compatibility validation (Stage 5A-3)", () => {
  it("accepts every documented valid behavior/capability combination", () => {
    for (const capability of ["onoff", "brightness", "fan", "lock", "vacuum"] as const) {
      const result = KeypadMapping.safeParse({
        ...base(),
        behavior: "toggle",
        target: { deviceId: newId("device"), capability, step: 10 },
      });
      expect(result.success, `toggle + ${capability} should be valid`).toBe(true);
    }
    for (const capability of ["brightness", "position"] as const) {
      for (const behavior of ["alternate", "increment", "decrement"] as const) {
        const result = KeypadMapping.safeParse({
          ...base(),
          behavior,
          target: { deviceId: newId("device"), capability, step: 10 },
        });
        expect(result.success, `${behavior} + ${capability} should be valid`).toBe(true);
      }
    }
  });

  it("rejects toggle against a capability with no on/off-shaped state (e.g. temperature, color)", () => {
    for (const capability of ["temperature", "color", "media", "position", "sensor"] as const) {
      const result = KeypadMapping.safeParse({
        ...base(),
        behavior: "toggle",
        target: { deviceId: newId("device"), capability, step: 10 },
      });
      expect(result.success, `toggle + ${capability} should be rejected`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.join(".") === "target.capability")).toBe(true);
      }
    }
  });

  it("rejects increment/decrement/alternate against a non-steppable capability (e.g. onoff, lock)", () => {
    for (const behavior of ["increment", "decrement", "alternate"] as const) {
      for (const capability of ["onoff", "lock", "media", "color"] as const) {
        const result = KeypadMapping.safeParse({
          ...base(),
          behavior,
          target: { deviceId: newId("device"), capability, step: 10 },
        });
        expect(result.success, `${behavior} + ${capability} should be rejected`).toBe(false);
      }
    }
  });

  it("cycle has no capability constraint — it walks actions[], never resolves a synthesized command against target.capability", () => {
    const result = KeypadMapping.safeParse({
      ...base(),
      behavior: "cycle",
      target: { deviceId: newId("device"), capability: "media", step: 10 },
      actions: [{ type: "device_command", deviceId: newId("device"), command: { capability: "media", action: "play" } }],
    });
    expect(result.success).toBe(true);
  });

  it("legacy direct mappings (no behavior/target keys at all) are completely unaffected by the new validation", () => {
    const result = KeypadMapping.safeParse({
      ...base(),
      actions: [{ type: "device_command", deviceId: newId("device"), command: { capability: "onoff", action: "on" } }],
    });
    expect(result.success).toBe(true);
  });

  it("is protocol-independent — validation is keyed purely on CapabilityKind, never a brand/driver field", () => {
    const result = KeypadMapping.safeParse({
      ...base(),
      behavior: "toggle",
      target: { deviceId: newId("device"), capability: "onoff", step: 10 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.target ?? {})).not.toContain("protocol");
    }
  });
});
