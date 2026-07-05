import { describe, expect, it } from "vitest";
import { generateHubCa, hubIdFromCert, issueDeviceCert, issueServerCert, verifyAgainstCa } from "./index.js";

describe("hub PKI (X.509)", () => {
  it("issues a device cert that chains to the Hub CA and carries the hub id as CN", () => {
    const ca = generateHubCa();
    const dev = issueDeviceCert(ca, { hubUuid: "0191c0de-1234-7abc-89ab-1234567890ab" });
    expect(dev.certPem).toContain("BEGIN CERTIFICATE");
    expect(dev.keyPem).toContain("BEGIN PRIVATE KEY");
    expect(verifyAgainstCa(dev.certPem, ca.caCertPem).valid).toBe(true);
    expect(hubIdFromCert(dev.certPem)).toBe("0191c0de-1234-7abc-89ab-1234567890ab");
  });

  it("rejects a device cert from a different CA", () => {
    const ca = generateHubCa();
    const other = generateHubCa();
    const dev = issueDeviceCert(other, { hubUuid: "hub-x" });
    const check = verifyAgainstCa(dev.certPem, ca.caCertPem);
    expect(check.valid).toBe(false);
  });

  it("rejects an expired device cert", () => {
    const ca = generateHubCa();
    const t0 = 1_750_000_000_000;
    const dev = issueDeviceCert(ca, { hubUuid: "hub-x", notBeforeMs: t0, ttlMs: 1000 });
    expect(verifyAgainstCa(dev.certPem, ca.caCertPem, t0 + 500).valid).toBe(true);
    expect(verifyAgainstCa(dev.certPem, ca.caCertPem, t0 + 2000).valid).toBe(false);
  });

  it("issues a broker server cert chaining to the CA", () => {
    const ca = generateHubCa();
    const server = issueServerCert(ca, { commonName: "broker.supreme.example" });
    expect(verifyAgainstCa(server.certPem, ca.caCertPem).valid).toBe(true);
  });
});
