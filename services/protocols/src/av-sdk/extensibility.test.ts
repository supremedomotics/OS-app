import { createServer, type Server, type Socket } from "node:net";
import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import {
  bindingKey,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { describe, expect, it, vi } from "vitest";
import { TcpLineTransport } from "./tcp-line-transport.js";
import { recordCapabilityState } from "./state-cache.js";

/**
 * Extensibility proof (§ Universal AV SDK, Phase 5 — Future-Proofing) — a SYNTHETIC,
 * fake, non-real brand built from ONLY `av-sdk`'s two public primitives
 * (`TcpLineTransport` + `recordCapabilityState`), with ZERO changes to either module.
 *
 * This is deliberately NOT a real driver for a real brand: it has no manifest, is not
 * exported from `services/protocols/src/index.ts`, is not registered in
 * `native-driver-factory.ts`, and speaks a made-up two-line protocol invented only for
 * this test. Per the brief's explicit instruction ("do not create placeholder adapters
 * for unsupported brands — instead provide an adapter interface, adapter development
 * guide, and prove the SDK is reusable"), this file IS that proof: a from-scratch
 * `INativeProtocolDriver` implementation that reuses the SDK's transport pooling,
 * reconnect, line-buffering, and state-cache/dedupe/dispatch logic without touching a
 * single line inside `av-sdk/`. If this compiles and passes against a real in-process
 * TCP server, the SDK's public surface is genuinely sufficient for a new adapter — not
 * merely asserted to be.
 */
interface FakeBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
  port: number;
}

class FakeBrandDriver implements INativeProtocolDriver {
  readonly protocol = "fake-brand-extensibility-proof";
  private connected = false;
  private readonly bindings: FakeBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private readonly transport = new TcpLineTransport({
    delimiter: "\n",
    onConnect: (_link, socket) => socket.write("HELLO\n"),
    onLine: (ctx, line) => this.onLine(ctx.host, ctx.port, line),
  });

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.transport.disconnectAll();
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const [host, portStr] = binding.address.split(":");
    const port = Number(portStr);
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, host: host!, port });
    this.devices.add(binding.deviceId);
    if (this.connected) this.transport.ensureLink(binding.address, host!, port);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  async unbind(deviceId: DeviceId): Promise<void> {
    const removed = this.bindings.filter((b) => b.deviceId === deviceId);
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      if (this.bindings[i]!.deviceId === deviceId) this.bindings.splice(i, 1);
    }
    this.devices.delete(deviceId);
    const prefix = `${deviceId}:`;
    for (const k of [...this.states.keys()]) if (k.startsWith(prefix)) this.states.delete(k);
    for (const key of new Set(removed.map((b) => `${b.host}:${b.port}`))) {
      if (this.bindings.some((b) => `${b.host}:${b.port}` === key)) continue;
      this.transport.releaseKey(key);
    }
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`fake-brand: ${deviceId} not bound for ${command.capability}`);
    if (command.capability !== "onoff") throw new Error("fake-brand: only onoff is implemented");
    const key = `${b.host}:${b.port}`;
    const link = this.transport.ensureLink(key, b.host, b.port);
    if (!link.ready || !link.socket) throw new Error(`fake-brand: not connected to ${key}`);
    const on = command.action === "on" ? true : command.action === "off" ? false : undefined;
    if (on === undefined) throw new Error("fake-brand: unsupported action");
    link.socket.write(`SET:${on ? "1" : "0"}\n`);
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    return [];
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onLine(host: string, port: number, line: string): void {
    if (!line.startsWith("STATE:")) return;
    const on = line.slice("STATE:".length) === "1";
    for (const b of this.bindings) {
      if (b.host !== host || b.port !== port || b.capability !== "onoff") continue;
      recordCapabilityState(this.states, this.listeners, b.deviceId, b.capability, { kind: "onoff", on });
    }
  }
}

/** A trivial in-process server for the made-up "fake brand" protocol: answers HELLO with
 * nothing, and SET:0/SET:1 with a STATE:0/STATE:1 echo — just enough to drive the fake
 * driver above over a real socket. */
function startFakeBrandServer(): Promise<{ server: Server; port: number; received: string[]; sockets: Set<Socket> }> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          received.push(line);
          if (line === "SET:1") sock.write("STATE:1\n");
          else if (line === "SET:0") sock.write("STATE:0\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, received, sockets });
    });
  });
}

describe("Extensibility proof — a from-scratch adapter built from av-sdk's public API only", () => {
  it("connects, commands, and reflects state through TcpLineTransport + recordCapabilityState alone", async () => {
    const fake = await startFakeBrandServer();
    const driver = new FakeBrandDriver();
    await driver.connect();

    const dev = "device-fake-brand-1" as DeviceId;
    await driver.bind({ deviceId: dev, capability: "onoff", address: `127.0.0.1:${fake.port}` });
    await vi.waitFor(() => expect(fake.received).toContain("HELLO"));

    const events: unknown[] = [];
    driver.onState((e) => events.push(e));

    await driver.command(dev, { capability: "onoff", action: "on" });
    await vi.waitFor(() => expect(fake.received).toContain("SET:1"));
    await vi.waitFor(() => expect(driver.getState(dev, "onoff")).toEqual({ kind: "onoff", on: true }));
    expect(events).toHaveLength(1);

    // Identical repeat is deduped by the shared state-cache helper — no second event.
    await driver.command(dev, { capability: "onoff", action: "on" });
    await vi.waitFor(() => expect(fake.received.filter((l) => l === "SET:1")).toHaveLength(2));
    expect(events).toHaveLength(1); // still 1 — the echoed STATE:1 didn't change anything

    await driver.command(dev, { capability: "onoff", action: "off" });
    await vi.waitFor(() => expect(driver.getState(dev, "onoff")).toEqual({ kind: "onoff", on: false }));
    expect(events).toHaveLength(2);

    // unbind() releases the pooled link (via the SDK's own TcpLineTransport.releaseKey) —
    // no custom cleanup code was needed beyond calling the SDK's own method.
    await driver.unbind(dev);
    expect(driver.manages(dev)).toBe(false);
    await vi.waitFor(() => expect(fake.sockets.size).toBe(0));

    await driver.disconnect();
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("rejects a command for an unbound device without ever touching the transport", async () => {
    const driver = new FakeBrandDriver();
    await driver.connect();
    await expect(driver.command("nope" as DeviceId, { capability: "onoff", action: "on" })).rejects.toThrow(/not bound/);
    await driver.disconnect();
  });
});
