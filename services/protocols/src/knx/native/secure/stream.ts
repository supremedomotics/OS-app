/**
 * KNXnet/IP stream deframer for TCP (§ KNX Secure — transport). TCP delivers a byte stream, so frames may arrive fragmented or merged
 * (TSSK 2.5.2 / 2.5.3 exercise exactly this). Framing is driven only by the common header every KNXnet/IP frame starts with
 * (header size 06h, version 10h, 2-octet service, 2-octet TOTAL length), which is normative in every document read.
 *
 * What is NOT verified (Core v2, 3/8/2, is absent from the supplied bundle): the Core's own rules for which malformed headers
 * close a TCP connection and for idle/receive timeouts. This deframer therefore applies the conservative decision D below.
 *   D: a header whose size/version octets are wrong, or whose total length is < 6 or above `maxFrameSize`, is a protocol violation —
 *      the caller must close the connection (it cannot resynchronise a byte stream safely).
 */
export class KnxStreamError extends Error {
  constructor(readonly code: "bad_header" | "bad_length" | "frame_too_large", message: string) {
    super(message);
    this.name = "KnxStreamError";
  }
}

export class KnxStreamDeframer {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly maxFrameSize = 8192) {}

  get pendingBytes(): number { return this.buf.length; }

  /** Appends received bytes; returns every complete frame now available (possibly none, possibly several). */
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      if (this.buf.length < 6) break;
      if (this.buf[0] !== 0x06) throw new KnxStreamError("bad_header", `header size octet 0x${this.buf[0]!.toString(16)} != 0x06`);
      if (this.buf[1] !== 0x10) throw new KnxStreamError("bad_header", `protocol version 0x${this.buf[1]!.toString(16)} != 0x10`);
      const total = this.buf.readUInt16BE(4);
      if (total < 6) throw new KnxStreamError("bad_length", `total length ${total} < 6`);
      if (total > this.maxFrameSize) throw new KnxStreamError("frame_too_large", `total length ${total} exceeds ${this.maxFrameSize}`);
      if (this.buf.length < total) break;
      frames.push(Buffer.from(this.buf.subarray(0, total)));
      this.buf = this.buf.subarray(total);
    }
    if (this.buf.length === 0) this.buf = Buffer.alloc(0);
    return frames;
  }
}
