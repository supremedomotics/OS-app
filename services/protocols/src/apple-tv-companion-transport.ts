/**
 * Companion protocol transport (§ Apple TV Phase 3). A real `net.Socket` wrapper
 * matching pyatv's `CompanionConnection` (`pyatv/protocols/companion/connection.py`,
 * verified against the real source this phase): each frame is
 * `[1-byte frame type][3-byte big-endian length][payload]`; once encryption is enabled,
 * `payload` is ChaCha20-Poly1305-sealed with the FRAME HEADER used as AAD (Additional
 * Authenticated Data) — verified: `header = bytes([frame_type]) + length.to_bytes(3,
 * "big")`, then `chacha.encrypt(data, aad=header)`. This differs from MRP's framing in
 * two ways: a typed frame header (not just a bare varint length) and AAD-bound
 * encryption (MRP's `Chacha20Cipher8byteNonce` never uses AAD) — kept as its own module
 * rather than generalizing `apple-tv-mrp-transport.ts`, since forcing one shared
 * abstraction over two genuinely different wire formats would obscure both.
 */
import { Socket } from "node:net";

/** Verified against `pyatv/protocols/companion/connection.py`'s `FrameType` enum —
 * only the values this driver's scoped Companion usage (pairing + app commands) needs. */
export const CompanionFrameType = {
  PS_Start: 3,
  PS_Next: 4,
  PV_Start: 5,
  PV_Next: 6,
  E_OPACK: 8,
} as const;
export type CompanionFrameTypeValue = (typeof CompanionFrameType)[keyof typeof CompanionFrameType];

export interface CompanionSession {
  encrypt(plaintext: Buffer, aad: Buffer): Buffer;
  decrypt(sealed: Buffer, aad: Buffer): Buffer;
}

export interface AppleTvCompanionTransport {
  connect(): Promise<void>;
  disconnect(): void;
  readonly connected: boolean;
  enableEncryption(session: CompanionSession): void;
  send(frameType: CompanionFrameTypeValue, payload: Buffer): void;
  onFrame(handler: (frameType: number, payload: Buffer) => void): void;
  onClose(handler: (err: Error | null) => void): void;
}

const HEADER_LENGTH = 4;
const AUTH_TAG_LENGTH = 16;

export function createCompanionTcpTransport(
  host: string,
  port: number,
  socketFactory: () => Socket = () => new Socket(),
): AppleTvCompanionTransport {
  let socket: Socket | null = null;
  let session: CompanionSession | null = null;
  let buffer = Buffer.alloc(0);
  const frameHandlers = new Set<(frameType: number, payload: Buffer) => void>();
  const closeHandlers = new Set<(err: Error | null) => void>();

  function handleData(chunk: Buffer): void {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < HEADER_LENGTH) return;
      const frameType = buffer[0]!;
      const length = buffer.readUIntBE(1, 3);
      if (buffer.length < HEADER_LENGTH + length) return;
      const header = buffer.subarray(0, HEADER_LENGTH);
      const framePayload = buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + length);
      buffer = buffer.subarray(HEADER_LENGTH + length);
      const payload = session && framePayload.length > 0 ? session.decrypt(framePayload, header) : framePayload;
      for (const h of frameHandlers) h(frameType, payload);
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
          if (socket === null) reject(err);
        });
        s.once("connect", () => {
          socket = s;
          resolve();
        });
        s.on("data", handleData);
        s.on("close", (hadError) => {
          socket = null;
          for (const h of closeHandlers) h(hadError ? new Error("companion: socket closed with error") : null);
        });
        s.connect(port, host);
      });
    },
    disconnect(): void {
      socket?.destroy();
      socket = null;
      buffer = Buffer.alloc(0);
    },
    enableEncryption(newSession: CompanionSession): void {
      session = newSession;
    },
    send(frameType: CompanionFrameTypeValue, payload: Buffer): void {
      if (!socket) throw new Error("companion: not connected");
      // Verified: length includes the auth tag once encryption is enabled and there's
      // real payload to seal (an empty payload is sent in the clear, matching pyatv).
      const payloadLength = session && payload.length > 0 ? payload.length + AUTH_TAG_LENGTH : payload.length;
      const header = Buffer.concat([Buffer.from([frameType]), lengthBE3(payloadLength)]);
      const wire = session && payload.length > 0 ? session.encrypt(payload, header) : payload;
      socket.write(Buffer.concat([header, wire]));
    },
    onFrame(handler: (frameType: number, payload: Buffer) => void): void {
      frameHandlers.add(handler);
    },
    onClose(handler: (err: Error | null) => void): void {
      closeHandlers.add(handler);
    },
  };
}

function lengthBE3(n: number): Buffer {
  const b = Buffer.alloc(3);
  b.writeUIntBE(n, 0, 3);
  return b;
}
