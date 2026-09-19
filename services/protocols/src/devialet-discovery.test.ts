import { describe, expect, it } from "vitest";
import { DEVIALET_MDNS_SERVICE, parseDevialetCandidate, transportHostFor, type DevialetDiscoveryCandidate } from "./devialet-discovery.js";
import type { MdnsService } from "./mdns.js";

/**
 * § D5 — pure discovery-parsing tests. No I/O, no server, no driver — matches the
 * `*-codec.ts` test convention elsewhere in this fleet (pure function, pure test).
 * Fixtures follow the R1 doc's own `avahi-browse` worked example
 * (`PhantomII98dB-L32Z12345TQ9A.local`, `path=/ipcontrol/v1`,
 * `ipControlVersion=1`, `manufacturer=Devialet`).
 */

function service(overrides: Partial<MdnsService> = {}): MdnsService {
  return {
    name: "Living room-ipcontrol._http._tcp.local",
    host: "PhantomII98dB-L32Z12345TQ9A.local",
    port: 80,
    addresses: ["192.168.1.26"],
    txt: { path: "/ipcontrol/v1", ipControlVersion: "1", manufacturer: "Devialet" },
    ...overrides,
  };
}

describe("DEVIALET_MDNS_SERVICE", () => {
  it("is the correct _http._tcp service type per the R1 doc (not _devialet-http._tcp)", () => {
    expect(DEVIALET_MDNS_SERVICE).toBe("_http._tcp.local");
  });
});

describe("parseDevialetCandidate", () => {
  it("B/C/G/H/I — accepts a real Devialet -ipcontrol record and parses host/port/path/ipControlVersion", () => {
    const candidate = parseDevialetCandidate(service());
    expect(candidate).toEqual<DevialetDiscoveryCandidate>({
      mdnsName: "Living room-ipcontrol._http._tcp.local",
      host: "192.168.1.26",
      port: 80,
      path: "/ipcontrol/v1",
      ipControlVersion: "1",
      manufacturer: "Devialet",
    });
  });

  it("D/E — a non-Devialet _http._tcp service (missing/wrong manufacturer) is rejected", () => {
    expect(parseDevialetCandidate(service({ txt: { path: "/x", ipControlVersion: "1", manufacturer: "SomeOtherVendor" } }))).toBeNull();
    expect(parseDevialetCandidate(service({ txt: { path: "/x", ipControlVersion: "1" } }))).toBeNull();
  });

  it("D — the plain (non-'-ipcontrol') _http._tcp record the R1 doc's own example shows (path='/', no ipControlVersion/manufacturer) is rejected", () => {
    expect(parseDevialetCandidate(service({ name: "Living room._http._tcp.local", txt: { path: "/" } }))).toBeNull();
  });

  it("F — missing ipControlVersion is rejected outright, never treated as a degraded-but-usable candidate", () => {
    expect(parseDevialetCandidate(service({ txt: { path: "/ipcontrol/v1", manufacturer: "Devialet" } }))).toBeNull();
  });

  it("R — empty/malformed TXT record is handled safely (rejected, never throws)", () => {
    expect(() => parseDevialetCandidate(service({ txt: {} }))).not.toThrow();
    expect(parseDevialetCandidate(service({ txt: {} }))).toBeNull();
  });

  it("S — invalid port (0, negative, non-finite) is rejected safely", () => {
    expect(parseDevialetCandidate(service({ port: 0 }))).toBeNull();
    expect(parseDevialetCandidate(service({ port: -1 }))).toBeNull();
    expect(parseDevialetCandidate(service({ port: NaN }))).toBeNull();
  });

  it("T — missing path is rejected, never silently defaulted to /ipcontrol/v1", () => {
    expect(parseDevialetCandidate(service({ txt: { ipControlVersion: "1", manufacturer: "Devialet" } }))).toBeNull();
  });

  it("rejects a candidate with no resolved address", () => {
    expect(parseDevialetCandidate(service({ addresses: [] }))).toBeNull();
  });

  it("accepts an IPv6 address as-is (the doc: 'the address entries may be in either IPv4 or IPv6 format')", () => {
    const candidate = parseDevialetCandidate(service({ addresses: ["fe80::525b:c2ff:fe9c:7955"] }));
    expect(candidate?.host).toBe("fe80::525b:c2ff:fe9c:7955");
  });
});

describe("transportHostFor", () => {
  it("joins a plain IPv4 host with its port", () => {
    const candidate = parseDevialetCandidate(service())!;
    expect(transportHostFor(candidate)).toBe("192.168.1.26:80");
  });

  it("brackets a bare IPv6 address before appending the port (URL-authority form)", () => {
    const candidate = parseDevialetCandidate(service({ addresses: ["fe80::525b:c2ff:fe9c:7955"], port: 8080 }))!;
    expect(transportHostFor(candidate)).toBe("[fe80::525b:c2ff:fe9c:7955]:8080");
  });
});
