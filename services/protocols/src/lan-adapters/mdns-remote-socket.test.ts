import { describe, expect, it, vi } from "vitest";
import type { UdpTransport } from "@supreme/lan";
import { createMdnsRemoteSocketFactory } from "./mdns-remote-socket.js";

function fakeTransport(): UdpTransport & { sent: { data: Buffer; port: number; address: string }[] } {
  const messageListeners = new Set<(msg: Buffer, rinfo: { address: string; port: number }) => void>();
  const sent: { data: Buffer; port: number; address: string }[] = [];
  return {
    sent,
    bind: vi.fn(async () => {}),
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
    onListening: () => () => {},
    address: () => ({ address: "0.0.0.0", port: 5353 }),
    __emit(msg: Buffer, rinfo: { address: string; port: number }) {
      for (const l of messageListeners) l(msg, rinfo);
    },
  } as unknown as ReturnType<typeof fakeTransport>;
}

describe("createMdnsRemoteSocketFactory", () => {
  it("bind(cb) binds the transport with NO multicast join — mDNS here relies on QU (unicast response), never membership", async () => {
    const transport = fakeTransport();
    const socket = createMdnsRemoteSocketFactory(() => transport)();
    let called = false;
    socket.bind(() => (called = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.bind).toHaveBeenCalledWith();
    expect(transport.joinMulticast).not.toHaveBeenCalled();
    expect(called).toBe(true);
  });

  it("send() forwards the exact DNS-SD query bytes to 224.0.0.251:5353", () => {
    const transport = fakeTransport();
    const socket = createMdnsRemoteSocketFactory(() => transport)();
    const query = Buffer.from([0, 0, 0, 0]);
    socket.send(query, 5353, "224.0.0.251");
    expect(transport.send).toHaveBeenCalledWith(query, 5353, "224.0.0.251");
  });

  it("a real DNS response datagram reaches the socket's message listener with source address intact", () => {
    const transport = fakeTransport();
    const socket = createMdnsRemoteSocketFactory(() => transport)();
    const received: unknown[] = [];
    socket.on("message", (msg, rinfo) => received.push({ msg, rinfo }));
    (transport as unknown as { __emit(msg: Buffer, rinfo: { address: string }): void }).__emit(Buffer.from("dns-answer"), {
      address: "192.168.1.77",
    });
    expect(received).toEqual([{ msg: Buffer.from("dns-answer"), rinfo: { address: "192.168.1.77" } }]);
  });

  it("close() closes the transport", () => {
    const transport = fakeTransport();
    const socket = createMdnsRemoteSocketFactory(() => transport)();
    socket.close();
    expect(transport.close).toHaveBeenCalled();
  });
});
