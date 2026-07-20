import { describe, expect, it } from "vitest";
import { parseArpTable } from "./arp-lookup.js";

const SAMPLE = `IP address       HW type     Flags       HW address            Mask     Device
192.168.1.10     0x1         0x2         AA:BB:CC:DD:EE:FF     *        eth0
192.168.1.11     0x1         0x0         00:00:00:00:00:00     *        eth0
`;

describe("parseArpTable", () => {
  it("returns a lowercased MAC for a known, complete ARP entry", () => {
    expect(parseArpTable(SAMPLE, "192.168.1.10")).toBe("aa:bb:cc:dd:ee:ff");
  });

  it("returns null for an incomplete entry (all-zero MAC)", () => {
    expect(parseArpTable(SAMPLE, "192.168.1.11")).toBeNull();
  });

  it("returns null when the IP isn't in the table at all", () => {
    expect(parseArpTable(SAMPLE, "192.168.1.99")).toBeNull();
  });
});
