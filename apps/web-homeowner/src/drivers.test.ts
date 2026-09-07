import { describe, expect, it } from "vitest";
import {
  statusLabel,
  liveStatusLabel,
  visibleCasambiConfigSchema,
  casambiWizardCloudConfigs,
  validateCasambiWizardCloud,
  casambiWizardLocalConfigs,
  validateCasambiWizardLocal,
  emptyCasambiWizardLocalGateway,
  casambiWizardLabels,
  type CasambiWizardCloudEntry,
  type CasambiWizardLocalGateway,
} from "./drivers.js";
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

// § Multi-network Casambi, Stage 2b — Setup Wizard pure logic.
describe("casambiWizardCloudConfigs / validateCasambiWizardCloud", () => {
  const entry = (overrides: Partial<CasambiWizardCloudEntry> = {}): CasambiWizardCloudEntry => ({
    networkId: "",
    email: "",
    password: "",
    ...overrides,
  });

  it("shared credentials: one email/password apply to every network, each keeping its OWN network id", () => {
    const entries = [entry({ networkId: "net-a" }), entry({ networkId: "net-b" })];
    const shared = { enabled: true, email: "installer@example.com", password: "hunter2" };
    const configs = casambiWizardCloudConfigs(entries, shared);
    expect(configs).toEqual([
      { connectionType: "cloud", email: "installer@example.com", password: "hunter2", networkId: "net-a" },
      { connectionType: "cloud", email: "installer@example.com", password: "hunter2", networkId: "net-b" },
    ]);
  });

  it("separate credentials: each network's own email/password is used, never the shared pair", () => {
    const entries = [
      entry({ networkId: "net-a", email: "a@example.com", password: "pw-a" }),
      entry({ networkId: "net-b", email: "b@example.com", password: "pw-b" }),
    ];
    const shared = { enabled: false, email: "should-not-appear@example.com", password: "should-not-appear" };
    const configs = casambiWizardCloudConfigs(entries, shared);
    expect(configs).toEqual([
      { connectionType: "cloud", email: "a@example.com", password: "pw-a", networkId: "net-a" },
      { connectionType: "cloud", email: "b@example.com", password: "pw-b", networkId: "net-b" },
    ]);
  });

  it("a stale per-entry value typed before switching to shared never leaks into the saved config", () => {
    const entries = [entry({ networkId: "net-a", email: "stale@example.com", password: "stale-pw" })];
    const shared = { enabled: true, email: "installer@example.com", password: "hunter2" };
    expect(casambiWizardCloudConfigs(entries, shared)[0]).toMatchObject({ email: "installer@example.com", password: "hunter2" });
  });

  it("omits networkId entirely when left blank — matches the manifest's own optional field", () => {
    const configs = casambiWizardCloudConfigs([entry()], { enabled: true, email: "a@example.com", password: "pw" });
    expect(configs[0]).not.toHaveProperty("networkId");
  });

  it("valid: single network, no shared toggle, real credentials", () => {
    const v = validateCasambiWizardCloud([entry({ email: "a@example.com", password: "pw" })], { enabled: false, email: "", password: "" });
    expect(v).toEqual({ valid: true, errors: [] });
  });

  it("rejects blank shared credentials", () => {
    const v = validateCasambiWizardCloud([entry(), entry()], { enabled: true, email: "", password: "" });
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("Email is required.");
    expect(v.errors).toContain("Password is required.");
  });

  it("rejects a blank per-entry email/password when credentials are separate", () => {
    const v = validateCasambiWizardCloud([entry({ networkId: "net-a" })], { enabled: false, email: "", password: "" });
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("Network 1: email is required.");
    expect(v.errors).toContain("Network 1: password is required.");
  });

  it("requires a network id per entry ONLY when multiple networks share one account — a blank id there is genuinely ambiguous", () => {
    const shared = { enabled: true, email: "a@example.com", password: "pw" };
    expect(validateCasambiWizardCloud([entry()], shared).valid).toBe(true); // single network: blank id is fine
    const multi = validateCasambiWizardCloud([entry(), entry({ networkId: "net-b" })], shared);
    expect(multi.valid).toBe(false);
    expect(multi.errors).toContain("Network 1: network id is required when multiple networks share one account.");
  });

  it("catches two entries pointed at the identical network id under shared credentials", () => {
    const shared = { enabled: true, email: "a@example.com", password: "pw" };
    const v = validateCasambiWizardCloud([entry({ networkId: "net-x" }), entry({ networkId: "net-x" })], shared);
    expect(v.valid).toBe(false);
    expect(v.errors.some((m) => m.includes("Duplicate network id") && m.includes("net-x"))).toBe(true);
  });

  it("does not flag a duplicate network id when credentials are separate — each is a genuinely different account", () => {
    const shared = { enabled: false, email: "", password: "" };
    const v = validateCasambiWizardCloud(
      [entry({ networkId: "net-x", email: "a@example.com", password: "pw-a" }), entry({ networkId: "net-x", email: "b@example.com", password: "pw-b" })],
      shared,
    );
    expect(v.errors.some((m) => m.includes("Duplicate network id"))).toBe(false);
  });

  it("requires at least one network", () => {
    expect(validateCasambiWizardCloud([], { enabled: true, email: "a@example.com", password: "pw" }).valid).toBe(false);
  });
});

describe("casambiWizardLocalConfigs / validateCasambiWizardLocal", () => {
  const gateway = (overrides: Partial<CasambiWizardLocalGateway> = {}): CasambiWizardLocalGateway => ({
    ...emptyCasambiWizardLocalGateway(),
    gatewayIp: "192.168.1.50",
    gatewayUsername: "admin",
    gatewayPassword: "secret",
    udpPort: "5100",
    ...overrides,
  });

  it("emptyCasambiWizardLocalGateway pre-fills restPort with the manifest's own default", () => {
    expect(emptyCasambiWizardLocalGateway().restPort).toBe("80");
  });

  it("produces the same field shape the single-instance Local Gateway panel already saves, per gateway", () => {
    const configs = casambiWizardLocalConfigs([gateway({ netId: "12", gatewayName: "Living Room" })]);
    expect(configs).toEqual([
      {
        connectionType: "local",
        gatewayIp: "192.168.1.50",
        restPort: 80,
        gatewayUsername: "admin",
        gatewayPassword: "secret",
        udpPort: 5100,
        netId: 12,
        dataFormat: "hex-dot",
        gatewayName: "Living Room",
      },
    ]);
  });

  it("two independent gateways produce two independent config objects", () => {
    const configs = casambiWizardLocalConfigs([
      gateway({ gatewayIp: "192.168.1.50", udpPort: "5100" }),
      gateway({ gatewayIp: "192.168.1.51", udpPort: "5100", gatewayUsername: "admin2", gatewayPassword: "secret2" }),
    ]);
    expect(configs[0]!.gatewayIp).toBe("192.168.1.50");
    expect(configs[1]!.gatewayIp).toBe("192.168.1.51");
    expect(configs[0]!.gatewayUsername).toBe("admin");
    expect(configs[1]!.gatewayUsername).toBe("admin2");
  });

  it("valid: one fully-filled gateway", () => {
    expect(validateCasambiWizardLocal([gateway()])).toEqual({ valid: true, errors: [] });
  });

  it("rejects every required field the manifest itself requires in Local mode", () => {
    const v = validateCasambiWizardLocal([emptyCasambiWizardLocalGateway()]);
    expect(v.valid).toBe(false);
    expect(v.errors).toContain("Gateway 1: gateway IP is required.");
    expect(v.errors).toContain("Gateway 1: gateway username is required.");
    expect(v.errors).toContain("Gateway 1: gateway password is required.");
    expect(v.errors).toContain("Gateway 1: UDP port is required.");
  });

  it("catches two gateways configured at the identical IP+UDP port — they would race for the same datagrams", () => {
    const v = validateCasambiWizardLocal([
      gateway({ gatewayIp: "192.168.1.50", udpPort: "5100" }),
      gateway({ gatewayIp: "192.168.1.50", udpPort: "5100" }),
    ]);
    expect(v.valid).toBe(false);
    expect(v.errors.some((m) => m.includes("same address") && m.includes("192.168.1.50:5100"))).toBe(true);
  });

  it("does not flag two gateways at the same IP but DIFFERENT UDP ports", () => {
    const v = validateCasambiWizardLocal([
      gateway({ gatewayIp: "192.168.1.50", udpPort: "5100" }),
      gateway({ gatewayIp: "192.168.1.50", udpPort: "5101" }),
    ]);
    expect(v.errors.some((m) => m.includes("same address"))).toBe(false);
  });

  it("requires at least one gateway", () => {
    expect(validateCasambiWizardLocal([]).valid).toBe(false);
  });
});

describe("casambiWizardLabels", () => {
  it("a lone network/gateway with nothing pre-existing gets NO label — identical to today's single-instance install", () => {
    expect(casambiWizardLabels("cloud", 1, 0)).toEqual([undefined]);
    expect(casambiWizardLabels("local", 1, 0)).toEqual([undefined]);
  });

  it("more than one created at once are all labeled, numbered from 1", () => {
    expect(casambiWizardLabels("cloud", 3, 0)).toEqual(["Network 1", "Network 2", "Network 3"]);
    expect(casambiWizardLabels("local", 2, 0)).toEqual(["Gateway 1", "Gateway 2"]);
  });

  it("adding to an existing install labels even a SINGLE new instance, continuing the numbering", () => {
    expect(casambiWizardLabels("cloud", 1, 1)).toEqual(["Network 2"]);
    expect(casambiWizardLabels("local", 2, 1)).toEqual(["Gateway 2", "Gateway 3"]);
  });
});
