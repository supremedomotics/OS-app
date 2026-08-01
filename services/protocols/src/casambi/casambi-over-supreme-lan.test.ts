import { describe, expect, it } from "vitest";
import { InProcessEventBus } from "@supreme/messaging";
import { NatsUdpTransportClient } from "@supreme/lan";
import { UdpTransportServer, type DgramSocketLike } from "@supreme/lan/server";
import { CasambiProtocolDriver } from "./casambi-driver.js";
import type { DeviceId } from "@supreme/domain-model";
import type { CasambiDriverEvent } from "./event-engine.js";

/**
 * § LAN Transport Phase 2 — the Casambi-over-`@supreme/lan` cross-package proof (rebuilt against
 * the Phase 2 architecture; the Phase 1 version of this test lived in the now-deleted
 * `lan-adapters/casambi-remote-socket.test.ts`, which implemented an adapter interface that no
 * longer exists). This is the ONE test in the whole suite that exercises the FULL real production
 * chain the migration was for:
 *
 *   fake Lithernet hardware (a fake `node:dgram` socket)
 *     -> `UdpTransportServer` (real, `@supreme/lan/server`)
 *     -> `InProcessEventBus` (real `IEventBus`, standing in for real NATS — the two `IEventBus`
 *        implementations are observably equivalent by design, see `@supreme/messaging`)
 *     -> `NatsUdpTransportClient` (real, `@supreme/lan`)
 *     -> `CasambiUdpEngine` (real, internal to `CasambiProtocolDriver`)
 *     -> `CasambiProtocolDriver` (real, unmodified public API)
 *
 * Only the innermost real socket is faked — the same disclosed, non-network testing tier this
 * codebase already uses everywhere else (`FakeDgramSocket` in `@supreme/lan`'s own
 * `contract.test.ts`). This does NOT prove real LAN broadcast reception on a real NIC (that needs
 * real hardware — see the Phase 2 architecture doc's honesty section); it proves the wiring
 * between every real class in the chain is correct.
 */
class FakeDgramSocket implements DgramSocketLike {
  sent: { msg: Buffer; port: number; address: string }[] = [];
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private boundAddress = { address: "0.0.0.0", port: 10009, family: "IPv4" };

  bind(port?: number, address?: string): void {
    this.boundAddress = { address: address ?? "0.0.0.0", port: port ?? 10009, family: "IPv4" };
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
  addMembership(): void {}
  setMulticastInterface(): void {}
  on(event: string, listener: (...args: unknown[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  /** Simulates the real Lithernet gateway broadcasting a NotifyControlValues packet — exactly
   * the real-world event that motivated this whole migration (Docker bridge networking silently
   * dropped this broadcast; nothing in this chain filters by destination address). */
  receiveBroadcast(msg: Buffer, rinfo = { address: "192.168.0.45", port: 10009 }): void {
    this.emit("message", msg, rinfo);
  }
}

async function setup() {
  const bus = new InProcessEventBus();
  const gatewaySocket = new FakeDgramSocket();
  const server = new UdpTransportServer(bus, () => gatewaySocket);
  await server.start();
  const driver = new CasambiProtocolDriver({
    connectionMode: "local",
    local: {
      gatewayIp: "192.168.0.45",
      restPort: 80,
      udpPort: 10009,
      netId: 0,
      udpTransportFactory: () => new NatsUdpTransportClient(bus, { timeoutMs: 1_000 }),
    },
  });
  return { bus, gatewaySocket, server, driver };
}

describe("Casambi driver over @supreme/lan (NatsUdpTransportClient + UdpTransportServer)", () => {
  it("connect() binds through the real supreme-lan chain and reports connected", async () => {
    const { driver } = await setup();
    await driver.connect();
    expect(driver.isConnected()).toBe(true);
    expect(driver.getCasambiTransportMonitor().transport).toMatchObject({ backend: "nats", listening: true });
    await driver.disconnect();
  });

  it("a broadcast NotifyControlValues datagram discovers a unit and updates a bound capability's state — the exact real hardware scenario", async () => {
    const { driver, gatewaySocket } = await setup();
    const dev = "lan-dev-5" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "brightness", address: "casambi:5" });
    await driver.connect();

    const stateChanged = new Promise<void>((resolve) => {
      const off = driver.onState((e) => {
        if (e.deviceId === dev) {
          off();
          resolve();
        }
      });
    });
    // 0x4B NotifyControlValues: Target_ID=5, TYPE=1 (dimmerChannel)=200 — broadcast, not unicast,
    // matching the real Wireshark capture (gateway -> 255.255.255.255:10009).
    gatewaySocket.receiveBroadcast(Buffer.from("0.70.4.4b.5.1.c8\r\n", "ascii"));
    await stateChanged;

    expect(driver.getState(dev, "brightness")).toEqual({ kind: "brightness", on: true, level: Math.round((200 / 255) * 100) });
    const monitor = driver.getCasambiTransportMonitor();
    expect(monitor.driver).toMatchObject({ entities: 1, discoveryEvents: 1, feedbackEvents: 1 });
    expect(monitor.adapter).toMatchObject({ packetsReceived: 1, decoded: 1, decodeFailures: 0 });
    await driver.disconnect();
  });

  it("a button press over the real chain publishes a typed ButtonEvent", async () => {
    const { driver, gatewaySocket } = await setup();
    await driver.connect();
    const events: CasambiDriverEvent[] = [];
    driver.onDriverEvent((e) => events.push(e));
    // 0x51: Unit_ID=9, Source=1, Button=0, Event=2 (short press)
    gatewaySocket.receiveBroadcast(Buffer.from("0.70.5.51.9.1.0.2\r\n", "ascii"));
    await new Promise((r) => setTimeout(r, 10)); // one real bus hop (server -> NATS -> client)
    expect(events).toContainEqual({ type: "button", unitId: 9, action: "short_press", ts: expect.any(String) });
    await driver.disconnect();
  });

  it("command() sends a real UDP packet through the full chain to the fake gateway socket", async () => {
    const { driver, gatewaySocket } = await setup();
    const dev = "lan-dev-5" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "onoff", address: "casambi:5" });
    await driver.connect();
    gatewaySocket.sent.length = 0; // clear the connect() bootstrap sequence

    await driver.command(dev, { capability: "onoff", action: "on" });

    expect(gatewaySocket.sent).toEqual([
      { msg: Buffer.from("0.72.4.20.ff.1.5\r\n", "ascii"), port: 10009, address: "192.168.0.45" },
    ]);
    expect(driver.getCasambiTransportMonitor().driver.commandsIssued).toBe(1);
    await driver.disconnect();
  });

  it("a malformed broadcast is received and counted, never silently dropped — matches the real audit's root-cause fix", async () => {
    const { driver, gatewaySocket } = await setup();
    await driver.connect();
    gatewaySocket.receiveBroadcast(Buffer.from("garbage\r\n", "ascii"));
    await new Promise((r) => setTimeout(r, 10));
    const monitor = driver.getCasambiTransportMonitor();
    expect(monitor.adapter?.packetsReceived).toBe(1);
    expect(monitor.adapter?.decodeFailures).toBe(1);
    await driver.disconnect();
  });

  it("disconnect() tears down the session server-side (no leaked session)", async () => {
    const { driver, server } = await setup();
    await driver.connect();
    await driver.disconnect();
    expect(server.sessionDiagnostics()).toEqual([]);
  });

  // § LAN Transport Phase 2 Failure Handling — "if packets are still not received, do not guess;
  // prove exactly where the packet flow stops." This is that proof for the one failure mode
  // unique to the new architecture: no `supreme-lan` service answering at all (down, not deployed,
  // wrong NATS URL). The failure must surface honestly at connect() — never a silent "connected"
  // that then never receives anything.
  it("connect() fails honestly (never silently 'succeeds') when no supreme-lan service is reachable on the bus", async () => {
    const bus = new InProcessEventBus(); // no UdpTransportServer ever subscribed
    const driver = new CasambiProtocolDriver({
      connectionMode: "local",
      local: {
        gatewayIp: "192.168.0.45",
        restPort: 80,
        udpPort: 10009,
        netId: 0,
        udpTransportFactory: () => new NatsUdpTransportClient(bus, { timeoutMs: 50 }),
      },
    });
    await expect(driver.connect()).rejects.toThrow(/timed out/);
    expect(driver.isConnected()).toBe(false);
  });
});
