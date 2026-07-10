import { describe, expect, it } from "vitest";
import {
  encodeSearchRequest,
  formatIndividualAddress,
  knxSearch,
  parseSearchResponse,
  type KnxDiscoverySocket,
} from "./knx-discovery.js";

/** Build a valid KNXnet/IP SEARCH_RESPONSE for a fake interface. */
function buildSearchResponse(ip: string, port: number, ia: number, name: string): Buffer {
  const buf = Buffer.alloc(6 + 8 + 54);
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
});
