import type { DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  encodeQuery,
  mdnsBrowse,
  readName,
  resolveServices,
  type MdnsService,
  type MdnsSocket,
} from "./mdns.js";
import { DevialetProtocolDriver } from "./devialet-driver.js";

const SERVICE = "_devialet-http._tcp.local";

function name(n: string): Buffer {
  const parts = n.replace(/\.$/, "").split(".");
  return Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0])]);
}
function record(rname: string, type: number, rdata: Buffer): Buffer {
  const head = Buffer.concat([name(rname), Buffer.alloc(8)]);
  head.writeUInt16BE(type, name(rname).length); // type
  head.writeUInt16BE(0x8001, name(rname).length + 2); // class IN + cache-flush
  head.writeUInt32BE(120, name(rname).length + 4); // ttl
  const len = Buffer.alloc(2);
  len.writeUInt16BE(rdata.length, 0);
  return Buffer.concat([head, len, rdata]);
}

/** A realistic (uncompressed) Devialet mDNS response: PTR + SRV + A + TXT. */
function devialetResponse(): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // response + AA
  header.writeUInt16BE(4, 6); // ANCOUNT
  const instance = `Phantom.${SERVICE}`;
  const port = Buffer.alloc(2);
  port.writeUInt16BE(80, 0);
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0]), port, name("phantom.local")]);
  const txtStr = "model=Phantom";
  const txt = Buffer.concat([Buffer.from([txtStr.length]), Buffer.from(txtStr)]);
  return Buffer.concat([
    header,
    record(SERVICE, 12, name(instance)), // PTR
    record(instance, 33, srv), // SRV
    record("phantom.local", 1, Buffer.from([10, 0, 0, 30])), // A
    record(instance, 16, txt), // TXT
  ]);
}

describe("mDNS DNS codec", () => {
  it("encodes a PTR query with the QU bit", () => {
    const q = encodeQuery(SERVICE);
    expect(q.readUInt16BE(4)).toBe(1); // QDCOUNT
    expect(q.readUInt16BE(q.length - 4)).toBe(12); // QTYPE = PTR
    expect(q.readUInt16BE(q.length - 2)).toBe(0x8001); // QU + IN
  });

  it("reads compressed names (pointer)", () => {
    // offset 0: "com"; offset 5: "test" + pointer→0  → "test.com"
    const buf = Buffer.from([3, 0x63, 0x6f, 0x6d, 0, 4, 0x74, 0x65, 0x73, 0x74, 0xc0, 0x00]);
    expect(readName(buf, 5)).toEqual(["test.com", 12]);
  });

  it("decodes a full response and resolves the service instance", () => {
    const { records } = decodeMessage(devialetResponse());
    const services = resolveServices(records, SERVICE);
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      name: `Phantom.${SERVICE}`,
      host: "phantom.local",
      port: 80,
      addresses: ["10.0.0.30"],
      txt: { model: "Phantom" },
    });
  });

  it("browses over a fake mDNS socket", async () => {
    const sock: MdnsSocket = (() => {
      let handler: ((m: Buffer, r: { address: string }) => void) | null = null;
      return {
        on: (_e, cb) => void (handler = cb),
        bind: (cb) => cb(),
        send: () => handler?.(devialetResponse(), { address: "10.0.0.30" }),
        close: () => {},
      };
    })();
    const services = await mdnsBrowse(SERVICE, { timeoutMs: 30, createSocket: () => sock });
    expect(services.map((s) => s.host)).toEqual(["phantom.local"]);
  });
});

describe("Devialet discovery over mDNS", () => {
  it("maps Bonjour services to commission-ready DiscoveredDevices", async () => {
    const fake: MdnsService = {
      name: `Living\\032Room.${SERVICE}`,
      host: "phantom.local",
      port: 80,
      addresses: ["10.0.0.30"],
      txt: { model: "Phantom II" },
    };
    const driver = new DevialetProtocolDriver({ mdns: async () => [fake] });
    const found = await driver.discover();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ backendId: "10.0.0.30", capabilities: ["media"] });
    expect(found[0]?.suggestedName).toBe("Living Room");

    // backendId is exactly the bind address.
    await driver.bind({ deviceId: "x" as DeviceId, capability: "media", address: found[0]!.backendId });
    expect(driver.manages("x" as DeviceId)).toBe(true);
  });
});
