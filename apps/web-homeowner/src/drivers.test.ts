import { describe, expect, it } from "vitest";
import { statusLabel, liveStatusLabel, visibleCasambiConfigSchema } from "./drivers.js";
import type { DriverEntry, DriverConfigField } from "./api.js";

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

// § Realtime State Architecture — KNX Connect/Disconnect (and every other driver, since
// this is generic) must render the ACTUAL confirmed connection state, never treat a
// request as equivalent to success. See installer-context.ts's connectDriver()/
// disconnectDriver() for the backend half of this same fix.
describe("liveStatusLabel", () => {
  it("shows 'Connecting…' immediately on request, distinct from 'Connected'", () => {
    expect(liveStatusLabel(driver(), "connecting", null)).toMatchObject({ text: "Connecting…", cls: "pending" });
  });

  it("does not show 'Connected' until the realtime layer confirms it", () => {
    expect(liveStatusLabel(driver(), "connecting", null)).not.toMatchObject({ text: "Connected" });
    expect(liveStatusLabel(driver(), "connected", null)).toMatchObject({ text: "Connected", cls: "ok" });
  });

  it("shows 'Disconnecting…' immediately on request, distinct from 'Disconnected'", () => {
    expect(liveStatusLabel(driver(), "disconnecting", null)).toMatchObject({ text: "Disconnecting…", cls: "pending" });
  });

  it("shows 'Disconnected' only once confirmed", () => {
    expect(liveStatusLabel(driver(), "disconnected", null)).toMatchObject({ text: "Disconnected", cls: "err" });
  });

  it("shows 'Error' on a failed connect/disconnect", () => {
    expect(liveStatusLabel(driver(), "error", null)).toMatchObject({ text: "Error", cls: "err" });
  });

  it("falls back to the install/enable/REST-health verdict when no live state has arrived yet (§16 Initial State + Realtime State)", () => {
    expect(liveStatusLabel(driver(), undefined, true)).toMatchObject({ text: "Active" });
    expect(liveStatusLabel(driver(), undefined, false)).toMatchObject({ text: "Disconnected" });
  });

  it("still reads 'Not installed'/'Disabled' regardless of a stale live state (e.g. driver was uninstalled after connecting)", () => {
    expect(liveStatusLabel(driver({ installed: false }), "connected", null)).toMatchObject({ text: "Not installed" });
    expect(liveStatusLabel(driver({ enabled: false }), "connected", null)).toMatchObject({ text: "Disabled" });
  });
});

// § Casambi fleet-wide env-var default — only the API key is a deployment-wide credential (set
// once via SUPREME_CASAMBI_API_KEY) that never appears as a renderable field, in Cloud mode, in
// Local mode, or with the discriminator omitted entirely. email/password genuinely vary per
// project (each job may use a different Casambi account) and DO render as editable fields in
// Cloud mode — same as `networkId`, which is not a secret at all.
describe("visibleCasambiConfigSchema (§ Casambi fleet-wide env-var default — only apiKey never rendered)", () => {
  const field = (key: string, extra: Partial<DriverConfigField> = {}): DriverConfigField => ({
    key,
    label: key,
    type: "text",
    required: false,
    secret: false,
    ...extra,
  });
  const schema: DriverConfigField[] = [
    field("connectionType", { type: "select" }),
    field("apiKey", { type: "password", secret: true }),
    field("email"),
    field("password", { type: "password", secret: true }),
    field("networkId"),
    field("gatewayIp"),
    field("gatewayUsername"),
  ];

  it("never shows apiKey, but shows email/password/networkId, in Cloud mode", () => {
    const keys = visibleCasambiConfigSchema(schema, { connectionType: "cloud" }).map((f) => f.key);
    expect(keys).not.toContain("apiKey");
    expect(keys).toContain("email"); // varies per project — genuinely editable
    expect(keys).toContain("password");
    expect(keys).toContain("networkId"); // not a secret — genuinely per-job
  });

  it("never shows apiKey/email/password in Local mode (those are Cloud-only fields)", () => {
    const keys = visibleCasambiConfigSchema(schema, { connectionType: "local" }).map((f) => f.key);
    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("password");
    expect(keys).toContain("gatewayIp");
  });

  it("never shows apiKey with connectionType omitted (defaults to cloud)", () => {
    const keys = visibleCasambiConfigSchema(schema, {}).map((f) => f.key);
    expect(keys).not.toContain("apiKey");
    expect(keys).toContain("email");
    expect(keys).toContain("password");
  });
});
