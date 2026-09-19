import type { Duplex } from "node:stream";
import { decodeVarint, encodeVarint } from "./protobuf-wire.js";

/**
 * (§2 Phase 2) Length-prefixed message framing shared by both the control channel
 * (remotemessage.proto) and the pairing channel (polo.proto) — both speak "varint
 * length, then that many bytes of one protobuf message" over a `net.Socket`/
 * `tls.TLSSocket`. Injectable over any `Duplex` so tests can drive it without a real
 * socket or real TLS (§34 Test Doubles) — a fake in-memory duplex pair is both faster
 * and more deterministic than spinning up real TLS in every unit test; real TLS
 * connection setup is exercised separately once a real device/certificate is available
 * (§13, deferred — see android-tv-remote-v2-transport.ts's doc comment on the
 * certificate-generation gap).
 */

/** No legitimate remotemessage.proto/polo.proto message this transport sends or
 * receives is anywhere near this size — a length prefix claiming more is either
 * corrupt or hostile, not a big-but-real message, so it's rejected outright rather
 * than buffered while waiting for bytes that may never come (§10 "never allow a
 * malicious or corrupted length field to allocate unbounded memory"). */
export const MAX_FRAME_SIZE = 1 << 20; // 1 MiB

export class FramedSocket {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly listeners = new Set<(msg: Buffer) => void>();
  private readonly errorListeners = new Set<(err: Error) => void>();

  constructor(private readonly socket: Duplex) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err: Error) => {
      for (const l of this.errorListeners) l(err);
    });
  }

  send(message: Buffer): void {
    this.socket.write(Buffer.concat([encodeVarint(message.length), message]));
  }

  onMessage(listener: (msg: Buffer) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onError(listener: (err: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  destroy(): void {
    this.listeners.clear();
    this.errorListeners.clear();
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      let len: number;
      let afterLen: number;
      try {
        [len, afterLen] = decodeVarint(this.buf, 0);
      } catch (err) {
        // A length-prefix varint needs at most 5 bytes (our codec caps at 32-bit values —
        // see protobuf-wire.ts). Fewer than that and truncation is the ordinary "wait for
        // more data" case; 5+ bytes that still won't decode is a genuinely malformed
        // frame (§12 "malformed protocol message") — the connection can't be trusted to
        // resynchronize, so this is reported as an error rather than silently stalling
        // forever waiting for bytes that will never make it valid.
        if (this.buf.length < 5) return;
        for (const l of this.errorListeners) l(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (len > MAX_FRAME_SIZE) {
        for (const l of this.errorListeners) {
          l(new Error(`protobuf-wire: frame size ${len} exceeds MAX_FRAME_SIZE (${MAX_FRAME_SIZE})`));
        }
        return;
      }
      if (afterLen + len > this.buf.length) return; // not enough bytes yet for the full message
      const message = this.buf.subarray(afterLen, afterLen + len);
      this.buf = this.buf.subarray(afterLen + len);
      for (const l of this.listeners) l(message);
      if (this.buf.length === 0) return;
    }
  }
}
