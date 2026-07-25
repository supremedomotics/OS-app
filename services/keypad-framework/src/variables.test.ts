import { describe, expect, it } from "vitest";
import { expandVariables } from "./variables.js";

describe("expandVariables", () => {
  it("substitutes a top-level {{name}} reference with its variable value", () => {
    expect(expandVariables("{{step}}", { step: 10 })).toBe(10);
    expect(expandVariables("{{enabled}}", { enabled: true })).toBe(true);
    expect(expandVariables("{{label}}", { label: "hello" })).toBe("hello");
  });

  it("leaves a plain literal untouched", () => {
    expect(expandVariables(42, { step: 10 })).toBe(42);
    expect(expandVariables("plain string", { step: 10 })).toBe("plain string");
  });

  it("leaves an unresolved reference untouched (unknown variable name)", () => {
    expect(expandVariables("{{missing}}", { step: 10 })).toBe("{{missing}}");
  });

  it("substitutes references nested arbitrarily deep inside objects/arrays", () => {
    const input = {
      type: "device_command",
      deviceId: "dev_x",
      command: { capability: "brightness", action: "set", level: "{{step}}" },
    };
    expect(expandVariables(input, { step: 25 })).toEqual({
      type: "device_command",
      deviceId: "dev_x",
      command: { capability: "brightness", action: "set", level: 25 },
    });
  });

  it("substitutes inside array elements", () => {
    const input = ["{{a}}", "{{b}}", "literal"];
    expect(expandVariables(input, { a: 1, b: 2 })).toEqual([1, 2, "literal"]);
  });

  it("passes null through unchanged", () => {
    expect(expandVariables(null, {})).toBeNull();
  });
});
