import { describe, expect, it } from "vitest";
import {
  applyAureonTheme,
  loadAureonTheme,
  resolveMode,
  saveAureonTheme,
  type AureonThemeChoice,
} from "./theme.js";

const dark = { matchMedia: () => ({ matches: true }) };
const light = { matchMedia: () => ({ matches: false }) };

class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe("Aureon theming", () => {
  it("resolves auto to the OS preference, else honours the explicit mode", () => {
    expect(resolveMode("auto", dark)).toBe("dark");
    expect(resolveMode("auto", light)).toBe("light");
    expect(resolveMode("light", dark)).toBe("light");
    expect(resolveMode("dark", light)).toBe("dark");
  });

  it("reflects the choice onto the document root as data attributes", () => {
    const root = { dataset: {} as Record<string, string> };
    applyAureonTheme({ mode: "auto", accent: "silver" }, root, light);
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.accent).toBe("silver");
  });

  it("round-trips the choice through storage with safe defaults", () => {
    const store = new FakeStorage();
    expect(loadAureonTheme(store)).toEqual({ mode: "dark", accent: "gold" });
    const choice: AureonThemeChoice = { mode: "light", accent: "silver" };
    saveAureonTheme(choice, store);
    expect(loadAureonTheme(store)).toEqual(choice);
  });

  it("falls back to defaults on corrupt storage", () => {
    const store = new FakeStorage();
    store.setItem("aureon.theme", "{not json");
    expect(loadAureonTheme(store)).toEqual({ mode: "dark", accent: "gold" });
  });
});
