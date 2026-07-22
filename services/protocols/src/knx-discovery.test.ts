import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  encodeSearchRequest,
  formatIndividualAddress,
  knxSearch,
  listKnxNetworkInterfaces,
  parseSearchResponse,
  type KnxDiscoverySocket,
} from "./knx-discovery.js";

/** Build a valid KNXnet/IP SEARCH_RESPONSE for a fake interface. `serviceFamilyIds`
 * optionally appends a real SUPP_SVC_FAMILIES DIB (family_id/version byte pairs). */
function buildSearchResponse(ip: string, port: number, ia: number, name: string, serviceFamilyIds?: number[]): Buffer {
  const svcDibLen = serviceFamilyIds ? 2 + serviceFamilyIds.length * 2 : 0;
  const buf = Buffer.alloc(6 + 8 + 54 + svcDibLen);
  buf.writeUInt8(0x06, 0);
  buf.writeUInt8(0x10, 1);
  buf.writeUInt16BE(0x0202, 2);
  buf.writeUInt16BE(buf.length, 4);
  // control HPAI
  buf.writeUInt8(0x08, 6);
  buf.writeUInt8(0x01, 7);
  for (const [i, o] of ip.split(".").map(Number).entries()) buf.writeUInt8(o, 8 + i);
  buf.writeUInt16BE(port, 12);
  // Device Information DIB
  const dib = 14;
  buf.writeUInt8(54, dib);
  buf.writeUInt8(0x01, dib + 1);
  buf.writeUInt16BE(ia, dib + 4);
  buf.writeUInt8(224, dib + 18); // multicast 224.0.23.12
  buf.writeUInt8(0, dib + 19);
  buf.writeUInt8(23, dib + 20);
  buf.writeUInt8(12, dib + 21);
  buf.write(name, dib + 28, "latin1");
  if (serviceFamilyIds) {
    const svc = dib + 54;
    buf.writeUInt8(svcDibLen, svc);
    buf.writeUInt8(0x02, svc + 1); // SUPP_SVC_FAMILIES
    for (const [i, id] of serviceFamilyIds.entries()) {
      buf.writeUInt8(id, svc + 2 + i * 2);
      buf.writeUInt8(1, svc + 2 + i * 2 + 1); // version
    }
  }
  return buf;
}

describe("KNXnet/IP discovery", () => {
  it("encodes a well-formed SEARCH_REQUEST", () => {
    const req = encodeSearchRequest("192.168.1.5", 55000);
    expect(req.length).toBe(14);
    expect(req.readUInt16BE(2)).toBe(0x0201); // SEARCH_REQUEST
    expect(`${req.readUInt8(8)}.${req.readUInt8(9)}.${req.readUInt8(10)}.${req.readUInt8(11)}`).toBe("192.168.1.5");
    expect(req.readUInt16BE(12)).toBe(55000);
  });

  it("formats KNX individual addresses", () => {
    expect(formatIndividualAddress(0x1100)).toBe("1.1.0");
    expect(formatIndividualAddress(0x11ff)).toBe("1.1.255");
  });

  it("parses a SEARCH_RESPONSE into a gateway", () => {
    const gw = parseSearchResponse(buildSearchResponse("192.168.1.10", 3671, 0x1100, "MDT IP Interface"), "192.168.1.10");
    expect(gw).toMatchObject({
      address: "192.168.1.10",
      port: 3671,
      individualAddress: "1.1.0",
      name: "MDT IP Interface",
      multicastAddress: "224.0.23.12",
    });
  });

  it("parses SUPP_SVC_FAMILIES to report real tunnelling/routing capability (§ Gateway Auto Discovery)", () => {
    const tunnelOnly = parseSearchResponse(buildSearchResponse("192.168.1.10", 3671, 0x1100, "Tunnel-only IF", [0x02, 0x03, 0x04]), "192.168.1.10");
    expect(tunnelOnly).toMatchObject({ tunnellingCapable: true, routingCapable: false });

    const both = parseSearchResponse(buildSearchResponse("192.168.1.11", 3671, 0x1101, "Router", [0x02, 0x04, 0x05]), "192.168.1.11");
    expect(both).toMatchObject({ tunnellingCapable: true, routingCapable: true });
  });

  it("reports null capability (never guessed) when the response has no SUPP_SVC_FAMILIES DIB at all", () => {
    const gw = parseSearchResponse(buildSearchResponse("192.168.1.10", 3671, 0x1100, "Old Interface"), "192.168.1.10");
    expect(gw).toMatchObject({ tunnellingCapable: null, routingCapable: null });
  });

  it("rejects non-KNX frames", () => {
    expect(parseSearchResponse(Buffer.from([0x06, 0x10, 0x02, 0x01]), "1.2.3.4")).toBeNull();
  });

  it("collects interfaces over a fake multicast socket", async () => {
    let onMessage: ((m: Buffer, r: { address: string }) => void) | null = null;
    const socket: KnxDiscoverySocket = {
      on: (_e, cb) => {
        onMessage = cb as typeof onMessage;
      },
      bind: (cb) => cb(),
      setMulticast: () => {},
      send: () => {
        onMessage?.(buildSearchResponse("10.0.0.9", 3671, 0x1101, "Weinzierl 730"), { address: "10.0.0.9" });
      },
      close: () => {},
    };
    const gateways = await knxSearch({ timeoutMs: 20, createSocket: () => socket });
    expect(gateways).toHaveLength(1);
    expect(gateways[0]).toMatchObject({ address: "10.0.0.9", individualAddress: "1.1.1", name: "Weinzierl 730" });
  });

  it("binds and joins the multicast group through the SELECTED interface, not the OS default (§ Gateway Discovery: multi-homed host)", async () => {
    const boundAddresses: (string | undefined)[] = [];
    const multicastInterfaces: (string | undefined)[] = [];
    const socket: KnxDiscoverySocket = {
      on: () => {},
      bind: (cb, address) => {
        boundAddresses.push(address);
        cb();
      },
      setMulticast: (interfaceAddress) => {
        multicastInterfaces.push(interfaceAddress);
      },
      send: () => {},
      close: () => {},
    };
    await knxSearch({ timeoutMs: 10, createSocket: () => socket, interfaceAddress: "192.168.0.117" });
    expect(boundAddresses).toEqual(["192.168.0.117"]);
    expect(multicastInterfaces).toEqual(["192.168.0.117"]);
  });

  it("binds to every interface (undefined address) when no interface is selected — unchanged default behavior", async () => {
    const boundAddresses: (string | undefined)[] = [];
    const socket: KnxDiscoverySocket = {
      on: () => {},
      bind: (cb, address) => {
        boundAddresses.push(address);
        cb();
      },
      setMulticast: () => {},
      send: () => {},
      close: () => {},
    };
    await knxSearch({ timeoutMs: 10, createSocket: () => socket });
    expect(boundAddresses).toEqual([undefined]);
  });

  it("lists real network adapters and excludes Docker/WSL/Hyper-V/VMware/VPN adapters by default", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      Ethernet: [{ address: "192.168.0.117", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "192.168.0.117/24" }],
      docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "172.17.0.1/16" }],
      "vEthernet (WSL)": [{ address: "172.20.0.1", netmask: "255.255.240.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "172.20.0.1/20" }],
      "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
      tailscale0: [{ address: "100.64.0.5", netmask: "255.192.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "100.64.0.5/10" }],
    } as unknown as ReturnType<typeof os.networkInterfaces>);

    expect(listKnxNetworkInterfaces()).toEqual([{ name: "Ethernet", address: "192.168.0.117" }]);
    // Explicitly opting in still finds the otherwise-excluded adapters — never impossible
    // to select one, per "unless explicitly selected".
    const all = listKnxNetworkInterfaces({ includeVirtual: true }).map((i) => i.name);
    expect(all).toEqual(expect.arrayContaining(["Ethernet", "docker0", "vEthernet (WSL)", "tailscale0"]));
    expect(all).not.toContain("Loopback Pseudo-Interface 1"); // internal, excluded regardless

    vi.restoreAllMocks();
  });
});
