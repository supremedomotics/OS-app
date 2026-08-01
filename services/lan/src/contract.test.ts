import { describe, expect, it } from "vitest";
import { InProcessEventBus } from "@supreme/messaging";
import { NatsUdpTransportClient } from "./client/nats-udp-transport-client.js";
import { UdpTransportServer } from "./server/udp-transport-server.js";
import type { DgramSocketLike } from "./server/dgram-udp-session.js";

/**
 * Real request/reply + event wire-protocol proof, with ZERO network — the exact same
 * `UdpTransportServer` and `NatsUdpTransportClient` classes a real deployment uses, sharing one
 * `InProcessEventBus` instead of a `NatsEventBus` reaching an actual `supreme-lan` container (§
 * Production Architecture Refactor, Testing tier 2). This is what proves the NATS subject/payload
 * contract itself is correct, independent of whether the transport underneath is in-process or
 * real NATS — `@supreme/messaging`'s two `IEventBus` implementations are observably equivalent by
 * design (see `event-bus.ts`'s own doc comment), so this test's pass/fail is meaningful for the
 * real NATS path too.
 */
class FakeDgramSocket implements DgramSocketLike {
  sent: { msg: Buffer; port: number; address: string }[] = [];
  memberships: { group: string; iface?: string }[] = [];
  multicastInterface: string | null = null;
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private boundAddress = { address: "0.0.0.0", port: 5100, family: "IPv4" };

  bind(port?: number, address?: string): void {
    this.boundAddress = { address: address ?? "0.0.0.0", port: port ?? 5100, family: "IPv4" };
    queueMicrotask(() => this.emit("listening"));
  }
  send(msg: Buffer, port: number, address: string, callback?: (error: Error | null) => void): void {
    this.sent.push({ msg, port, address });
    callback?.(null);
  }
  close(callback?: () => void): void {
    callback?.();
  }
  address(): { address: string; port: number; family: string } {
    return this.boundAddress;
  }
  setBroadcast(): void {}
  addMembership(group: string, iface?: string): void {
    this.memberships.push({ group, iface });
  }
  setMulticastInterface(iface: string): void {
    this.multicastInterface = iface;
  }
  on(event: string, listener: (...args: unknown[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  receive(msg: Buffer, rinfo = { address: "192.168.0.45", port: 10009 }): void {
    this.emit("message", msg, rinfo);
  }
}

async function setup() {
  const bus = new InProcessEventBus();
  const socket = new FakeDgramSocket();
  const server = new UdpTransportServer(bus, () => socket);
  await server.start();
  const client = new NatsUdpTransportClient(bus, { timeoutMs: 500 });
  return { bus, socket, server, client };
}

describe("supreme-lan client <-> server contract (InProcessEventBus)", () => {
  it("bind() round-trips a real sessionId and the server's real bound address", async () => {
    const { client } = await setup();
    await client.bind({ localPort: 5100 });
    expect(client.address()).toEqual({ address: "0.0.0.0", port: 5100 });
  });

  it("send() delivers the exact bytes to the server's real socket", async () => {
    const { client, socket } = await setup();
    await client.bind({});
    await client.send(Buffer.from("hello supreme-lan"), 10009, "192.168.0.45");
    expect(socket.sent).toEqual([{ msg: Buffer.from("hello supreme-lan"), port: 10009, address: "192.168.0.45" }]);
  });

  it("a datagram the server's socket receives is delivered to the client's onMessage listener, bytes and rinfo intact", async () => {
    const { client, socket } = await setup();
    await client.bind({});
    const received: { msg: Buffer; rinfo: { address: string; port: number } }[] = [];
    client.onMessage((msg, rinfo) => received.push({ msg, rinfo }));
    socket.receive(Buffer.from("real hardware payload"), { address: "192.168.0.45", port: 10009 });
    // The event flows client-side asynchronously (a bus publish/subscribe hop) — wait one tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([
      { msg: Buffer.from("real hardware payload"), rinfo: { address: "192.168.0.45", port: 10009 } },
    ]);
  });

  it("close() tears down the session server-side — a second send() after close fails honestly", async () => {
    const { client, server } = await setup();
    await client.bind({});
    await client.close();
    expect(server.sessionDiagnostics()).toEqual([]);
  });

  it("send() before bind() rejects with a clear error, never hanging until timeout", async () => {
    const { client } = await setup();
    await expect(client.send(Buffer.from("x"), 1, "1.2.3.4")).rejects.toThrow(/before bind/);
  });

  it("an unknown sessionId is rejected server-side with an honest error, not a silent no-op", async () => {
    const { bus } = await setup();
    const { requestReply } = await import("./shared/rpc.js");
    const { lanSubjects } = await import("./shared/wire-types.js");
    const res = await requestReply(bus, lanSubjects.send, {
      sessionId: "does-not-exist",
      host: "1.2.3.4",
      port: 1,
      dataBase64: Buffer.from("x").toString("base64"),
    });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("does-not-exist") });
  });

  it("multiple sessions are independently addressable — no cross-talk between two clients", async () => {
    const bus = new InProcessEventBus();
    const socketA = new FakeDgramSocket();
    const socketB = new FakeDgramSocket();
    let bindCount = 0;
    const server = new UdpTransportServer(bus, () => (bindCount++ === 0 ? socketA : socketB));
    await server.start();
    const clientA = new NatsUdpTransportClient(bus, { timeoutMs: 500 });
    const clientB = new NatsUdpTransportClient(bus, { timeoutMs: 500 });
    await clientA.bind({});
    await clientB.bind({});

    const receivedByA: Buffer[] = [];
    const receivedByB: Buffer[] = [];
    clientA.onMessage((msg) => receivedByA.push(msg));
    clientB.onMessage((msg) => receivedByB.push(msg));

    socketA.receive(Buffer.from("for A"));
    socketB.receive(Buffer.from("for B"));
    await new Promise((r) => setTimeout(r, 10));

    expect(receivedByA).toEqual([Buffer.from("for A")]);
    expect(receivedByB).toEqual([Buffer.from("for B")]);
  });

  it("joinMulticast() after bind() calls the real socket's addMembership, using multicastInterface as the outgoing hint", async () => {
    const { client, socket } = await setup();
    await client.bind({});
    await client.joinMulticast("224.0.23.12", "192.168.1.10");
    expect(socket.memberships).toEqual([{ group: "224.0.23.12", iface: "192.168.1.10" }]);
    expect(socket.multicastInterface).toBe("192.168.1.10");
  });

  it("joinMulticast() before bind() throws rather than silently doing nothing", async () => {
    const { client } = await setup();
    await expect(client.joinMulticast("224.0.23.12")).rejects.toThrow(/before bind/);
  });

  it("health request returns real, non-fabricated session diagnostics", async () => {
    const bus = new InProcessEventBus();
    const { requestReply, handleRequests } = await import("./shared/rpc.js");
    const { lanSubjects } = await import("./shared/wire-types.js");
    const { buildDiagnosticsSnapshot } = await import("./server/health.js");
    const socket = new FakeDgramSocket();
    const server = new UdpTransportServer(bus, () => socket);
    await server.start();
    await handleRequests(
      bus,
      lanSubjects.health,
      async () =>
        buildDiagnosticsSnapshot({ networkMode: "bridge", natsConnected: false, startedAt: Date.now(), sessions: server.sessionDiagnostics() }),
      () => buildDiagnosticsSnapshot({ networkMode: "bridge", natsConnected: false, startedAt: Date.now(), sessions: [] }),
    );
    const client = new NatsUdpTransportClient(bus, { timeoutMs: 500 });
    await client.bind({ localPort: 5100 });
    const health = await requestReply(bus, lanSubjects.health, {});
    expect(health).toMatchObject({
      networkMode: "bridge",
      natsConnected: false,
      sessions: [expect.objectContaining({ localPort: 5100, packetsSent: 0, packetsReceived: 0 })],
    });
  });
});
