import { describe, it, expect } from "vitest";
import { subnetHosts, MAX_SUBNET_PROBE_HOSTS } from "./network-interfaces.js";

describe("subnetHosts — § FINDING 5 real-netmask-aware fallback probe range", () => {
  it("defaults to a /24 when no netmask is supplied and none is found on the host", () => {
    const hosts = subnetHosts("192.168.1.50");
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(hosts[hosts.length - 1]).toBe("192.168.1.254");
  });

  it("produces a wider-than-/24 range for a /20 netmask", () => {
    const hosts = subnetHosts("10.0.5.10", "255.255.240.0");
    // 10.0.0.0/20 -> hosts 10.0.0.1 .. 10.0.15.254 (4094 total), bounded by MAX_SUBNET_PROBE_HOSTS
    expect(hosts.length).toBe(MAX_SUBNET_PROBE_HOSTS);
    expect(hosts[0]).toBe("10.0.0.1");
    expect(hosts).not.toContain("10.0.16.0");
  });

  it("produces a narrower, correctly-bounded range for a /28 netmask", () => {
    const hosts = subnetHosts("192.168.1.20", "255.255.255.240");
    // 192.168.1.16/28 -> usable hosts 192.168.1.17 .. 192.168.1.30 (14 hosts)
    expect(hosts).toEqual(
      Array.from({ length: 14 }, (_, i) => `192.168.1.${17 + i}`),
    );
  });

  it("caps a very wide prefix (e.g. /16) at MAX_SUBNET_PROBE_HOSTS rather than sweeping the whole range", () => {
    const hosts = subnetHosts("172.16.0.5", "255.255.0.0");
    expect(hosts.length).toBe(MAX_SUBNET_PROBE_HOSTS);
    expect(hosts[0]).toBe("172.16.0.1");
  });

  it("returns [] for a non-IPv4-looking address", () => {
    expect(subnetHosts("not-an-ip")).toEqual([]);
  });

  it("falls back to /24 behavior when given a malformed netmask", () => {
    const hosts = subnetHosts("192.168.1.5", "not-a-mask");
    expect(hosts).toHaveLength(254);
  });
});
