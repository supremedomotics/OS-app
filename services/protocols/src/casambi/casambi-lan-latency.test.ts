import { describe, expect, it } from "vitest";
import { InProcessEventBus } from "@supreme/messaging";
import { NatsUdpTransportClient } from "@supreme/lan";
import { UdpTransportServer, type DgramSocketLike } from "@supreme/lan/server";
import { CasambiProtocolDriver } from "./casambi-driver.js";
import type { DeviceId } from "@supreme/domain-model";

/**
 * § LAN Transport Phase 2 — Performance measurements ("provide measurements" per the governing
 * brief). This is a REPEATABLE, automated stand-in for the manual real-Docker measurement done
 * once during this session (a real host-networked `supreme-lan` container receiving a real UDP
 * packet from a real host process reported ~8ms end-to-end over real Docker + real NATS —
 * disclosed in the architecture doc, not reproducible as an automated test since it needs a real
 * Docker daemon). This test measures the SAME logical stages using the identical real classes
 * (`NatsUdpTransportClient`, `UdpTransportServer`, `CasambiProtocolDriver`) over an
 * `InProcessEventBus` and a fake `node:dgram` socket — i.e., it isolates the CODE's own overhead
 * from real network/Docker/OS scheduling variance, which the manual run could not do. Both numbers
 * are legitimate and reported for what they are: this one is a lower-bound (code-only) latency
 * floor; the manual Docker run is a real, but one-off, upper-bound including real infrastructure.
 */
class FakeDgramSocket implements DgramSocketLike {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private boundAddress = { address: "0.0.0.0", port: 10009, family: "IPv4" };
  bind(port?: number, address?: string): void {
    this.boundAddress = { address: address ?? "0.0.0.0", port: port ?? 10009, family: "IPv4" };
    queueMicrotask(() => this.emit("listening"));
  }
  send(_msg: Buffer, _port: number, _address: string, callback?: (error: Error | null) => void): void {
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
  receiveBroadcast(msg: Buffer, rinfo = { address: "192.168.0.45", port: 10009 }): void {
    this.emit("message", msg, rinfo);
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}
function stats(samplesMs: number[]): { medianMs: number; p95Ms: number; meanMs: number } {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mean = samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length;
  return { medianMs: percentile(sorted, 50), p95Ms: percentile(sorted, 95), meanMs: Math.round(mean * 1000) / 1000 };
}

describe("Casambi over @supreme/lan — latency (code-only, InProcessEventBus; see architecture doc for the real-Docker measurement)", () => {
  it("measures UDP-RX-to-driver-state-update latency across 50 real broadcast packets", async () => {
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
    const dev = "lan-latency-dev" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "brightness", address: "casambi:5" });
    await driver.connect();

    const N = 50;
    const endToEndMs: number[] = [];
    for (let i = 0; i < N; i++) {
      const level = i % 2 === 0 ? 200 : 100; // alternate so every packet is a real, non-deduped state change
      const t0 = process.hrtime.bigint();
      const updated = new Promise<void>((resolve) => {
        const off = driver.onState((e) => {
          if (e.deviceId === dev) {
            off();
            resolve();
          }
        });
      });
      const hex = level.toString(16).padStart(2, "0");
      gatewaySocket.receiveBroadcast(Buffer.from(`0.70.4.4b.5.1.${hex}\r\n`, "ascii"));
      await updated;
      const t1 = process.hrtime.bigint();
      endToEndMs.push(Number(t1 - t0) / 1_000_000);
    }

    const s = stats(endToEndMs);
    // eslint-disable-next-line no-console
    console.log(
      `[Casambi/@supreme/lan latency, code-only InProcessEventBus, n=${N}] ` +
        `UDP-receive -> decode -> driver applySignal -> onState fired: ` +
        `median=${s.medianMs.toFixed(3)}ms p95=${s.p95Ms.toFixed(3)}ms mean=${s.meanMs}ms`,
    );
    // Generous bound — this guards against a real regression (e.g. an accidental await/timeout
    // added to a hot path), not a tight performance SLA. The manual real-Docker run (~8ms,
    // documented in the architecture doc) includes real OS/network overhead this code-only
    // measurement does not, so this bound is intentionally looser, not tighter.
    expect(s.p95Ms).toBeLessThan(200);

    await driver.disconnect();
  });

  it("measures command() dispatch latency (driver -> adapter -> transport -> fake gateway socket) across 50 commands", async () => {
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
    const dev = "lan-latency-cmd" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "onoff", address: "casambi:5" });
    await driver.connect();

    const N = 50;
    const commandMs: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      await driver.command(dev, { capability: "onoff", action: i % 2 === 0 ? "on" : "off" });
      const t1 = process.hrtime.bigint();
      commandMs.push(Number(t1 - t0) / 1_000_000);
    }

    const s = stats(commandMs);
    // eslint-disable-next-line no-console
    console.log(
      `[Casambi/@supreme/lan latency, code-only InProcessEventBus, n=${N}] ` +
        `command() -> commandEngine -> NatsUdpTransportClient.send() (request/reply round trip) -> UdpTransportServer -> fake gateway socket: ` +
        `median=${s.medianMs.toFixed(3)}ms p95=${s.p95Ms.toFixed(3)}ms mean=${s.meanMs}ms`,
    );
    expect(s.p95Ms).toBeLessThan(200);

    await driver.disconnect();
  });
});
