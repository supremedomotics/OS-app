import { describe, expect, it } from "vitest";
import type { DriverConfigField } from "@supreme/domain-model";
import { defaultDriverConfig, isConfigComplete, SECRET_MASK, validateDriverConfig } from "./config.js";

const schema: DriverConfigField[] = [
  { key: "host", label: "Host", type: "host", required: true, secret: false },
  { key: "port", label: "Port", type: "port", required: true, default: 3671, secret: false },
  { key: "password", label: "Password", type: "password", required: false, secret: true },
  { key: "channel", label: "Channel", type: "number", min: 11, max: 26, secret: false },
  { key: "mode", label: "Mode", type: "select", options: [{ value: "tcp", label: "TCP" }, { value: "rtu", label: "RTU" }], secret: false },
  { key: "enabled", label: "Enabled", type: "boolean", secret: false },
];

describe("validateDriverConfig", () => {
  it("coerces types, applies defaults and reports required errors", () => {
    const { config, errors } = validateDriverConfig(schema, { host: "192.168.1.10", channel: "15", enabled: "true" });
    expect(errors).toEqual([]);
    expect(config.host).toBe("192.168.1.10");
    expect(config.port).toBe(3671); // default applied
    expect(config.channel).toBe(15); // coerced to number
    expect(config.enabled).toBe(true);
  });

  it("flags a missing required field and out-of-range numbers + bad selects", () => {
    const { errors } = validateDriverConfig(schema, { channel: 99, mode: "serial" });
    expect(errors).toContain("Host is required");
    expect(errors.some((e) => e.includes("Channel"))).toBe(true);
    expect(errors.some((e) => e.includes("Mode"))).toBe(true);
  });

  it("preserves a secret sent back as the mask, but keeps a new value", () => {
    const existing = { host: "h", port: 3671, password: "s3cr3t" };
    const kept = validateDriverConfig(schema, { host: "h", password: SECRET_MASK }, existing);
    expect(kept.config.password).toBe("s3cr3t"); // unchanged mask → preserved
    const changed = validateDriverConfig(schema, { host: "h", password: "new-pass" }, existing);
    expect(changed.config.password).toBe("new-pass");
  });

  it("enforces port bounds by default", () => {
    expect(validateDriverConfig(schema, { host: "h", port: 70000 }).errors.some((e) => e.includes("Port"))).toBe(true);
  });
});

describe("validateDriverConfig — requiredIf (mode-conditional required fields)", () => {
  const modeSchema: DriverConfigField[] = [
    { key: "connectionType", label: "Connection type", type: "select", required: true, default: "cloud", secret: false },
    { key: "apiKey", label: "API key", type: "password", requiredIf: { key: "connectionType", equals: "cloud" }, secret: true },
    { key: "email", label: "Network admin email", type: "text", requiredIf: { key: "connectionType", equals: "cloud" }, secret: false },
    { key: "gatewayIp", label: "Gateway IP", type: "host", requiredIf: { key: "connectionType", equals: "local" }, secret: false },
    { key: "gatewayUsername", label: "Gateway username", type: "text", requiredIf: { key: "connectionType", equals: "local" }, secret: false },
  ];

  it("requires only Cloud fields when connectionType is cloud, never Local fields", () => {
    const { errors } = validateDriverConfig(modeSchema, { connectionType: "cloud", apiKey: "k", email: "a@b.com" });
    expect(errors).toEqual([]);
  });

  it("requires only Local fields when connectionType is local, never Cloud fields", () => {
    const { errors } = validateDriverConfig(modeSchema, { connectionType: "local", gatewayIp: "192.168.1.50", gatewayUsername: "admin" });
    expect(errors).toEqual([]);
  });

  it("flags missing Cloud fields in cloud mode without ever flagging Local fields", () => {
    const { errors } = validateDriverConfig(modeSchema, { connectionType: "cloud" });
    expect(errors).toContain("API key is required");
    expect(errors).toContain("Network admin email is required");
    expect(errors.some((e) => e.includes("Gateway"))).toBe(false);
  });

  it("flags missing Local fields in local mode without ever flagging Cloud fields", () => {
    const { errors } = validateDriverConfig(modeSchema, { connectionType: "local" });
    expect(errors).toContain("Gateway IP is required");
    expect(errors).toContain("Gateway username is required");
    expect(errors.some((e) => e.includes("API key") || e.includes("email"))).toBe(false);
  });

  it("resolves the discriminator from existing stored config when not resubmitted", () => {
    const { errors } = validateDriverConfig(modeSchema, { gatewayIp: "192.168.1.50", gatewayUsername: "admin" }, { connectionType: "local" });
    expect(errors).toEqual([]);
  });

  it("falls back to the discriminator field's own schema default", () => {
    const { errors } = validateDriverConfig(modeSchema, { apiKey: "k", email: "a@b.com" });
    expect(errors).toEqual([]); // default connectionType is "cloud"
  });
});

describe("defaults + completeness", () => {
  it("defaultDriverConfig returns declared defaults", () => {
    expect(defaultDriverConfig(schema)).toEqual({ port: 3671 });
  });
  it("isConfigComplete finds missing required fields", () => {
    expect(isConfigComplete(schema, { port: 3671 })).toEqual({ complete: false, missing: ["host"] });
    expect(isConfigComplete(schema, { host: "h", port: 3671 }).complete).toBe(true);
  });

  it("isConfigComplete honors requiredIf against the config's own connectionType value", () => {
    const modeSchema: DriverConfigField[] = [
      { key: "connectionType", label: "Connection type", type: "select", default: "cloud", secret: false },
      { key: "gatewayIp", label: "Gateway IP", type: "host", requiredIf: { key: "connectionType", equals: "local" }, secret: false },
    ];
    expect(isConfigComplete(modeSchema, { connectionType: "cloud" }).complete).toBe(true);
    expect(isConfigComplete(modeSchema, { connectionType: "local" })).toEqual({ complete: false, missing: ["gatewayIp"] });
    expect(isConfigComplete(modeSchema, { connectionType: "local", gatewayIp: "1.2.3.4" }).complete).toBe(true);
  });
});
