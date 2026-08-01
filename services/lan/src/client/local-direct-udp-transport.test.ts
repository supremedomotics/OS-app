import { describe, expect, it } from "vitest";
import { LocalDirectUdpTransport } from "./local-direct-udp-transport.js";

describe("LocalDirectUdpTransport (real node:dgram, no NATS hop)", () => {
  it("binds a real loopback socket and reports its real address", async () => {
    const transport = new LocalDirectUdpTransport();
    await transport.bind({ localAddress: "127.0.0.1", localPort: 0 });
    const addr = transport.address();
    expect(addr?.address).toBe("127.0.0.1");
    expect(addr!.port).toBeGreaterThan(0);
    await transport.close();
  });

  it("sends and receives a real UDP datagram to its own bound address", async () => {
    const transport = new LocalDirectUdpTransport();
    await transport.bind({ localAddress: "127.0.0.1", localPort: 0 });
    const addr = transport.address()!;
    const received = new Promise<Buffer>((resolve) => transport.onMessage((msg) => resolve(msg)));
    await transport.send(Buffer.from("local direct payload"), addr.port, "127.0.0.1");
    expect((await received).toString()).toBe("local direct payload");
    expect(transport.packetsSent).toBe(1);
    expect(transport.packetsReceived).toBe(1);
    await transport.close();
  });

  it("onListening fires once bind() completes", async () => {
    const transport = new LocalDirectUdpTransport();
    let fired = false;
    transport.onListening(() => (fired = true));
    await transport.bind({ localAddress: "127.0.0.1", localPort: 0 });
    expect(fired).toBe(true);
    await transport.close();
  });

  it("address() is null before bind()", () => {
    const transport = new LocalDirectUdpTransport();
    expect(transport.address()).toBeNull();
  });
});
