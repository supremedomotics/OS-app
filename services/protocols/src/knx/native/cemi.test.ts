import { describe, expect, it } from "vitest";
import { parseGroupAddress, parseIndividualAddress } from "./address.js";
import { CemiMessageCode, decodeCemi, encodeGroupCemi, KnxCemiError } from "./cemi.js";
import { makeRng } from "./test-support.js";

const src = parseIndividualAddress("1.1.1");
const ga = parseGroupAddress("1/2/3");

describe("cEMI golden vectors", () => {
  it("encodes a 1-bit GroupValueWrite(ON) as the canonical L_Data.req", () => {
    const b = encodeGroupCemi({ source: src, destination: ga, service: "write", data: { kind: "short", value: 1 } });
    expect(b.toString("hex")).toBe("1100bce011010a03010081");
  });
  it("encodes a 1-byte GroupValueWrite (DPT5 100%)", () => {
    const b = encodeGroupCemi({ source: src, destination: ga, service: "write", data: { kind: "bytes", bytes: Buffer.from([0xff]) } });
    expect(b.toString("hex")).toBe("1100bce011010a03020080ff");
  });
  it("encodes GroupValueRead and GroupValueResponse", () => {
    expect(encodeGroupCemi({ source: src, destination: ga, service: "read" }).toString("hex")).toBe("1100bce011010a03010000");
    expect(encodeGroupCemi({ source: src, destination: ga, service: "response", data: { kind: "short", value: 0 } }).toString("hex")).toBe("1100bce011010a03010040");
  });
  it("decodes an L_Data.ind group write with short and long data", () => {
    const f = decodeCemi(Buffer.from("2900bce011010a03010081", "hex"));
    expect(f.messageCode).toBe(CemiMessageCode.L_DATA_IND);
    expect(f.destination).toBe(ga);
    expect(f.group).toEqual({ service: "write", data: { kind: "short", value: 1 } });
    const g = decodeCemi(Buffer.from("2900bce011010a030300800fa0", "hex"));
    expect(g.group).toEqual({ service: "write", data: { kind: "bytes", bytes: Buffer.from([0x0f, 0xa0]) } });
  });
  it("skips additional information", () => {
    const f = decodeCemi(Buffer.from("2902aabb" + "bce011010a03010081", "hex"));
    expect(f.group?.service).toBe("write");
  });
  it("reports a failed confirmation", () => {
    expect(decodeCemi(Buffer.from("2e00bde011010a03010081", "hex")).confirmError).toBe(true);
    expect(decodeCemi(Buffer.from("2e00bce011010a03010081", "hex")).confirmError).toBe(false);
  });
  it("does not parse a group service for individually-addressed telegrams", () => {
    // ctrl2 = 0x60: individual destination, hop 6; A_DeviceDescriptor_Read
    const f = decodeCemi(Buffer.from("2900bc6011011101010300", "hex"));
    expect(f.destinationIsGroup).toBe(false);
    expect(f.group).toBeNull();
  });
  it("does not misread a numbered/control TPCI as a group service", () => {
    // b0=0x40: numbered data packet TPCI, not UDP
    expect(decodeCemi(Buffer.from("2900bce011010a03014081", "hex")).group).toBeNull();
  });
});

describe("cEMI strict validation", () => {
  it("rejects unsupported message codes with a typed error", () => {
    expect(() => decodeCemi(Buffer.from("fc00", "hex"))).toThrow(expect.objectContaining({ code: "unsupported_message_code" }));
  });
  it("rejects truncated and length-inconsistent frames", () => {
    expect(() => decodeCemi(Buffer.alloc(0))).toThrow(KnxCemiError);
    expect(() => decodeCemi(Buffer.from("2900bce011010a", "hex"))).toThrow(expect.objectContaining({ code: "too_short" }));
    expect(() => decodeCemi(Buffer.from("2900bce011010a0301", "hex"))).toThrow(expect.objectContaining({ code: "length_mismatch" }));
    expect(() => decodeCemi(Buffer.from("2900bce011010a0301008100", "hex"))).toThrow(expect.objectContaining({ code: "length_mismatch" }));
    expect(() => decodeCemi(Buffer.from("2900bce011010a03020081", "hex"))).toThrow(expect.objectContaining({ code: "length_mismatch" }));
  });
  it("rejects a GroupValueRead that carries data", () => {
    expect(() => decodeCemi(Buffer.from("2900bce011010a0302000000", "hex"))).toThrow(expect.objectContaining({ code: "bad_structure" }));
  });
  it("rejects invalid encoder input", () => {
    const base = { source: src, destination: ga };
    expect(() => encodeGroupCemi({ ...base, service: "write" })).toThrow(KnxCemiError);
    expect(() => encodeGroupCemi({ ...base, service: "read", data: { kind: "short", value: 0 } })).toThrow(KnxCemiError);
    expect(() => encodeGroupCemi({ ...base, service: "write", data: { kind: "short", value: 64 } })).toThrow(KnxCemiError);
    expect(() => encodeGroupCemi({ ...base, service: "write", data: { kind: "bytes", bytes: Buffer.alloc(15) } })).toThrow(KnxCemiError);
    expect(() => encodeGroupCemi({ ...base, service: "write", data: { kind: "bytes", bytes: Buffer.alloc(0) } })).toThrow(KnxCemiError);
    expect(() => encodeGroupCemi({ ...base, service: "read", hopCount: 8 })).toThrow(KnxCemiError);
  });
});

describe("cEMI properties", () => {
  it("encode→decode round-trips for random valid group telegrams", () => {
    const rng = makeRng(0xc0ffee);
    for (let i = 0; i < 2000; i++) {
      const service = (["read", "response", "write"] as const)[rng.int(3)]!;
      const data = service === "read" ? null : rng.int(2) === 0
        ? ({ kind: "short", value: rng.int(64) } as const)
        : ({ kind: "bytes", bytes: rng.bytes(1 + rng.int(14)) } as const);
      const input = { source: rng.int(0x10000), destination: rng.int(0x10000), service, data, hopCount: rng.int(8), messageCode: CemiMessageCode.L_DATA_IND };
      const f = decodeCemi(encodeGroupCemi(input));
      expect(f.source).toBe(input.source);
      expect(f.destination).toBe(input.destination);
      expect(f.hopCount).toBe(input.hopCount);
      expect(f.group).toEqual({ service, data });
    }
  });
  it("never throws anything but KnxCemiError on arbitrary bytes, and never hangs", () => {
    const rng = makeRng(42);
    for (let i = 0; i < 20000; i++) {
      const buf = rng.bytes(rng.int(40));
      try { decodeCemi(buf); } catch (e) { expect(e).toBeInstanceOf(KnxCemiError); }
    }
  });
});
