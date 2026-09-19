import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { FramedSocket, MAX_FRAME_SIZE } from "./framed-socket.js";

/** An in-memory loopback pair: writing to `a` is readable from `b` and vice versa —
 * lets tests exercise real framing/chunking behavior without a real socket. */
function loopbackPair(): [Duplex, Duplex] {
  const a = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      b.push(chunk);
      cb();
    },
  });
  const b = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      a.push(chunk);
      cb();
    },
  });
  return [a, b];
}

describe("FramedSocket — varint length-prefixed framing", () => {
  it("delivers one message sent in one write", async () => {
    const [a, b] = loopbackPair();
    const fa = new FramedSocket(a);
    const fb = new FramedSocket(b);
    const received: Buffer[] = [];
    fb.onMessage((m) => received.push(m));
    fa.send(Buffer.from("hello"));
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
    expect(received[0]!.toString()).toBe("hello");
  });

  it("reassembles a message split across multiple TCP chunks", async () => {
    const [a, b] = loopbackPair();
    new FramedSocket(a); // wraps `a` so pushes land through the loopback's write path
    const fb = new FramedSocket(b);
    const received: Buffer[] = [];
    fb.onMessage((m) => received.push(m));

    const payload = Buffer.from("split across chunks");
    const { encodeVarint } = await import("./protobuf-wire.js");
    const framed = Buffer.concat([encodeVarint(payload.length), payload]);
    // Push byte-by-byte directly at `b`'s read side to simulate fragmented delivery.
    for (const byte of framed) b.push(Buffer.from([byte]));
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
    expect(received[0]!.toString()).toBe("split across chunks");
  });

  it("delivers two messages sent back-to-back without merging them", async () => {
    const [a, b] = loopbackPair();
    const fa = new FramedSocket(a);
    const fb = new FramedSocket(b);
    const received: Buffer[] = [];
    fb.onMessage((m) => received.push(m));
    fa.send(Buffer.from("first"));
    fa.send(Buffer.from("second"));
    await new Promise((r) => setImmediate(r));
    expect(received.map((m) => m.toString())).toEqual(["first", "second"]);
  });

  it("§ malformed message: a corrupted length prefix reports an error, not a silent hang", async () => {
    const [, b] = loopbackPair();
    const fb = new FramedSocket(b);
    const errors: Error[] = [];
    fb.onError((e) => errors.push(e));
    // 6 bytes, all with the varint continuation bit set — never terminates, longer than
    // the 5-byte cap this codec allows for a 32-bit value.
    b.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    await new Promise((r) => setImmediate(r));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("§10 oversized frame: a length prefix over MAX_FRAME_SIZE errors instead of buffering forever", async () => {
    const [, b] = loopbackPair();
    const fb = new FramedSocket(b);
    const errors: Error[] = [];
    fb.onError((e) => errors.push(e));
    const { encodeVarint } = await import("./protobuf-wire.js");
    b.push(encodeVarint(MAX_FRAME_SIZE + 1));
    await new Promise((r) => setImmediate(r));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/MAX_FRAME_SIZE/);
  });

  it("destroy() stops delivering further messages", async () => {
    const [a, b] = loopbackPair();
    const fa = new FramedSocket(a);
    const fb = new FramedSocket(b);
    const received: Buffer[] = [];
    fb.onMessage((m) => received.push(m));
    fb.destroy();
    fa.send(Buffer.from("after destroy"));
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(0);
  });

  describe("§1 Phase 2 gate — framing regression coverage", () => {
    it("reassembles a message whose multi-byte length VARINT header is itself split across reads", async () => {
      const [, b] = loopbackPair();
      const fb = new FramedSocket(b);
      const received: Buffer[] = [];
      fb.onMessage((m) => received.push(m));

      const { encodeVarint } = await import("./protobuf-wire.js");
      const payload = Buffer.alloc(200, 0x61); // length 200 needs a 2-byte varint header
      const lenBytes = encodeVarint(payload.length);
      expect(lenBytes.length).toBeGreaterThan(1);
      b.push(lenBytes.subarray(0, 1)); // first header byte only
      await new Promise((r) => setImmediate(r));
      expect(received).toHaveLength(0); // must not misinterpret a partial header as complete
      b.push(lenBytes.subarray(1)); // rest of header
      b.push(payload);
      await new Promise((r) => setImmediate(r));
      expect(received).toHaveLength(1);
      expect(received[0]!.equals(payload)).toBe(true);
    });

    it.each([1, 2, 7])("reassembles a payload delivered %i byte(s) at a time", async (chunkSize) => {
      const [, b] = loopbackPair();
      const fb = new FramedSocket(b);
      const received: Buffer[] = [];
      fb.onMessage((m) => received.push(m));

      const { encodeVarint } = await import("./protobuf-wire.js");
      const payload = Buffer.from("fragmented payload delivery test");
      const framed = Buffer.concat([encodeVarint(payload.length), payload]);
      for (let i = 0; i < framed.length; i += chunkSize) b.push(framed.subarray(i, i + chunkSize));
      await new Promise((r) => setImmediate(r));
      expect(received).toHaveLength(1);
      expect(received[0]!.equals(payload)).toBe(true);
    });

    it("decodes three coalesced messages (A+B+C in one TCP read) independently and in order", async () => {
      const [, b] = loopbackPair();
      const fb = new FramedSocket(b);
      const received: Buffer[] = [];
      fb.onMessage((m) => received.push(m));

      const { encodeVarint } = await import("./protobuf-wire.js");
      const frame = (s: string) => Buffer.concat([encodeVarint(s.length), Buffer.from(s)]);
      b.push(Buffer.concat([frame("A"), frame("BB"), frame("CCC")]));
      await new Promise((r) => setImmediate(r));
      expect(received.map((m) => m.toString())).toEqual(["A", "BB", "CCC"]);
    });

    it("reassembles a representative multi-field message split at every single byte boundary", async () => {
      const { encodeVarint } = await import("./protobuf-wire.js");
      const { encodeRemoteKeyInject } = await import("./remote-messages.js");
      const inner = encodeRemoteKeyInject(19); // DPAD_UP — a real, representative wire message
      const framed = Buffer.concat([encodeVarint(inner.length), inner]);

      for (let cut = 1; cut < framed.length; cut++) {
        const [, b] = loopbackPair();
        const fb = new FramedSocket(b);
        const received: Buffer[] = [];
        fb.onMessage((m) => received.push(m));
        b.push(framed.subarray(0, cut));
        b.push(framed.subarray(cut));
        await new Promise((r) => setImmediate(r));
        expect(received, `split at byte ${cut}/${framed.length}`).toHaveLength(1);
        expect(received[0]!.equals(inner), `split at byte ${cut}/${framed.length}`).toBe(true);
      }
    });

    it("a zero-length message (a legitimate empty protobuf message) decodes as an empty buffer, not an error", async () => {
      const [, b] = loopbackPair();
      const fb = new FramedSocket(b);
      const received: Buffer[] = [];
      const errors: Error[] = [];
      fb.onMessage((m) => received.push(m));
      fb.onError((e) => errors.push(e));
      const { encodeVarint } = await import("./protobuf-wire.js");
      b.push(encodeVarint(0));
      await new Promise((r) => setImmediate(r));
      expect(errors).toHaveLength(0);
      expect(received).toHaveLength(1);
      expect(received[0]!.length).toBe(0);
    });

    it("accepts a frame of exactly MAX_FRAME_SIZE (the boundary itself is legitimate)", async () => {
      const [, b] = loopbackPair();
      const fb = new FramedSocket(b);
      const received: Buffer[] = [];
      const errors: Error[] = [];
      fb.onMessage((m) => received.push(m));
      fb.onError((e) => errors.push(e));
      const { encodeVarint } = await import("./protobuf-wire.js");
      const payload = Buffer.alloc(MAX_FRAME_SIZE, 0x42);
      b.push(Buffer.concat([encodeVarint(payload.length), payload]));
      await new Promise((r) => setImmediate(r));
      expect(errors).toHaveLength(0);
      expect(received).toHaveLength(1);
      expect(received[0]!.length).toBe(MAX_FRAME_SIZE);
    });

    it("rejects MAX_FRAME_SIZE + 1 without ever allocating/buffering the claimed payload", async () => {
      const [, b] = loopbackPair();
      const fb = new FramedSocket(b);
      const errors: Error[] = [];
      fb.onError((e) => errors.push(e));
      const { encodeVarint } = await import("./protobuf-wire.js");
      // Only the length header arrives — a real attacker wouldn't necessarily send the
      // (huge) claimed payload at all. The error must fire from the header alone.
      b.push(encodeVarint(MAX_FRAME_SIZE + 1));
      await new Promise((r) => setImmediate(r));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/MAX_FRAME_SIZE/);
    });

    it("a truncated varint length (5 bytes, all continuation-bit set) errors instead of hanging — the >32-bit case", async () => {
      const [, b] = loopbackPair();
      const fb = new FramedSocket(b);
      const errors: Error[] = [];
      fb.onError((e) => errors.push(e));
      b.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f])); // 5th byte would push shift > 28
      await new Promise((r) => setImmediate(r));
      expect(errors.length).toBeGreaterThan(0);
    });

    it("a merely-truncated (not malformed) varint header waits for more bytes rather than erroring", async () => {
      const [, b] = loopbackPair();
      const fb = new FramedSocket(b);
      const received: Buffer[] = [];
      const errors: Error[] = [];
      fb.onMessage((m) => received.push(m));
      fb.onError((e) => errors.push(e));
      b.push(Buffer.from([0xff, 0xff])); // 2 continuation-bit bytes — could still complete
      await new Promise((r) => setImmediate(r));
      expect(errors).toHaveLength(0);
      expect(received).toHaveLength(0);
    });

    it("EOF/close after a partial frame does not leave it buffered indefinitely — no further delivery, no error storm", async () => {
      const [a, b] = loopbackPair();
      const fb = new FramedSocket(b);
      const received: Buffer[] = [];
      const errors: Error[] = [];
      fb.onMessage((m) => received.push(m));
      fb.onError((e) => errors.push(e));
      const { encodeVarint } = await import("./protobuf-wire.js");
      // Half a frame, then the connection just ends — the real-world "TV disappeared
      // mid-message" case (§9 malformed/partial-frame handling under connection loss).
      const partial = Buffer.concat([encodeVarint(50), Buffer.alloc(10)]);
      b.push(partial);
      a.destroy();
      await new Promise((r) => setImmediate(r));
      expect(received).toHaveLength(0);
      // No crash, no synthetic message, and destroy() remains safe to call afterward.
      expect(() => fb.destroy()).not.toThrow();
    });
  });
});
