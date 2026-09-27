import { decodeMessage, resolveServices } from "@supreme/protocols";
import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeQuestionNames,
  encodeAAnswer,
  encodePtrAnswer,
  encodeResponse,
  encodeSrvAnswer,
  encodeTxtAnswer,
  startMdnsResponder,
  type MdnsResponderHandle,
} from "./mdns-responder.js";

const SERVICE_TYPE = "_supremeos._tcp.local";

describe("mDNS Hub Responder — wire codec", () => {
  it("finds the queried service type in a real DNS-SD query's question section", () => {
    // A real PTR query for _supremeos._tcp.local, QU bit set — same shape
    // apps/new's MdnsHubDiscovery (multicast_dns package) actually sends.
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4); // QDCOUNT
    const name = Buffer.concat(
      "_supremeos._tcp.local".split(".").map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])),
    );
    const query = Buffer.concat([header, name, Buffer.from([0]), Buffer.from([0, 12, 0x80, 0x01])]);
    expect(decodeQuestionNames(query)).toEqual([SERVICE_TYPE]);
  });

  it("§ interop — a response this module encodes decodes cleanly through @supreme/protocols' own trusted mDNS codec (the same decoder apps/new's Dart client's wire format is modeled against)", () => {
    const instanceName = `hub-abc123.${SERVICE_TYPE}`;
    const answers = [
      encodePtrAnswer(SERVICE_TYPE, instanceName),
      encodeSrvAnswer(instanceName, "hub-abc123.local", 7272),
      encodeTxtAnswer(instanceName, { hubId: "hub-abc123", version: "0.2.0", projectId: "home-1" }),
      encodeAAnswer("hub-abc123.local", "192.168.1.42"),
    ];
    const response = encodeResponse(answers);

    const { records } = decodeMessage(response);
    const services = resolveServices(records, SERVICE_TYPE);
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      name: instanceName,
      host: "hub-abc123.local",
      port: 7272,
      addresses: ["192.168.1.42"],
      txt: { hubId: "hub-abc123", version: "0.2.0", projectId: "home-1" },
    });
  });
});

describe("mDNS Hub Responder — real multicast socket", () => {
  let handle: MdnsResponderHandle | null = null;
  afterEach(() => {
    handle?.stop();
    handle = null;
  });

  it("answers a real PTR query for _supremeos._tcp sent over the loopback multicast group", async () => {
    handle = startMdnsResponder({
      hubId: "hub-test-1",
      projectId: "home-test-1",
      protocolVersion: "9.9.9",
      port: 7272,
    });

    // A real DNS-SD PTR query, sent exactly as a client would.
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4); // QDCOUNT
    const name = Buffer.concat(
      SERVICE_TYPE.split(".").map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])),
    );
    const query = Buffer.concat([header, name, Buffer.from([0]), Buffer.from([0, 12, 0x80, 0x01])]);

    const client = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply from mdns responder within 3s")), 3000);
      client.on("message", (msg) => {
        // Multicast loopback means this socket also sees its OWN query echoed back
        // (same host, same group) — QR bit (top bit of the flags word) distinguishes
        // a real response from that self-echo.
        if ((msg.readUInt16BE(2) & 0x8000) === 0) return;
        clearTimeout(timer);
        resolve(msg);
      });
      client.bind(5353, () => {
        try {
          client.addMembership("224.0.0.251");
        } catch {
          /* best-effort — some sandboxed CI networks have no multicast-capable interface */
        }
        client.send(query, 5353, "224.0.0.251");
      });
    }).finally(() => client.close());

    const { records } = decodeMessage(reply);
    const services = resolveServices(records, SERVICE_TYPE);
    expect(services).toHaveLength(1);
    expect(services[0]?.port).toBe(7272);
    expect(services[0]?.txt).toMatchObject({ hubId: "hub-test-1", projectId: "home-test-1", version: "9.9.9" });
  }, 10_000);
});
