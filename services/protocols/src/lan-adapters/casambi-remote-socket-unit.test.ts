import { describe, expect, it, vi } from "vitest";
import type { UdpTransport } from "@supreme/lan";
import { createCasambiRemoteSocketFactory } from "./casambi-remote-socket.js";

/** Fake-transport unit tests pinning the adapter's exact call mapping (the real, hardware-backed
 * end-to-end proof — a genuine `CasambiUdpEngine` running over a real `supreme-lan` server — is
 * `casambi-remote-socket.test.ts`). */
function fakeTransport(): UdpTransport & { sent: { data: Buffer; port: number; address: string }[] } {
  const messageListeners = new Set<(msg: Buffer, rinfo: { address: string; port: number }) => void>();
  const listeningListeners = new Set<() => void>();
  const sent: { data: Buffer; port: number; address: string }[] = [];
  return {
    sent,
    bind: vi.fn(async () => {
      for (const l of listeningListeners) l();
    }),
    send: vi.fn(async (data, port, address) => {
      sent.push({ data, port, address });
    }),
    joinMulticast: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onMessage: (cb) => {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onError: () => () => {},
    onListening: (cb) => {
      listeningListeners.add(cb);
      return () => listeningListeners.delete(cb);
    },
    address: () => ({ address: "192.168.1.90", port: 5100 }),
    __emit(msg: Buffer, rinfo: { address: string; port: number }) {
      for (const l of messageListeners) l(msg, rinfo);
    },
  } as unknown as ReturnType<typeof fakeTransport>;
}

describe("createCasambiRemoteSocketFactory (fake transport)", () => {
  it("bind(port) binds the transport with that local port, then fires the 'listening' event", async () => {
    const transport = fakeTransport();
    const socket = createCasambiRemoteSocketFactory(() => transport)();
    let listening = false;
    socket.on("listening", () => (listening = true));
    socket.bind(5100);
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.bind).toHaveBeenCalledWith({ localPort: 5100 });
    expect(listening).toBe(true);
  });

  it("send() encodes the ASCII wire string to bytes exactly (never binary garbage)", () => {
    const transport = fakeTransport();
    const socket = createCasambiRemoteSocketFactory(() => transport)();
    socket.send("0.72.4.20.c8.1.5\r\n", 5100, "192.168.1.90", () => {});
    expect(transport.sent).toEqual([{ data: Buffer.from("0.72.4.20.c8.1.5\r\n", "ascii"), port: 5100, address: "192.168.1.90" }]);
  });

  it("a received datagram reaches the message listener with rinfo (address+port) intact", () => {
    const transport = fakeTransport();
    const socket = createCasambiRemoteSocketFactory(() => transport)();
    const received: unknown[] = [];
    socket.on("message", (msg, rinfo) => received.push({ msg, rinfo }));
    (transport as unknown as { __emit(msg: Buffer, rinfo: { address: string; port: number }): void }).__emit(
      Buffer.from("2.70.2.3a.1\r\n", "ascii"),
      { address: "192.168.1.90", port: 5100 },
    );
    expect(received).toEqual([{ msg: Buffer.from("2.70.2.3a.1\r\n", "ascii"), rinfo: { address: "192.168.1.90", port: 5100 } }]);
  });

  it("address() reports the transport's real bound address, never a fabricated placeholder", () => {
    const transport = fakeTransport();
    const socket = createCasambiRemoteSocketFactory(() => transport)();
    expect(socket.address?.()).toEqual({ address: "192.168.1.90", port: 5100, family: "IPv4" });
  });

  it("close() closes the transport and invokes the callback", async () => {
    const transport = fakeTransport();
    const socket = createCasambiRemoteSocketFactory(() => transport)();
    let closed = false;
    socket.close(() => (closed = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.close).toHaveBeenCalled();
    expect(closed).toBe(true);
  });
});
