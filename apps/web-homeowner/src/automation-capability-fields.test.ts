import { describe, expect, it } from "vitest";
import {
  COMMAND_DEFINITIONS,
  READONLY_CAPABILITIES,
  STATE_FIELDS,
  commandableCapabilities,
  resolveCommandDefinitions,
  resolveStateFields,
  type NarrowingContext,
} from "./automation-capability-fields.js";

/**
 * § ADR 0100 Production Hardening — regression coverage for the Automation Editor's field
 * resolution chain (tier order: driver command metadata → capability structural config →
 * live-state inference → static table). `resolveNarrowingContext()` in `automations.tsx` is
 * what actually COMPUTES tiers 2–3 from a real `Device`; this file tests the pure resolver
 * functions those results feed into, plus the static tables themselves, so a change to tier
 * priority or a capability's field list can't silently regress.
 */

describe("resolveStateFields / resolveCommandDefinitions — tier 4 (static table fallback)", () => {
  it("with no context, returns the capability's full static surface unmodified", () => {
    expect(resolveStateFields("onoff")).toEqual(STATE_FIELDS.onoff);
    expect(resolveCommandDefinitions("lock")).toEqual(COMMAND_DEFINITIONS.lock);
  });

  it("every non-color capability ignores modes/kelvinRange entirely (only color is narrowable today)", () => {
    const ctx: NarrowingContext = { modes: { rgb: false, cct: false }, kelvinRange: { min: 1, max: 2 } };
    expect(resolveStateFields("brightness", ctx)).toEqual(STATE_FIELDS.brightness);
    expect(resolveCommandDefinitions("fan", ctx)).toEqual(COMMAND_DEFINITIONS.fan);
  });
});

describe("resolveStateFields / resolveCommandDefinitions — tier 2 (capability structural config)", () => {
  it("RGB-only (modes.cct=false) drops kelvin from both state fields and the color command", () => {
    const ctx: NarrowingContext = { modes: { rgb: true, cct: false } };
    expect(resolveStateFields("color", ctx).map((f) => f.key)).not.toContain("kelvin");
    expect(resolveCommandDefinitions("color", ctx)[0]!.params.map((p) => p.key)).not.toContain("kelvin");
  });

  it("CCT-only (modes.rgb=false) drops hue AND saturation — never one without the other", () => {
    const ctx: NarrowingContext = { modes: { rgb: false, cct: true } };
    const keys = resolveStateFields("color", ctx).map((f) => f.key);
    expect(keys).not.toContain("hue");
    expect(keys).not.toContain("saturation");
    expect(keys).toContain("kelvin");
    const paramKeys = resolveCommandDefinitions("color", ctx)[0]!.params.map((p) => p.key);
    expect(paramKeys).not.toContain("hue");
    expect(paramKeys).not.toContain("saturation");
  });

  it("RGB+CCT keeps every color field", () => {
    const ctx: NarrowingContext = { modes: { rgb: true, cct: true } };
    const keys = resolveStateFields("color", ctx).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["hue", "saturation", "kelvin"]));
  });

  it("no modes at all (driver hasn't adopted structural reporting) shows the full surface — the documented safe default, never a narrowed guess", () => {
    expect(resolveStateFields("color").map((f) => f.key)).toEqual(STATE_FIELDS.color.map((f) => f.key));
  });

  it("a device's own reported kelvinRange replaces the capability's generic default range", () => {
    const ctx: NarrowingContext = { modes: { rgb: true, cct: true }, kelvinRange: { min: 2000, max: 4000 } };
    const kelvin = resolveStateFields("color", ctx).find((f) => f.key === "kelvin");
    expect(kelvin).toMatchObject({ min: 2000, max: 4000 });
  });
});

describe("resolveStateFields / resolveCommandDefinitions — tier 1 (driver command metadata)", () => {
  it("a driver-published commandMetadata.commands wins outright — no tier-2/3/4 narrowing applied on top", () => {
    const customCommand = { capability: "color" as const, action: "custom", label: "Vendor mode", params: [] };
    const ctx: NarrowingContext = {
      modes: { rgb: false, cct: false }, // would normally strip everything — irrelevant once tier 1 answers
      config: { commandMetadata: { commands: [customCommand] } },
    };
    expect(resolveCommandDefinitions("color", ctx)).toEqual([customCommand]);
  });

  it("a driver-published commandMetadata.stateFields wins outright for triggers/conditions", () => {
    const customField = { key: "vendorField", label: "Vendor Field", type: "string" as const };
    const ctx: NarrowingContext = { config: { commandMetadata: { stateFields: [customField] } } };
    expect(resolveStateFields("color", ctx)).toEqual([customField]);
  });

  it("an empty/malformed commandMetadata is ignored, not treated as 'zero fields' — falls through to tier 2/3/4", () => {
    const ctx: NarrowingContext = { config: { commandMetadata: { commands: [] } } };
    expect(resolveCommandDefinitions("lock", ctx)).toEqual(COMMAND_DEFINITIONS.lock);
  });

  it("no config at all is the common case for every driver today and behaves exactly like tier 4 alone", () => {
    expect(resolveStateFields("temperature", {})).toEqual(STATE_FIELDS.temperature);
  });
});

describe("commandableCapabilities — sensor stays read-only everywhere", () => {
  it("filters sensor out of a mixed device's commandable kinds", () => {
    expect(commandableCapabilities(["onoff", "sensor", "brightness"])).toEqual(["onoff", "brightness"]);
  });

  it("sensor has zero command definitions — never offered as an action target even if narrowing is skipped", () => {
    expect(COMMAND_DEFINITIONS.sensor).toEqual([]);
    expect(READONLY_CAPABILITIES).toContain("sensor");
  });
});

describe("presentation hints — every widget-hinted param stays internally consistent", () => {
  it("every field/param with a bounded slider-style widget (slider/cctSlider) declares min AND max together", () => {
    const allDefs = [...Object.values(STATE_FIELDS).flat(), ...Object.values(COMMAND_DEFINITIONS).flat().flatMap((d) => d.params)];
    for (const f of allDefs) {
      if (f.widget === "cctSlider") {
        expect(f.min, `${f.key} (cctSlider) must declare min`).toBeDefined();
        expect(f.max, `${f.key} (cctSlider) must declare max`).toBeDefined();
      }
    }
  });

  it("every enum-typed field with a chips/fanSelector widget declares enumValues (so the shared ChipSelector never renders empty)", () => {
    const allDefs = [...Object.values(STATE_FIELDS).flat(), ...Object.values(COMMAND_DEFINITIONS).flat().flatMap((d) => d.params)];
    for (const f of allDefs) {
      if (f.widget === "chips" || f.widget === "fanSelector") {
        expect(f.type, `${f.key} (${f.widget}) must be type enum`).toBe("enum");
        expect(f.enumValues?.length, `${f.key} (${f.widget}) must declare enumValues`).toBeTruthy();
      }
    }
  });

  it("color temperature defaults to the 2700–6500K residential range", () => {
    const kelvinState = STATE_FIELDS.color.find((f) => f.key === "kelvin")!;
    const kelvinCommand = COMMAND_DEFINITIONS.color[0]!.params.find((p) => p.key === "kelvin")!;
    expect(kelvinState).toMatchObject({ min: 2700, max: 6500 });
    expect(kelvinCommand).toMatchObject({ min: 2700, max: 6500 });
  });
});

describe("command definitions mirror the real CapabilityCommand shape (§ ADR 0017)", () => {
  it("every capability with real command verbs exposes them as distinct definitions, not a shared filtered pool", () => {
    const onoffActions = COMMAND_DEFINITIONS.onoff.map((d) => d.action);
    expect(onoffActions).toEqual(["on", "off", "toggle"]);
    // Each is independently a zero-param command — matches the real onoff CapabilityCommand,
    // which carries no fields beyond `action`.
    for (const d of COMMAND_DEFINITIONS.onoff) expect(d.params).toEqual([]);
  });

  it("capabilities with no verb (color, temperature) expose exactly one action:null definition", () => {
    expect(COMMAND_DEFINITIONS.color).toHaveLength(1);
    expect(COMMAND_DEFINITIONS.color[0]!.action).toBeNull();
    expect(COMMAND_DEFINITIONS.temperature[0]!.action).toBeNull();
  });
});
