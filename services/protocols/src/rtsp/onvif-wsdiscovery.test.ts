import { describe, it, expect, vi } from "vitest";
import { parseProbeMatch, scopeValue, probeOnvif, buildProbeMessage, type OnvifDiscoverySocket } from "./onvif-wsdiscovery.js";

const SAMPLE_PROBE_MATCH = `<?xml version="1.0"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing">
  <e:Header><a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</a:Action></e:Header>
  <e:Body>
    <d:ProbeMatches>
      <d:ProbeMatch>
        <a:EndpointReference><a:Address>urn:uuid:4d3f5e10-1234-5678-9abc-0123456789ab</a:Address></a:EndpointReference>
        <d:Types>dn:NetworkVideoTransmitter</d:Types>
        <d:Scopes>onvif://www.onvif.org/name/FrontDoor onvif://www.onvif.org/hardware/DS-2CD2032-I onvif://www.onvif.org/location/Entrance</d:Scopes>
        <d:XAddrs>http://192.168.1.50/onvif/device_service</d:XAddrs>
      </d:ProbeMatch>
    </d:ProbeMatches>
  </e:Body>
</e:Envelope>`;

describe("parseProbeMatch", () => {
  it("parses a well-formed ProbeMatch", () => {
    const match = parseProbeMatch(SAMPLE_PROBE_MATCH);
    expect(match).not.toBeNull();
    expect(match!.uuid).toBe("4d3f5e10-1234-5678-9abc-0123456789ab");
    expect(match!.xaddrs).toEqual(["http://192.168.1.50/onvif/device_service"]);
    expect(match!.types).toEqual(["dn:NetworkVideoTransmitter"]);
    expect(scopeValue(match!.scopes, "name")).toBe("FrontDoor");
    expect(scopeValue(match!.scopes, "hardware")).toBe("DS-2CD2032-I");
  });

  it("returns null for non-ProbeMatch traffic", () => {
    expect(parseProbeMatch("<Hello><Foo/></Hello>")).toBeNull();
    expect(parseProbeMatch("not xml at all")).toBeNull();
  });

  it("handles missing fields gracefully (partial ONVIF implementation)", () => {
    const xml = `<d:ProbeMatches><d:ProbeMatch><d:XAddrs>http://10.0.0.5:8080/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches>`;
    const match = parseProbeMatch(xml);
    expect(match).not.toBeNull();
    expect(match!.uuid).toBeNull();
    expect(match!.scopes).toEqual([]);
    expect(match!.xaddrs).toEqual(["http://10.0.0.5:8080/onvif/device_service"]);
  });

  it("returns null when there is no usable XAddr at all", () => {
    const xml = `<d:ProbeMatches><d:ProbeMatch><d:Scopes>onvif://www.onvif.org/name/X</d:Scopes></d:ProbeMatch></d:ProbeMatches>`;
    expect(parseProbeMatch(xml)).toBeNull();
  });

  it("never throws on malformed XML", () => {
    const malformed = `<d:ProbeMatches><d:ProbeMatch><d:XAddrs>http://1.2.3.4/x<d:Scopes>broken`;
    expect(() => parseProbeMatch(malformed)).not.toThrow();
  });
});

describe("buildProbeMessage", () => {
  it("produces a valid-looking WS-Discovery Probe envelope", () => {
    const msg = buildProbeMessage("11111111-1111-1111-1111-111111111111");
    expect(msg).toContain("urn:uuid:11111111-1111-1111-1111-111111111111");
    expect(msg).toContain("NetworkVideoTransmitter");
    expect(msg).toContain("d:Probe");
  });
});

function fakeSocket(): { socket: OnvifDiscoverySocket; emit: (buf: Buffer, addr: string) => void; sent: Buffer[]; closed: boolean } {
  const listeners: ((msg: Buffer, rinfo: { address: string }) => void)[] = [];
  const sent: Buffer[] = [];
  const state = { closed: false };
  return {
    socket: {
      send: (data) => sent.push(data),
      onMessage: (cb) => listeners.push(cb),
      close: () => {
        state.closed = true;
      },
    },
    emit: (buf, addr) => listeners.forEach((l) => l(buf, { address: addr })),
    sent,
    get closed() {
      return state.closed;
    },
  } as any;
}

describe("probeOnvif", () => {
  it("collects matches from multiple interfaces and de-dupes nothing itself (raw matches)", async () => {
    const sockets = new Map<string, ReturnType<typeof fakeSocket>>();
    const factory = vi.fn(async (iface: string) => {
      const s = fakeSocket();
      sockets.set(iface, s);
      return s.socket;
    });

    const promise = probeOnvif({ interfaces: ["192.168.1.10", "10.0.0.5"], timeoutMs: 20, socketFactory: factory });
    await new Promise((r) => setTimeout(r, 5));
    sockets.get("192.168.1.10")!.emit(Buffer.from(SAMPLE_PROBE_MATCH), "192.168.1.50");

    const { matches, errors } = await promise;
    expect(errors).toEqual([]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.uuid).toBe("4d3f5e10-1234-5678-9abc-0123456789ab");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("never throws when one interface's socket factory fails — others still probe", async () => {
    const factory = vi.fn(async (iface: string) => {
      if (iface === "10.0.0.5") throw new Error("bind failed");
      return fakeSocket().socket;
    });
    const { matches, errors } = await probeOnvif({ interfaces: ["192.168.1.10", "10.0.0.5"], timeoutMs: 10, socketFactory: factory });
    expect(matches).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("10.0.0.5");
  });

  it("is cancellable via AbortSignal", async () => {
    const controller = new AbortController();
    const factory = vi.fn(async () => fakeSocket().socket);
    const promise = probeOnvif({ interfaces: ["192.168.1.10"], timeoutMs: 5000, socketFactory: factory, signal: controller.signal });
    controller.abort();
    const started = Date.now();
    await promise;
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("does nothing (no throw) with zero interfaces", async () => {
    const { matches, errors } = await probeOnvif({ interfaces: [], timeoutMs: 5 });
    expect(matches).toEqual([]);
    expect(errors).toEqual([]);
  });
});
