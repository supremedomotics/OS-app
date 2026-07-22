import { describe, expect, it } from "vitest";
import { statusLabel } from "./drivers.js";
import type { DriverEntry } from "./api.js";

function driver(overrides: Partial<DriverEntry> = {}): DriverEntry {
  return {
    key: "knx",
    name: "Supreme KNX",
    description: "",
    category: "protocol",
    channel: "official",
    version: "1.0.0",
    publisher: "Supreme Domotics",
    capabilities: [],
    protocols: ["knx"],
    requiresSku: "pro",
    configSchema: [],
    dependencies: [],
    operations: [],
    installed: true,
    enabled: true,
    status: "active",
    installedId: "knx-1",
    config: {},
    ...overrides,
  };
}

describe("statusLabel", () => {
  it("reads 'Not installed' when the driver isn't installed, regardless of connection state", () => {
    expect(statusLabel(driver({ installed: false }), true)).toMatchObject({ text: "Not installed" });
  });

  it("reads 'Disabled' when installed but not enabled", () => {
    expect(statusLabel(driver({ enabled: false }), true)).toMatchObject({ text: "Disabled" });
  });

  it("reads 'Error' when the driver itself reports an error status", () => {
    expect(statusLabel(driver({ status: "error" }), true)).toMatchObject({ text: "Error" });
  });

  it("§ production defect: installed+enabled with a real tunnel that never connected reads 'Disconnected', not 'Active'", () => {
    expect(statusLabel(driver(), false)).toMatchObject({ text: "Disconnected", cls: "err" });
  });

  it("reads 'Active' when installed, enabled, and the real connection state confirms it", () => {
    expect(statusLabel(driver(), true)).toMatchObject({ text: "Active", cls: "ok" });
  });

  it("falls back to 'Active' (install/enable-only) when connection state isn't known yet — never fabricates a 'Disconnected' from a still-loading health check", () => {
    expect(statusLabel(driver(), undefined)).toMatchObject({ text: "Active" });
    expect(statusLabel(driver(), null)).toMatchObject({ text: "Active" });
  });
});
