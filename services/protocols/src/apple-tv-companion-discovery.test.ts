import { describe, it, expect } from "vitest";
import { discoverCompanionAddress } from "./apple-tv-companion-discovery.js";
import type { MdnsService } from "./mdns.js";

function fakeService(overrides: Partial<MdnsService>): MdnsService {
  return { name: "Living Room._companion-link._tcp.local", host: "192.168.1.10", port: 49153, addresses: ["192.168.1.10"], txt: {}, ...overrides };
}

describe("Apple TV Companion discovery (§ Phase 3.1, verified _companion-link._tcp)", () => {
  it("resolves the Companion port for the same host as the MRP connection", async () => {
    const browse = async (serviceType: string) => {
      expect(serviceType).toBe("_companion-link._tcp.local");
      return [fakeService({ host: "192.168.1.10", port: 49153 })];
    };
    expect(await discoverCompanionAddress("192.168.1.10", browse)).toBe("192.168.1.10:49153");
  });

  it("matches via the resolved addresses list when host itself doesn't match", async () => {
    const browse = async () => [fakeService({ host: "some-other-name.local", addresses: ["192.168.1.10", "fe80::1"], port: 49155 })];
    expect(await discoverCompanionAddress("192.168.1.10", browse)).toBe("192.168.1.10:49155");
  });

  it("returns null (never fabricated) when no matching Companion service is found", async () => {
    const browse = async () => [fakeService({ host: "192.168.1.99", addresses: ["192.168.1.99"] })]; // different device
    expect(await discoverCompanionAddress("192.168.1.10", browse)).toBeNull();
  });

  it("returns null on an empty scan (Apple TV offline / Companion disabled)", async () => {
    const browse = async () => [];
    expect(await discoverCompanionAddress("192.168.1.10", browse)).toBeNull();
  });

  it("returns null (never throws) if the underlying mDNS browse itself fails", async () => {
    const browse = async (): Promise<MdnsService[]> => {
      throw new Error("network unreachable");
    };
    await expect(discoverCompanionAddress("192.168.1.10", browse)).resolves.toBeNull();
  });

  it("picks the correct device among multiple Apple TVs advertising Companion", async () => {
    const browse = async () => [
      fakeService({ host: "192.168.1.10", port: 1111 }),
      fakeService({ host: "192.168.1.20", port: 2222 }),
    ];
    expect(await discoverCompanionAddress("192.168.1.20", browse)).toBe("192.168.1.20:2222");
  });
});
