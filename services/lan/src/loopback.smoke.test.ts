import { describe, expect, it } from "vitest";
import { InProcessEventBus } from "@supreme/messaging";
import { NatsUdpTransportClient } from "./client/nats-udp-transport-client.js";
import { UdpTransportServer } from "./server/udp-transport-server.js";
import { defaultDgramSocket } from "./server/dgram-udp-session.js";

/**
 * Real-socket smoke test (§ Production Architecture Refactor, Testing tier 3). Uses the REAL
 * `node:dgram`-backed `defaultDgramSocket()` — not a fake — on `127.0.0.1`, driven through the
 * actual client → `IEventBus` → server → OS socket pipeline. This proves the plumbing genuinely
 * moves bytes through a real kernel socket without needing true LAN broadcast traffic (which this
 * sandboxed environment cannot originate or verify — see the architecture doc's honesty note on
 * Windows/Linux compatibility testing).
 */
describe("supreme-lan real-socket loopback smoke test", () => {
  it("a real UDP datagram sent to a session's own bound loopback address is received back through the full pipeline", async () => {
    const bus = new InProcessEventBus();
    const server = new UdpTransportServer(bus, defaultDgramSocket);
    await server.start();
    const client = new NatsUdpTransportClient(bus, { timeoutMs: 2_000 });

    await client.bind({ localAddress: "127.0.0.1", localPort: 0 });
    const addr = client.address();
    expect(addr).not.toBeNull();
    expect(addr!.address).toBe("127.0.0.1");
    expect(addr!.port).toBeGreaterThan(0);

    const received = new Promise<{ msg: Buffer; rinfo: { address: string; port: number } }>((resolve) => {
      client.onMessage((msg, rinfo) => resolve({ msg, rinfo }));
    });

    // UDP allows sending to your own bound address — a real datagram genuinely leaves and
    // re-enters the kernel's loopback socket stack, exercising the real send() AND real
    // "message" event path end to end.
    await client.send(Buffer.from("real udp loopback payload"), addr!.port, "127.0.0.1");

    const result = await received;
    expect(result.msg.toString()).toBe("real udp loopback payload");
    expect(result.rinfo.address).toBe("127.0.0.1");

    await client.close();
    await server.stop();
  }, 10_000);

  it("real broadcast opt-in (setBroadcast) does not throw on a genuine OS socket", async () => {
    const bus = new InProcessEventBus();
    const server = new UdpTransportServer(bus, defaultDgramSocket);
    await server.start();
    const client = new NatsUdpTransportClient(bus, { timeoutMs: 2_000 });
    await expect(client.bind({ localAddress: "127.0.0.1", localPort: 0, broadcast: true })).resolves.toBeUndefined();
    await client.close();
    await server.stop();
  });
});
