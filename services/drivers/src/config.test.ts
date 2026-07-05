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

describe("defaults + completeness", () => {
  it("defaultDriverConfig returns declared defaults", () => {
    expect(defaultDriverConfig(schema)).toEqual({ port: 3671 });
  });
  it("isConfigComplete finds missing required fields", () => {
    expect(isConfigComplete(schema, { port: 3671 })).toEqual({ complete: false, missing: ["host"] });
    expect(isConfigComplete(schema, { host: "h", port: 3671 }).complete).toBe(true);
  });
});
