import { describe, expect, it } from "vitest";
import {
  decodeConnectRequest, decodeConnectResponse, decodeConnectionStateRequest, decodeDisconnectRequest, decodeFrame,
  decodeSearchRequest, decodeTunnellingAck, decodeTunnellingRequest, describeStatus, encodeConnectRequest,
  encodeConnectResponse, encodeConnectionStateRequest, encodeDisconnectRequest, encodeDisconnectResponse,
  encodeFrame, encodeHpai, encodeSearchRequest, encodeTunnellingAck, encodeTunnellingRequest, KnxFrameError,
  NAT_HPAI, ServiceType, StatusCode, TunnelLayer, decodeHpai, MAX_FRAME_SIZE,
} from "./knxnetip-frame.js";
import { makeRng } from "./test-support.js";

const hex = (b: Buffer): string => b.toString("hex");
const body = (b: Buffer): Buffer => decodeFrame(b).body;

describe("KNXnet/IP golden vectors", () => {
  it("CONNECT_REQUEST (NAT route-back, link-layer tunnel)", () => {
    const f = encodeConnectRequest({ controlEndpoint: NAT_HPAI, dataEndpoint: NAT_HPAI, layer: TunnelLayer.LINK });
    expect(hex(f)).toBe("06100205001a0801000000000000" + "0801000000000000" + "04040200");
    expect(decodeConnectRequest(body(f))).toEqual({ controlEndpoint: NAT_HPAI, dataEndpoint: NAT_HPAI, layer: 0x02 });
  });
  it("CONNECT_RESPONSE success carries channel, data endpoint and assigned address", () => {
    const f = encodeConnectResponse({ channelId: 7, status: 0, dataEndpoint: { protocol: 1, address: "192.168.1.10", port: 3671 }, assignedAddress: 0x110f });
    expect(hex(f)).toBe("06100206" + "0014" + "0700" + "0801c0a8010a0e57" + "0404110f");
    expect(decodeConnectResponse(body(f))).toMatchObject({ channelId: 7, status: 0, assignedAddress: 0x110f, dataEndpoint: { address: "192.168.1.10", port: 3671 } });
  });
  it("CONNECT_RESPONSE error is the short form and decodes", () => {
    const f = encodeConnectResponse({ channelId: 0, status: StatusCode.NO_MORE_CONNECTIONS });
    expect(hex(f)).toBe("061002060008" + "0024");
    expect(decodeConnectResponse(body(f))).toEqual({ channelId: 0, status: 0x24 });
    expect(describeStatus(0x24)).toMatch(/no more connections/);
  });
  it("CONNECTIONSTATE_REQUEST / DISCONNECT_REQUEST", () => {
    const c = encodeConnectionStateRequest({ channelId: 3, endpoint: NAT_HPAI });
    expect(hex(c)).toBe("06100207" + "0010" + "0300" + "0801000000000000");
    expect(decodeConnectionStateRequest(body(c)).channelId).toBe(3);
    const d = encodeDisconnectRequest({ channelId: 3, endpoint: NAT_HPAI });
    expect(hex(d)).toBe("06100209" + "0010" + "0300" + "0801000000000000");
    expect(decodeDisconnectRequest(body(d)).channelId).toBe(3);
    expect(hex(encodeDisconnectResponse({ channelId: 3, status: 0 }))).toBe("06100 20a0008 0300".replace(/ /g, ""));
  });
  it("TUNNELLING_REQUEST / ACK", () => {
    const cemi = Buffer.from("1100bce011010a03010081", "hex");
    const f = encodeTunnellingRequest({ channelId: 5, sequence: 9, cemi });
    expect(hex(f)).toBe("06100420" + "0015" + "04050900" + hex(cemi));
    expect(decodeTunnellingRequest(body(f))).toEqual({ channelId: 5, sequence: 9, cemi });
    const a = encodeTunnellingAck({ channelId: 5, sequence: 9, status: 0 });
    expect(hex(a)).toBe("06100421" + "000a" + "04050900");
    expect(decodeTunnellingAck(body(a))).toEqual({ channelId: 5, sequence: 9, status: 0 });
  });
  it("SEARCH_REQUEST", () => {
    const f = encodeSearchRequest({ protocol: 1, address: "192.168.1.2", port: 40000 });
    expect(hex(f)).toBe("06100201" + "000e" + "0801c0a801029c40");
    expect(decodeSearchRequest(body(f)).port).toBe(40000);
  });
  it("sequence numbers wrap to one octet", () => {
    expect(encodeTunnellingRequest({ channelId: 1, sequence: 256, cemi: Buffer.from([0x29]) })[8]).toBe(0);
  });
});

describe("KNXnet/IP strict validation", () => {
  const good = encodeTunnellingAck({ channelId: 1, sequence: 0, status: 0 });
  const withEdit = (edit: (b: Buffer) => void): Buffer => { const b = Buffer.from(good); edit(b); return b; };
  const code = (fn: () => unknown): string => { try { fn(); return "no-throw"; } catch (e) { return e instanceof KnxFrameError ? e.code : `foreign:${String(e)}`; } };

  it("rejects bad envelopes with specific codes", () => {
    expect(code(() => decodeFrame(Buffer.alloc(3)))).toBe("too_short");
    expect(code(() => decodeFrame(withEdit((b) => { b[0] = 5; })))).toBe("bad_header_size");
    expect(code(() => decodeFrame(withEdit((b) => { b[1] = 0x20; })))).toBe("unsupported_version");
    expect(code(() => decodeFrame(withEdit((b) => { b[5] = 0x0b; })))).toBe("length_mismatch");
    expect(code(() => decodeFrame(Buffer.concat([good, Buffer.from([0])])))).toBe("length_mismatch");
    expect(code(() => decodeFrame(withEdit((b) => { b[2] = 0x7f; })))).toBe("unknown_service");
    expect(code(() => decodeFrame(Buffer.alloc(MAX_FRAME_SIZE + 1)))).toBe("frame_too_large");
    expect(code(() => encodeFrame(0x0420, Buffer.alloc(MAX_FRAME_SIZE)))).toBe("frame_too_large");
  });
  it("rejects structurally invalid bodies", () => {
    expect(code(() => decodeTunnellingRequest(Buffer.from([4, 1, 0])))).toBe("too_short");
    expect(code(() => decodeTunnellingRequest(Buffer.from([4, 1, 0, 0])))).toBe("too_short"); // no cEMI
    expect(code(() => decodeTunnellingRequest(Buffer.from([5, 1, 0, 0, 0x29])))).toBe("bad_structure");
    expect(code(() => decodeTunnellingAck(Buffer.from([4, 1, 0])))).toBe("length_mismatch");
    expect(code(() => decodeConnectResponse(Buffer.from([1])))).toBe("too_short");
    expect(code(() => decodeConnectResponse(Buffer.from([1, 0, 0])))).toBe("length_mismatch");
    expect(code(() => decodeHpai(Buffer.from([8, 2, 0, 0, 0, 0, 0, 0]), 0))).toBe("unsupported_protocol");
    expect(code(() => decodeHpai(Buffer.from([7, 1, 0, 0, 0, 0, 0, 0]), 0))).toBe("bad_structure");
    expect(code(() => decodeHpai(Buffer.from([8, 1, 0]), 0))).toBe("too_short");
    expect(code(() => encodeHpai({ protocol: 1, address: "300.1.1.1", port: 1 }))).toBe("bad_structure");
    expect(code(() => encodeHpai({ protocol: 1, address: "1.1.1", port: 1 }))).toBe("bad_structure");
    expect(code(() => encodeHpai({ protocol: 1, address: "1.1.1.1", port: 70000 }))).toBe("bad_structure");
    expect(code(() => encodeConnectResponse({ channelId: 1, status: 0 }))).toBe("bad_structure");
  });
  it("labels unknown status codes instead of inventing text", () => {
    expect(describeStatus(0x99)).toBe("unknown status 0x99");
  });
});

describe("KNXnet/IP fuzz", () => {
  const decoders: Array<[string, (b: Buffer) => unknown]> = [
    ["connect_request", decodeConnectRequest], ["connect_response", decodeConnectResponse],
    ["channel_request", decodeConnectionStateRequest], ["tunnelling_request", decodeTunnellingRequest],
    ["tunnelling_ack", decodeTunnellingAck], ["search_request", decodeSearchRequest],
  ];
  it("typed decoders only ever throw KnxFrameError on arbitrary bodies", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 6000; i++) {
      const b = rng.bytes(rng.int(32));
      for (const [name, fn] of decoders) {
        try { fn(b); } catch (e) { expect(e, name).toBeInstanceOf(KnxFrameError); }
      }
    }
  });
  it("decodeFrame only ever throws KnxFrameError, including for mutated valid frames", () => {
    const rng = makeRng(99);
    const seeds = [
      encodeConnectRequest({ controlEndpoint: NAT_HPAI, dataEndpoint: NAT_HPAI, layer: 2 }),
      encodeTunnellingRequest({ channelId: 1, sequence: 3, cemi: Buffer.from("2900bce011010a03010081", "hex") }),
      encodeSearchRequest(NAT_HPAI),
    ];
    for (let i = 0; i < 10000; i++) {
      const m = Buffer.from(seeds[rng.int(seeds.length)]!);
      for (let k = 0, n = 1 + rng.int(3); k < n; k++) m[rng.int(m.length)] = rng.int(256);
      const cut = rng.int(4) === 0 ? m.subarray(0, rng.int(m.length)) : m;
      try { decodeFrame(cut); } catch (e) { expect(e).toBeInstanceOf(KnxFrameError); }
    }
  });
  it("every service type has a distinct code", () => {
    expect(new Set(Object.values(ServiceType)).size).toBe(Object.values(ServiceType).length);
  });
});
