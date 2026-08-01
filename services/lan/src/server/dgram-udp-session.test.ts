import { describe, expect, it } from "vitest";
import { DgramUdpSession, type DgramSocketLike } from "./dgram-udp-session.js";

/** A real event-emitting fake socket — exercises the session's actual listener wiring, matching
 * the `FakeUdpSocket` pattern already established in `casambi/local-transport/udp-engine.test.ts`. */
class FakeDgramSocket implements DgramSocketLike {
  sent: { msg: Buffer; port: number; address: string }[] = [];
  closed = false;
  broadcastFlag = false;
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
    this.closed = true;
    callback?.();
  }
  address(): { address: string; port: number; family: string } {
    return this.boundAddress;
  }
  setBroadcast(flag: boolean): void {
    this.broadcastFlag = flag;
  }
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
  receive(msg: Buffer, rinfo = { address: "10.0.0.5", port: 9999 }): void {
    this.emit("message", msg, rinfo);
  }
}

/** A socket whose bind() immediately errors — exercises the honest bind-failure path. */
class FailingBindSocket extends FakeDgramSocket {
  override bind(): void {
    queueMicrotask(() => this.emit("error", new Error("EADDRINUSE")));
  }
}

describe("DgramUdpSession", () => {
  it("binds and reports the real local address/port", async () => {
    const socket = new FakeDgramSocket();
    const session = new DgramUdpSession("s1", () => socket);
    const addr = await session.bind({ localPort: 5100 });
    expect(addr).toEqual({ address: "0.0.0.0", port: 5100, family: "IPv4" });
  });

  it("rejects on a real bind failure, never silently succeeding", async () => {
    const socket = new FailingBindSocket();
    const session = new DgramUdpSession("s1", () => socket);
    await expect(session.bind({})).rejects.toThrow("EADDRINUSE");
  });

  it("send() writes to the fake socket and increments packetsSent", async () => {
    const socket = new FakeDgramSocket();
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({});
    await session.send(Buffer.from("hello"), 10009, "192.168.0.45");
    expect(socket.sent).toEqual([{ msg: Buffer.from("hello"), port: 10009, address: "192.168.0.45" }]);
    expect(session.packetsSent).toBe(1);
  });

  it("send() before bind() throws rather than silently dropping the command", async () => {
    const session = new DgramUdpSession("s1", () => new FakeDgramSocket());
    await expect(session.send(Buffer.from("x"), 1, "1.2.3.4")).rejects.toThrow(/before bind/);
  });

  it("counts a received datagram and notifies onMessage listeners, address/port preserved", async () => {
    const socket = new FakeDgramSocket();
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({});
    const received: unknown[] = [];
    session.onMessage((msg, rinfo) => received.push({ msg, rinfo }));
    socket.receive(Buffer.from("payload"), { address: "192.168.0.45", port: 10009 });
    expect(session.packetsReceived).toBe(1);
    expect(received).toEqual([{ msg: Buffer.from("payload"), rinfo: { address: "192.168.0.45", port: 10009 } }]);
  });

  it("records a real socket error via onError and lastError, without crashing the session", async () => {
    const socket = new FakeDgramSocket();
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({});
    const errors: Error[] = [];
    session.onError((e) => errors.push(e));
    socket.emit("error", new Error("ECONNRESET"));
    expect(errors[0]?.message).toBe("ECONNRESET");
    expect(session.lastError).toBe("ECONNRESET");
  });

  it("broadcast:true calls setBroadcast(true) on the real socket", async () => {
    const socket = new FakeDgramSocket();
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({ broadcast: true });
    expect(socket.broadcastFlag).toBe(true);
  });

  it("multicastGroup joins membership, using multicastInterface as the outgoing-interface hint first", async () => {
    const socket = new FakeDgramSocket();
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({ multicastGroup: "224.0.0.251", multicastInterface: "192.168.1.10" });
    expect(socket.multicastInterface).toBe("192.168.1.10");
    expect(socket.memberships).toEqual([{ group: "224.0.0.251", iface: "192.168.1.10" }]);
  });

  it("joinMulticast() after bind() joins membership, using multicastInterface as the outgoing hint first", async () => {
    const socket = new FakeDgramSocket();
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({});
    await session.joinMulticast("224.0.23.12", "192.168.1.10");
    expect(socket.multicastInterface).toBe("192.168.1.10");
    expect(socket.memberships).toEqual([{ group: "224.0.23.12", iface: "192.168.1.10" }]);
  });

  it("joinMulticast() before bind() throws rather than silently doing nothing", async () => {
    const session = new DgramUdpSession("s1", () => new FakeDgramSocket());
    await expect(session.joinMulticast("224.0.23.12")).rejects.toThrow(/before bind/);
  });

  it("close() closes the real socket", async () => {
    const socket = new FakeDgramSocket();
    const session = new DgramUdpSession("s1", () => socket);
    await session.bind({});
    await session.close();
    expect(socket.closed).toBe(true);
  });

  it("close() before bind() is a safe no-op", async () => {
    const session = new DgramUdpSession("s1", () => new FakeDgramSocket());
    await expect(session.close()).resolves.toBeUndefined();
  });
});
