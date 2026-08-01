import { describe, expect, it } from "vitest";
import { InProcessEventBus } from "@supreme/messaging";
import { NatsUdpTransportClient } from "@supreme/lan";
import { UdpTransportServer, defaultDgramSocket } from "@supreme/lan/server";
import { CasambiUdpEngine } from "../casambi/local-transport/index.js";
import { encodeSetTargetLevel, CASAMBI_TARGET_TYPE } from "../casambi/local-transport/udp-codec.js";
import { createCasambiRemoteSocketFactory } from "./casambi-remote-socket.js";

/**
 * The concrete cross-package proof (§ Production Architecture Refactor). The REAL,
 * hardware-validated `CasambiUdpEngine` (unmodified, same class production uses) runs entirely
 * against a `supreme-lan`-backed transport instead of a local `node:dgram` socket — over a shared
 * `InProcessEventBus`, so this is a genuine, zero-network exercise of the exact production
 * `UdpTransportServer`/`NatsUdpTransportClient` classes. This does NOT change Casambi's default
 * behavior: `CasambiUdpEngine`'s default `socketFactory` is still real local `dgram`, unchanged —
 * this test only proves the alternative, opt-in remote factory is a real, working substitute.
 */
describe("Casambi over supreme-lan (real CasambiUdpEngine, remote transport)", () => {
  it("sends and receives real Casambi wire packets through the full supreme-lan pipeline", async () => {
    const bus = new InProcessEventBus();
    const server = new UdpTransportServer(bus, defaultDgramSocket);
    await server.start();

    const engine = new CasambiUdpEngine({
      gatewayIp: "127.0.0.1",
      udpPort: 0, // resolved for real once bound; see below
      netId: 0,
      socketFactory: createCasambiRemoteSocketFactory(() => new NatsUdpTransportClient(bus, { timeoutMs: 2_000 })),
    });

    await engine.start();
    expect(engine.listening).toBe(true);
    expect(engine.socketState).toBe("bound");

    // Real gateway IP/port aren't known until after a real ephemeral bind — rebuild the packet
    // target using the engine's own real local address (loopback), matching the loopback smoke
    // test's pattern: a real UDP round trip to itself proves the whole remote pipeline moves
    // real bytes, without needing a live Casambi gateway on the network.
    const localPort = engine.localPort;
    expect(localPort).not.toBeNull();

    const received: unknown[] = [];
    engine.onPacket((pkt) => received.push(pkt));

    // Re-point a second engine instance's send at the first engine's own bound port — proves
    // the remote UDP transport genuinely carries the exact Casambi wire text end to end.
    // `localPort: 0` gives the SENDER its own separate ephemeral bind — without it, the engine's
    // own default (`localPort ?? udpPort`) would try to bind the sender's local socket to
    // `udpPort` too, i.e. the exact same port the receiver already owns, a real-world footgun
    // this test setup (both "ends" on 127.0.0.1) makes visible but a real deployment (receiver
    // and remote gateway are different hosts) would never hit.
    const senderEngine = new CasambiUdpEngine({
      gatewayIp: "127.0.0.1",
      udpPort: localPort!,
      localPort: 0,
      netId: 0,
      socketFactory: createCasambiRemoteSocketFactory(() => new NatsUdpTransportClient(bus, { timeoutMs: 2_000 })),
    });
    await senderEngine.start();
    await senderEngine.send(encodeSetTargetLevel(0, CASAMBI_TARGET_TYPE.device, 5, 200));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      packet: { netId: 0, direction: "toCasambi", opcode: 0x20, args: [200, 1, 5] },
    });
    expect(engine.packetsReceived).toBe(1);

    await engine.stop();
    await senderEngine.stop();
    await server.stop();
  }, 10_000);
});
