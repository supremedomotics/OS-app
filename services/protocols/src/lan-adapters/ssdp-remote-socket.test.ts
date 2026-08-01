import { describe, expect, it, vi } from "vitest";
import type { UdpTransport } from "@supreme/lan";
import { createSsdpRemoteSocketFactory } from "./ssdp-remote-socket.js";

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
    address: () => ({ address: "0.0.0.0", port: 1900 }),
    __emit(msg: Buffer, rinfo: { address: string; port: number }) {
      for (const l of messageListeners) l(msg, rinfo);
    },
  } as unknown as ReturnType<typeof fakeTransport>;
}

describe("createSsdpRemoteSocketFactory", () => {
  it("bind(cb) binds the transport with NO multicast join — SSDP M-SEARCH responses are unicast", async () => {
    const transport = fakeTransport();
    const socket = createSsdpRemoteSocketFactory(() => transport)();
    let called = false;
    socket.bind(() => (called = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.bind).toHaveBeenCalledWith();
    expect(transport.joinMulticast).not.toHaveBeenCalled();
    expect(called).toBe(true);
  });

  it("send() forwards the exact M-SEARCH bytes to 239.255.255.250:1900", () => {
    const transport = fakeTransport();
    const socket = createSsdpRemoteSocketFactory(() => transport)();
    const msearch = Buffer.from("M-SEARCH * HTTP/1.1\r\n");
    socket.send(msearch, 1900, "239.255.255.250");
    expect(transport.send).toHaveBeenCalledWith(msearch, 1900, "239.255.255.250");
  });

  it("a real M-SEARCH response datagram reaches the socket's message listener with source address intact", () => {
    const transport = fakeTransport();
    const socket = createSsdpRemoteSocketFactory(() => transport)();
    const received: unknown[] = [];
    socket.on("message", (msg, rinfo) => received.push({ msg, rinfo }));
    (transport as unknown as { __emit(msg: Buffer, rinfo: { address: string }): void }).__emit(Buffer.from("HTTP/1.1 200 OK"), {
      address: "192.168.1.99",
    });
    expect(received).toEqual([{ msg: Buffer.from("HTTP/1.1 200 OK"), rinfo: { address: "192.168.1.99" } }]);
  });

  it("close() closes the transport", () => {
    const transport = fakeTransport();
    const socket = createSsdpRemoteSocketFactory(() => transport)();
    socket.close();
    expect(transport.close).toHaveBeenCalled();
  });
});
