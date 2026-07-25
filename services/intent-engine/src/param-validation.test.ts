import type { IntentDefinition } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { validateIntentParams } from "./param-validation.js";

function def(parameters: IntentDefinition["parameters"]): IntentDefinition {
  return {
    id: "test",
    name: "Test",
    category: "system",
    description: "",
    requiredCapabilities: [],
    parameters,
    targetKinds: ["home"],
    version: "1.0.0",
    i18nKey: null,
  };
}

describe("validateIntentParams", () => {
  it("fills in a declared default when the caller omits the param", () => {
    const d = def([{ key: "step", type: "number", required: false, default: 10, description: "" }]);
    expect(validateIntentParams(d, {})).toEqual({ step: 10 });
  });

  it("throws when a required param is missing", () => {
    const d = def([{ key: "level", type: "number", required: true, description: "" }]);
    expect(() => validateIntentParams(d, {})).toThrow(/missing required parameter "level"/);
  });

  it("validates number type + bounds", () => {
    const d = def([{ key: "level", type: "number", required: true, min: 0, max: 100, description: "" }]);
    expect(() => validateIntentParams(d, { level: "not a number" })).toThrow(/must be a number/);
    expect(() => validateIntentParams(d, { level: 150 })).toThrow(/must be <= 100/);
    expect(() => validateIntentParams(d, { level: -5 })).toThrow(/must be >= 0/);
    expect(validateIntentParams(d, { level: 50 })).toEqual({ level: 50 });
  });

  it("validates boolean type", () => {
    const d = def([{ key: "on", type: "boolean", required: true, description: "" }]);
    expect(() => validateIntentParams(d, { on: "yes" })).toThrow(/must be a boolean/);
    expect(validateIntentParams(d, { on: true })).toEqual({ on: true });
  });

  it("validates string type", () => {
    const d = def([{ key: "title", type: "string", required: true, description: "" }]);
    expect(() => validateIntentParams(d, { title: 42 })).toThrow(/must be a string/);
  });

  it("validates enum type + options", () => {
    const d = def([{ key: "mode", type: "enum", required: true, options: ["heat", "cool"], description: "" }]);
    expect(() => validateIntentParams(d, { mode: "auto" })).toThrow(/must be one of: heat, cool/);
    expect(validateIntentParams(d, { mode: "heat" })).toEqual({ mode: "heat" });
  });

  it("passes through an unrecognized extra param untouched", () => {
    const d = def([]);
    expect(validateIntentParams(d, { anything: 1 })).toEqual({ anything: 1 });
  });
});
