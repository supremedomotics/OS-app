import { describe, expect, it, vi } from "vitest";
import type { UdpTransport } from "@supreme/lan";
import { createKnxDiscoveryRemoteSocketFactory } from "./knx-discovery-remote-socket.js";

/** A fake `UdpTransport` — lets these tests pin the EXACT adapter-to-transport call mapping
 * without a real supreme-lan server, matching this codebase's established fake-socket testing
 * convention. Real end-to-end multicast delivery cannot be verified in this sandboxed
 * environment (see `docs/architecture/Supreme-LAN-Transport-Architecture.md`'s testing-honesty
 * note) — the cross-package proof for a real bind/send/receive round trip over a real
 * `supreme-lan` server is `casambi-remote-socket.test.ts`, which exercises the exact same
 * `UdpTransport` contract this adapter also builds on. */
function fakeTransport(): UdpTransport & { boundOpts?: unknown; sent: { data: Buffer; port: number; address: string }[]; multicastJoins: { group: string; iface?: string }[] } {
  const messageListeners = new Set<(msg: Buffer, rinfo: { address: string; port: number }) => void>();
  const sent: { data: Buffer; port: number; address: string }[] = [];
  const multicastJoins: { group: string; iface?: string }[] = [];
  let boundOpts: unknown;
  return {
    sent,
    multicastJoins,
    get boundOpts() {
      return boundOpts;
    },
    bind: vi.fn(async (opts) => {
      boundOpts = opts;
    }),
    send: vi.fn(async (data, port, address) => {
      sent.push({ data, port, address });
    }),
    joinMulticast: vi.fn(async (group, iface) => {
      multicastJoins.push({ group, iface });
    }),
    close: vi.fn(async () => {}),
    onMessage: (cb) => {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onError: () => () => {},
    onListening: () => () => {},
    address: () => ({ address: "192.168.1.10", port: 3671 }),
    // test helper, not part of UdpTransport
    __emit(msg: Buffer, rinfo: { address: string; port: number }) {
      for (const l of messageListeners) l(msg, rinfo);
    },
  } as unknown as ReturnType<typeof fakeTransport>;
}

describe("createKnxDiscoveryRemoteSocketFactory", () => {
  it("bind(cb, address) binds the transport with that address, then invokes cb only once bound", async () => {
    const transport = fakeTransport();
    const socket = createKnxDiscoveryRemoteSocketFactory(() => transport)();
    let boundCalled = false;
    socket.bind(() => {
      boundCalled = true;
    }, "192.168.1.10");
    expect(boundCalled).toBe(false); // not yet — bind() is async
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.bind).toHaveBeenCalledWith({ localAddress: "192.168.1.10" });
    expect(boundCalled).toBe(true);
  });

  it("setMulticast joins the KNX system-setup group (224.0.23.12), using the interface hint as-is", async () => {
    const transport = fakeTransport();
    const socket = createKnxDiscoveryRemoteSocketFactory(() => transport)();
    socket.setMulticast?.("192.168.1.10");
    await Promise.resolve();
    expect(transport.joinMulticast).toHaveBeenCalledWith("224.0.23.12", "192.168.1.10");
  });

  it("send() forwards the exact SEARCH_REQUEST bytes to the transport", () => {
    const transport = fakeTransport();
    const socket = createKnxDiscoveryRemoteSocketFactory(() => transport)();
    const frame = Buffer.from([0x06, 0x10, 0x02, 0x01]);
    socket.send(frame, 3671, "224.0.23.12");
    expect(transport.send).toHaveBeenCalledWith(frame, 3671, "224.0.23.12");
  });

  it("a real SEARCH_RESPONSE datagram the transport delivers reaches the socket's message listener", () => {
    const transport = fakeTransport();
    const socket = createKnxDiscoveryRemoteSocketFactory(() => transport)();
    const received: unknown[] = [];
    socket.on("message", (msg, rinfo) => received.push({ msg, rinfo }));
    (transport as unknown as { __emit(msg: Buffer, rinfo: { address: string; port: number }): void }).__emit(
      Buffer.from("response"),
      { address: "192.168.1.50", port: 3671 },
    );
    expect(received).toEqual([{ msg: Buffer.from("response"), rinfo: { address: "192.168.1.50", port: 3671 } }]);
  });

  it("close() closes the transport", () => {
    const transport = fakeTransport();
    const socket = createKnxDiscoveryRemoteSocketFactory(() => transport)();
    socket.close();
    expect(transport.close).toHaveBeenCalled();
  });
});
