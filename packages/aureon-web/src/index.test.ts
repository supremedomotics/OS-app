import { describe, expect, it } from "vitest";
import { aureon, toCssVariables } from "./index.js";

describe("aureon tokens", () => {
  it("exposes the gold accent ramp", () => {
    expect(aureon.color.gold["500"]).toMatch(/^#/);
  });

  it("emits kebab-cased CSS custom properties", () => {
    const css = toCssVariables();
    expect(css).toContain("--aureon-color-base-void: #0A0908;");
    expect(css).toContain("--aureon-color-gold-500: #9C876C;");
    expect(css).toContain(":root {");
  });
});
