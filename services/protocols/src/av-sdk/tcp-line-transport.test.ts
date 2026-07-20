import { EventEmitter } from "node:events";
import { createServer, Socket, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TcpLineTransport, type TcpLink } from "./tcp-line-transport.js";

/**
 * A tiny in-process line-delimited TCP server: tracks every accepted socket, echoes each
 * received line back prefixed "ECHO:", and lets a test push an unsolicited line at any time.
 * Real `net` sockets throughout, matching this repo's convention (avr-driver.test.ts's
 * `startFakeAvr()`, heos-driver.test.ts's `startFakeHeos()`) — not a mock of the transport.
 */
function startFakeServer(delimiter: string): Promise<{ server: Server; port: number; received: string[]; sockets: Set<Socket> }> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split(delimiter);
        buf = parts.pop() ?? "";
        for (const line of parts) {
          received.push(line);
          sock.write(`ECHO:${line}${delimiter}`);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, received, sockets });
    });
  });
}

describe("TcpLineTransport (§ Universal AV SDK) — in-process TCP", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects, runs onConnect, and dispatches received lines via onLine with full context", async () => {
    const fake = await startFakeServer("\n");
    const lines: { key: string; host: string; port: number; line: string }[] = [];
    const transport = new TcpLineTransport({
      delimiter: "\n",
      onConnect: (_link, socket, host, port) => socket.write(`HELLO from ${host}:${port}\n`),
      onLine: (ctx, line) => lines.push({ key: ctx.key, host: ctx.host, port: ctx.port, line }),
    });

    const key = `127.0.0.1:${fake.port}`;
    transport.ensureLink(key, "127.0.0.1", fake.port);
    await vi.waitFor(() => expect(fake.received.length).toBeGreaterThan(0));
    expect(fake.received[0]).toContain("HELLO from 127.0.0.1");

    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
    expect(lines[0]).toEqual({ key, host: "127.0.0.1", port: fake.port, line: `ECHO:HELLO from 127.0.0.1:${fake.port}` });

    transport.disconnectAll();
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("ensureLink reuses a still-connecting link — concurrent callers never race a duplicate connection", async () => {
    const fake = await startFakeServer("\n");
    const transport = new TcpLineTransport({ delimiter: "\n", onConnect: () => {}, onLine: () => {} });
    const key = `127.0.0.1:${fake.port}`;

    // Two "concurrent" callers (e.g. bind() then an immediate command()) before the first
    // connection has resolved — must return the SAME link object, not open a second socket.
    const a = transport.ensureLink(key, "127.0.0.1", fake.port);
    const b = transport.ensureLink(key, "127.0.0.1", fake.port);
    expect(a).toBe(b);

    await vi.waitFor(() => expect(fake.sockets.size).toBe(1));
    transport.disconnectAll();
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("reconnects with capped backoff after the socket drops, and onConnect runs again", async () => {
    vi.useFakeTimers();
    const fake = await startFakeServer("\n");
    let connects = 0;
    const transport = new TcpLineTransport({
      delimiter: "\n",
      reconnectBaseMs: 50,
      reconnectMaxMs: 50,
      onConnect: () => { connects++; },
      onLine: () => {},
    });
    const key = `127.0.0.1:${fake.port}`;
    transport.ensureLink(key, "127.0.0.1", fake.port);
    await vi.waitFor(() => expect(connects).toBe(1));
    expect(fake.sockets.size).toBe(1);

    for (const s of fake.sockets) s.destroy();
    await vi.waitFor(() => expect(fake.sockets.size).toBe(0));
    expect(transport.get(key)?.ready).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(fake.sockets.size).toBe(1));
    await vi.waitFor(() => expect(connects).toBe(2));

    transport.disconnectAll();
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("releaseKey tears down exactly one key's socket without touching a sibling key", async () => {
    const fakeA = await startFakeServer("\n");
    const fakeB = await startFakeServer("\n");
    const transport = new TcpLineTransport({ delimiter: "\n", onConnect: () => {}, onLine: () => {} });
    const keyA = `127.0.0.1:${fakeA.port}`;
    const keyB = `127.0.0.1:${fakeB.port}`;
    transport.ensureLink(keyA, "127.0.0.1", fakeA.port);
    transport.ensureLink(keyB, "127.0.0.1", fakeB.port);
    await vi.waitFor(() => expect(fakeA.sockets.size).toBe(1));
    await vi.waitFor(() => expect(fakeB.sockets.size).toBe(1));

    transport.releaseKey(keyA);
    expect(transport.get(keyA)).toBeUndefined();
    expect(transport.get(keyB)).toBeDefined();
    await vi.waitFor(() => expect(fakeA.sockets.size).toBe(0));
    expect(fakeB.sockets.size).toBe(1); // untouched

    // Idempotent — releasing an already-gone (or never-existed) key is a safe no-op.
    expect(() => transport.releaseKey(keyA)).not.toThrow();
    expect(() => transport.releaseKey("never-bound")).not.toThrow();

    transport.disconnectAll();
    await Promise.all([
      new Promise<void>((r) => fakeA.server.close(() => r())),
      new Promise<void>((r) => fakeB.server.close(() => r())),
    ]);
  });

  it("disconnectAll tears down every link and clears the pool", async () => {
    const fakeA = await startFakeServer("\n");
    const fakeB = await startFakeServer("\n");
    const transport = new TcpLineTransport({ delimiter: "\n", onConnect: () => {}, onLine: () => {} });
    const keyA = `127.0.0.1:${fakeA.port}`;
    const keyB = `127.0.0.1:${fakeB.port}`;
    transport.ensureLink(keyA, "127.0.0.1", fakeA.port);
    transport.ensureLink(keyB, "127.0.0.1", fakeB.port);
    await vi.waitFor(() => expect(fakeA.sockets.size).toBe(1));
    await vi.waitFor(() => expect(fakeB.sockets.size).toBe(1));

    transport.disconnectAll();
    expect(transport.get(keyA)).toBeUndefined();
    expect(transport.get(keyB)).toBeUndefined();
    await vi.waitFor(() => expect(fakeA.sockets.size).toBe(0));
    await vi.waitFor(() => expect(fakeB.sockets.size).toBe(0));

    await Promise.all([
      new Promise<void>((r) => fakeA.server.close(() => r())),
      new Promise<void>((r) => fakeB.server.close(() => r())),
    ]);
  });

  it("diagnosticsFor reflects disconnected → connecting-or-connected status, and never returns null", async () => {
    const fake = await startFakeServer("\n");
    const transport = new TcpLineTransport({ delimiter: "\n", onConnect: () => {}, onLine: () => {} });
    const key = `127.0.0.1:${fake.port}`;

    // No link yet — status "disconnected", a real (empty) tracker, not null.
    const before = transport.diagnosticsFor(key);
    expect(before.status).toBe("disconnected");
    expect(before.diagnostics).toBeDefined();

    transport.ensureLink(key, "127.0.0.1", fake.port);
    await vi.waitFor(() => expect(transport.diagnosticsFor(key).status).toBe("connected"));

    transport.disconnectAll();
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("an inbound flood with no delimiter overflows the buffer and reports it via onLog, without crashing", async () => {
    const fake = await startFakeServer("\n");
    const logs: { level: string; message: string }[] = [];
    const transport = new TcpLineTransport({
      delimiter: "\n",
      onConnect: () => {},
      onLine: () => {},
      onLog: (level, message) => logs.push({ level, message }),
    });
    const key = `127.0.0.1:${fake.port}`;
    transport.ensureLink(key, "127.0.0.1", fake.port);
    await vi.waitFor(() => expect(fake.sockets.size).toBe(1));

    // The server never sends a delimiter — flood past the 64KB LineAccumulator cap.
    for (const sock of fake.sockets) sock.write("x".repeat(70 * 1024));
    await vi.waitFor(() =>
      expect(logs.some((l) => l.level === "error" && l.message.includes("inbound buffer overflowed"))).toBe(true),
    );
    expect(logs.find((l) => l.message.includes("overflowed"))?.message).toContain(`127.0.0.1:${fake.port}`);

    transport.disconnectAll();
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("a synthetic fake socket that fires 'connect' at the earliest possible microtask still finds the link already present in the pool", async () => {
    // A real TCP socket's "connect" always takes at least one macrotask (an actual OS
    // handshake, or an immediate OS-level failure delivered via the I/O callback queue) — it
    // can NEVER fire before ensureLink() has already returned and inserted the link into the
    // pool. A hand-written fake socket CAN fire earlier than any real socket ever could — at
    // the very next microtask, before openSocket() has even finished attaching its "data"/
    // "close"/"error" handlers in a hypothetical reordering. This proves insertion into the
    // pool (`this.links.set(key, link)`) happens before any handler could possibly observe
    // it, using a fake more aggressive than real sockets can be, not one that's impossible.
    class MicrotaskConnectSocket extends EventEmitter {
      connecting = false;
      destroyed = false;
      write = vi.fn();
      destroy = vi.fn();
      setEncoding = vi.fn();
    }
    let sawLinkDuringConnect: TcpLink | undefined;
    const sock = new MicrotaskConnectSocket();
    const transport = new TcpLineTransport({
      delimiter: "\n",
      createSocket: () => {
        void Promise.resolve().then(() => sock.emit("connect"));
        return sock as unknown as Socket;
      },
      onConnect: () => {
        sawLinkDuringConnect = transport.get("k");
      },
      onLine: () => {},
    });

    transport.ensureLink("k", "127.0.0.1", 9);
    await Promise.resolve(); // flush the microtask queue past our own .then()
    await Promise.resolve();
    // By the time onConnect ran, the link must already have been resolvable via get() —
    // proof `this.links.set(key, link)` happened before openSocket() attached handlers.
    expect(sawLinkDuringConnect).toBeDefined();
    expect(sawLinkDuringConnect).toBe(transport.get("k"));
  });
});
