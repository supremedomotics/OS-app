import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { createMrpTcpTransport } from "./apple-tv-mrp-transport.js";
import { encodeVarint } from "./apple-tv-mrp-protobuf.js";

// A real TCP server on loopback playing the "Apple TV" side — genuine socket I/O and
// genuine varint framing, not a mocked stream. Verifies the transport module against
// real network behavior (partial reads, multiple frames in one packet, etc).
function startFakeMrpServer(onConnection: (sock: Socket) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(onConnection);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe("AppleTvMrpTransport (real TCP loopback)", () => {
  let server: Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it("frame encode/decode round-trips a single message", async () => {
    const received: Buffer[] = [];
    const { server: s, port } = await startFakeMrpServer((sock) => {
      sock.on("data", (chunk) => sock.write(chunk)); // echo raw framed bytes back
    });
    server = s;

    const transport = createMrpTcpTransport("127.0.0.1", port);
    await transport.connect();
    const gotMessage = new Promise<Buffer>((resolve) => transport.onMessage(resolve));
    transport.send(Buffer.from("hello mrp"));
    const echoed = await gotMessage;
    expect(echoed.toString()).toBe("hello mrp");
    transport.disconnect();
  });

  it("handles a frame split across multiple TCP reads (partial frame)", async () => {
    let clientSock: Socket | null = null;
    const { server: s, port } = await startFakeMrpServer((sock) => {
      clientSock = sock;
    });
    server = s;

    const transport = createMrpTcpTransport("127.0.0.1", port);
    await transport.connect();
    const gotMessage = new Promise<Buffer>((resolve) => transport.onMessage(resolve));

    const payload = Buffer.from("split across reads");
    const frame = Buffer.concat([encodeVarint(payload.length), payload]);
    // Write byte-by-byte in two chunks to force the transport to buffer a partial frame.
    clientSock!.write(frame.subarray(0, 3));
    await new Promise((r) => setTimeout(r, 20));
    clientSock!.write(frame.subarray(3));

    const received = await gotMessage;
    expect(received.equals(payload)).toBe(true);
    transport.disconnect();
  });

  it("decodes multiple messages delivered in a single TCP packet", async () => {
    let clientSock: Socket | null = null;
    const { server: s, port } = await startFakeMrpServer((sock) => {
      clientSock = sock;
    });
    server = s;

    const transport = createMrpTcpTransport("127.0.0.1", port);
    await transport.connect();
    const received: Buffer[] = [];
    transport.onMessage((m) => received.push(m));

    const a = Buffer.from("first");
    const b = Buffer.from("second");
    const combined = Buffer.concat([
      encodeVarint(a.length),
      a,
      encodeVarint(b.length),
      b,
    ]);
    clientSock!.write(combined);
    await new Promise((r) => setTimeout(r, 30));

    expect(received.map((m) => m.toString())).toEqual(["first", "second"]);
    transport.disconnect();
  });

  it("calls the close handler when the peer disconnects", async () => {
    const { server: s, port } = await startFakeMrpServer((sock) => {
      sock.end();
    });
    server = s;

    const transport = createMrpTcpTransport("127.0.0.1", port);
    const closed = new Promise<Error | null>((resolve) => transport.onClose(resolve));
    await transport.connect();
    await closed;
    expect(transport.connected).toBe(false);
  });

  it("does not throw or deliver a message for a malformed (truncated) frame that never completes", async () => {
    let clientSock: Socket | null = null;
    const { server: s, port } = await startFakeMrpServer((sock) => {
      clientSock = sock;
    });
    server = s;

    const transport = createMrpTcpTransport("127.0.0.1", port);
    await transport.connect();
    let called = false;
    transport.onMessage(() => {
      called = true;
    });
    // Claims a 1000-byte payload but sends only 5 — the transport must simply wait,
    // never throw and never dispatch a partial message.
    clientSock!.write(Buffer.concat([encodeVarint(1000), Buffer.from("short")]));
    await new Promise((r) => setTimeout(r, 30));
    expect(called).toBe(false);
    transport.disconnect();
  });

  it("encrypts frames once enableEncryption is called and decrypts incoming frames symmetrically", async () => {
    // A trivial symmetric "session" for the purpose of proving the transport actually
    // routes through encrypt()/decrypt() rather than sending plaintext once enabled.
    let outCounter = 0;
    let inCounter = 0;
    const key = Buffer.from("k".repeat(32));
    const xor = (buf: Buffer) => Buffer.from(buf.map((b, i) => b ^ key[i % key.length]!));
    const session = {
      encrypt: (pt: Buffer) => {
        outCounter++;
        return xor(pt);
      },
      decrypt: (ct: Buffer) => {
        inCounter++;
        return xor(ct);
      },
    };

    const { server: s, port } = await startFakeMrpServer((sock) => {
      sock.on("data", (chunk) => sock.write(chunk)); // echo raw bytes (still "encrypted" on the wire)
    });
    server = s;

    const transport = createMrpTcpTransport("127.0.0.1", port);
    await transport.connect();
    transport.enableEncryption(session);
    const gotMessage = new Promise<Buffer>((resolve) => transport.onMessage(resolve));
    transport.send(Buffer.from("secret command"));
    const decoded = await gotMessage;
    expect(decoded.toString()).toBe("secret command");
    expect(outCounter).toBe(1);
    expect(inCounter).toBe(1);
    transport.disconnect();
  });
});
