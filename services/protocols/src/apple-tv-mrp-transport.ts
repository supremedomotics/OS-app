/**
 * MRP network transport (§ Apple TV Phase 2B). A real `net.Socket` wrapper doing exactly
 * what pyatv's `MrpConnection` does (`pyatv/protocols/mrp/connection.py`, verified against
 * the real source this phase): each `ProtocolMessage` is framed as
 * `varint(len(payload)) + payload`, where `payload` is the raw serialized protobuf bytes
 * until `enableEncryption()` is called, after which every outgoing payload is
 * ChaCha20-Poly1305-sealed (via the session `HapSession` from `hapPairVerify(...)
 * .deriveSession(...)`) and every incoming payload is opened the same way — encryption
 * wraps the OUTER varint-framed payload, the length prefix itself stays in the clear
 * (verified: `data = write_variant(len(serialized)) + serialized` where `serialized` is
 * already-encrypted when a cipher is set).
 *
 * Deliberately separated from apple-tv-mrp-protobuf.ts (wire codec) and apple-tv-driver.ts
 * (Supreme device/capability state) — this file knows only bytes-in/bytes-out and framing,
 * never a ProtocolMessage's semantic content.
 */
import { Socket } from "node:net";
import type { HapSession } from "./apple-tv-hap-pairing.js";
import { encodeVarint, decodeVarint } from "./apple-tv-mrp-protobuf.js";

export interface AppleTvMrpTransport {
  connect(): Promise<void>;
  disconnect(): void;
  readonly connected: boolean;
  /** Switch from plaintext to an encrypted session — called once, right after HAP
   * pair-verify completes. Sending/receiving before this call is plaintext (only the
   * DEVICE_INFO/CRYPTO_PAIRING exchange happens before encryption is enabled). */
  enableEncryption(session: HapSession): void;
  send(payload: Buffer): void;
  onMessage(handler: (payload: Buffer) => void): void;
  onClose(handler: (err: Error | null) => void): void;
}

/** A real TCP-backed transport. `socketFactory` is injectable for tests (a deterministic
 * fake MRP peer); production uses the default `() => new Socket()`. */
export function createMrpTcpTransport(
  host: string,
  port: number,
  socketFactory: () => Socket = () => new Socket(),
): AppleTvMrpTransport {
  let socket: Socket | null = null;
  let session: HapSession | null = null;
  let buffer = Buffer.alloc(0);
  const messageHandlers = new Set<(payload: Buffer) => void>();
  const closeHandlers = new Set<(err: Error | null) => void>();

  function handleData(chunk: Buffer): void {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      let length: number;
      let next: number;
      try {
        ({ value: length, next } = decodeVarint(buffer, 0));
      } catch {
        return; // not enough bytes yet for even the length prefix
      }
      if (buffer.length - next < length) return; // wait for the rest of this frame
      const framePayload = buffer.subarray(next, next + length);
      buffer = buffer.subarray(next + length);
      const payload = session ? session.decrypt(framePayload) : framePayload;
      for (const h of messageHandlers) h(payload);
    }
  }

  return {
    get connected() {
      return socket !== null;
    },
    connect(): Promise<void> {
      return new Promise((resolve, reject) => {
        const s = socketFactory();
        s.once("error", (err) => {
          if (socket === null) reject(err); // only reject the initial connect attempt
        });
        s.once("connect", () => {
          socket = s;
          resolve();
        });
        s.on("data", handleData);
        s.on("close", (hadError) => {
          socket = null;
          for (const h of closeHandlers) h(hadError ? new Error("mrp: socket closed with error") : null);
        });
        s.connect(port, host);
      });
    },
    disconnect(): void {
      socket?.destroy();
      socket = null;
      buffer = Buffer.alloc(0);
    },
    enableEncryption(newSession: HapSession): void {
      session = newSession;
    },
    send(payload: Buffer): void {
      if (!socket) throw new Error("mrp: not connected");
      const wire = session ? session.encrypt(payload) : payload;
      socket.write(Buffer.concat([encodeVarint(wire.length), wire]));
    },
    onMessage(handler: (payload: Buffer) => void): void {
      messageHandlers.add(handler);
    },
    onClose(handler: (err: Error | null) => void): void {
      closeHandlers.add(handler);
    },
  };
}
