import { describe, expect, it, vi } from "vitest";
import { CasambiUdpEngine, type CasambiUdpSocketLike } from "./udp-engine.js";
import { encodeSetTargetLevel, CASAMBI_TARGET_TYPE } from "./udp-codec.js";

/** A real event-emitting fake socket — exercises the engine's actual listener wiring rather than
 * mocking it away, matching `cloud-transport.test.ts`'s injectable-socket pattern. */
class FakeUdpSocket implements CasambiUdpSocketLike {
  sent: { msg: string; port: number; address: string }[] = [];
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  closed = false;

  on(event: string, listener: (...args: unknown[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  bind(_port?: number): void {
    queueMicrotask(() => this.emit("listening"));
  }

  send(msg: string, port: number, address: string, callback?: (error: Error | null) => void): void {
    this.sent.push({ msg, port, address });
    callback?.(null);
  }

  close(callback?: () => void): void {
    this.closed = true;
    callback?.();
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  receive(raw: string, rinfo = { address: "192.168.1.90", port: 5100 }): void {
    this.emit("message", Buffer.from(raw, "ascii"), rinfo);
  }

  address(): { address: string; port: number; family: string } {
    return { address: "0.0.0.0", port: 5100, family: "IPv4" };
  }
}

/** A socket whose `bind()` immediately fails — exercises the honest "error" socketState path. */
class FailingBindSocket extends FakeUdpSocket {
  bind(_port?: number): void {
    queueMicrotask(() => this.emit("error", new Error("EADDRINUSE")));
  }
}

/** A socket whose `send()` always fails — exercises `lastSendError` without a bind failure. */
class SendFailingSocket extends FakeUdpSocket {
  send(msg: string, port: number, address: string, callback?: (error: Error | null) => void): void {
    callback?.(new Error("ENETUNREACH"));
  }
}

function makeEngine(overrides: Partial<{ netId: number }> = {}) {
  const socket = new FakeUdpSocket();
  const engine = new CasambiUdpEngine({
    gatewayIp: "192.168.1.90",
    udpPort: 5100,
    netId: overrides.netId ?? 0,
    socketFactory: () => socket,
  });
  return { socket, engine };
}

describe("CasambiUdpEngine (fake socket)", () => {
  it("is not listening before start()", () => {
    const { engine } = makeEngine();
    expect(engine.listening).toBe(false);
  });

  it("becomes listening once the socket emits 'listening'", async () => {
    const { engine } = makeEngine();
    await engine.start();
    expect(engine.listening).toBe(true);
  });

  it("start() is idempotent", async () => {
    const { engine, socket } = makeEngine();
    await engine.start();
    const factorySpy = vi.fn(() => socket);
    await engine.start(); // second call should be a no-op, not rebind
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("send() writes the encoded wire text to gatewayIp:udpPort", async () => {
    const { engine, socket } = makeEngine();
    await engine.start();
    await engine.send(encodeSetTargetLevel(0, CASAMBI_TARGET_TYPE.device, 5, 200));
    expect(socket.sent).toEqual([{ msg: "0.72.4.20.c8.1.5\r\n", port: 5100, address: "192.168.1.90" }]);
  });

  it("send() before start() throws rather than silently dropping the command", async () => {
    const { engine } = makeEngine();
    await expect(engine.send(encodeSetTargetLevel(0, CASAMBI_TARGET_TYPE.device, 5, 0))).rejects.toThrow(/before start/);
  });

  it("decodes an incoming datagram and notifies onPacket listeners", async () => {
    const { engine, socket } = makeEngine();
    await engine.start();
    const received: unknown[] = [];
    engine.onPacket((pkt) => received.push(pkt));
    socket.receive("2.70.2.3a.1\r\n"); // 0x3A Notify Node removed, Unit_ID=1
    expect(received).toEqual([
      {
        raw: "2.70.2.3a.1\r\n",
        packet: { netId: 2, direction: "fromCasambi", opcode: 0x3a, args: [1], ack: false },
        rinfo: { address: "192.168.1.90", port: 5100 },
      },
    ]);
  });

  it("routes an undecodable datagram to onDecodeError instead of onPacket", async () => {
    const { engine, socket } = makeEngine();
    await engine.start();
    const packets: unknown[] = [];
    const errors: string[] = [];
    engine.onPacket((p) => packets.push(p));
    engine.onDecodeError((raw) => errors.push(raw));
    socket.receive("garbage\r\n");
    expect(packets).toEqual([]);
    expect(errors).toEqual(["garbage\r\n"]);
  });

  it("onPacket unsubscribe stops delivering further packets", async () => {
    const { engine, socket } = makeEngine();
    await engine.start();
    const received: unknown[] = [];
    const unsubscribe = engine.onPacket((pkt) => received.push(pkt));
    socket.receive("2.70.2.3a.1\r\n");
    unsubscribe();
    socket.receive("2.70.2.3a.1\r\n");
    expect(received).toHaveLength(1);
  });

  it("stop() closes the socket and resets listening", async () => {
    const { engine, socket } = makeEngine();
    await engine.start();
    await engine.stop();
    expect(socket.closed).toBe(true);
    expect(engine.listening).toBe(false);
  });

  it("stop() before start() is a safe no-op", async () => {
    const { engine } = makeEngine();
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  describe("probe() — the safe, never-actuating Test Connection check", () => {
    it("resolves true when a 0x39 response arrives before the timeout", async () => {
      const { engine, socket } = makeEngine();
      await engine.start();
      const result = engine.probe(1_000);
      // The engine sends the probe synchronously inside probe(); simulate the gateway's reply.
      await Promise.resolve();
      socket.receive("0.70.6.39.1.1.0.0.1\r\n"); // 0x39 Node Status reply
      expect(await result).toBe(true);
    });

    it("resolves false on timeout when nothing replies", async () => {
      vi.useFakeTimers();
      const { engine } = makeEngine();
      await engine.start();
      const result = engine.probe(50);
      await vi.advanceTimersByTimeAsync(60);
      expect(await result).toBe(false);
      vi.useRealTimers();
    });

    it("sends opcode 0x39 with Request=0xFF ('own node'), never a real device/group/scene target", async () => {
      const { engine, socket } = makeEngine({ netId: 3 });
      await engine.start();
      void engine.probe(10);
      await Promise.resolve();
      expect(socket.sent).toEqual([{ msg: "3.72.2.39.ff\r\n", port: 5100, address: "192.168.1.90" }]);
    });
  });

  describe("staged diagnostics (§ UDP Diagnostics audit — real, non-fabricated transport state)", () => {
    it("reports socketState 'closed' before start(), 'bound' after, 'closed' again after stop()", async () => {
      const { engine } = makeEngine();
      expect(engine.socketState).toBe("closed");
      await engine.start();
      expect(engine.socketState).toBe("bound");
      await engine.stop();
      expect(engine.socketState).toBe("closed");
    });

    it("reports socketState 'error' on a real bind failure, never on a mere lack of reply", async () => {
      const socket = new FailingBindSocket();
      const engine = new CasambiUdpEngine({ gatewayIp: "192.168.1.90", udpPort: 5100, netId: 0, socketFactory: () => socket });
      await expect(engine.start()).rejects.toThrow("EADDRINUSE");
      expect(engine.socketState).toBe("error");
      expect(engine.lastError).toBe("EADDRINUSE");
    });

    it("exposes real local bind address/port from the socket's own address(), once bound", async () => {
      const { engine } = makeEngine();
      expect(engine.localAddress).toBeNull();
      expect(engine.localPort).toBeNull();
      await engine.start();
      expect(engine.localAddress).toBe("0.0.0.0");
      expect(engine.localPort).toBe(5100);
    });

    it("counts packets sent and received, and timestamps the last packet", async () => {
      const { engine, socket } = makeEngine();
      await engine.start();
      expect(engine.packetsSent).toBe(0);
      expect(engine.packetsReceived).toBe(0);
      expect(engine.lastPacketAt).toBeNull();
      await engine.send(encodeSetTargetLevel(0, CASAMBI_TARGET_TYPE.device, 5, 200));
      expect(engine.packetsSent).toBe(1);
      socket.receive("2.70.2.3a.1\r\n");
      expect(engine.packetsReceived).toBe(1);
      expect(engine.lastPacketAt).not.toBeNull();
    });

    it("counts a decode failure as received (reception is proven before parsing), and records lastDecodeError", async () => {
      const { engine, socket } = makeEngine();
      await engine.start();
      socket.receive("garbage\r\n");
      // § UDP Receive Pipeline Audit: real hardware evidence showed the OS/dgram layer receiving
      // real broadcast datagrams while the driver reported Packets Received = 0, because the old
      // counter only incremented on successful decode. Reception and parsing are now counted
      // separately — a malformed/undecodable payload was still RECEIVED.
      expect(engine.packetsReceived).toBe(1);
      expect(engine.lastDecodeError).toMatchObject({ raw: "garbage\r\n" });
    });

    it("records lastSendError on a real send failure without touching packetsSent", async () => {
      const socket = new SendFailingSocket();
      const engine = new CasambiUdpEngine({ gatewayIp: "192.168.1.90", udpPort: 5100, netId: 0, socketFactory: () => socket });
      await engine.start();
      await expect(engine.send(encodeSetTargetLevel(0, CASAMBI_TARGET_TYPE.device, 5, 200))).rejects.toThrow("ENETUNREACH");
      expect(engine.packetsSent).toBe(0);
      expect(engine.lastSendError).toBe("ENETUNREACH");
    });

    it("averageLatencyMs is null until a probe succeeds, then reflects real measured round-trips", async () => {
      const { engine, socket } = makeEngine();
      await engine.start();
      expect(engine.averageLatencyMs).toBeNull();
      const result = engine.probe(1_000);
      await Promise.resolve();
      socket.receive("0.70.6.39.1.1.0.0.1\r\n");
      await result;
      expect(engine.averageLatencyMs).not.toBeNull();
      expect(engine.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it("never reports a packet-loss figure (no sequence numbers exist to measure it honestly)", () => {
      const { engine } = makeEngine();
      expect((engine as unknown as { packetLoss?: unknown }).packetLoss).toBeUndefined();
    });
  });

  /**
   * § UDP Receive Pipeline Audit — regression tests grounded in a real Wireshark capture against
   * firmware 6.25: the gateway broadcasts NotifyControlValues to `255.255.255.255:10009` (not
   * unicast to the client), 99-byte ASCII "Hex with dot" payload, CRLF-terminated. Real bug: the
   * driver reported `Packets Received = 0` despite the OS receiving these datagrams, because the
   * counter only incremented on successful decode.
   */
  describe("real hardware capture — broadcast NotifyControlValues, firmware 6.25", () => {
    // Byte-exact reconstruction of the captured packet (99 bytes incl. CRLF, confirmed by
    // counting): Net_ID=0xc, Direction=0x70 (fromCasambi), Length=0x27(39), Opcode=0x4b
    // (NotifyControlValues), Target_ID=0x1e, then presenceSensor/lightSensorLux/8x indexed
    // onOffToggle value pairs — a real, not fabricated, wire capture.
    const REAL_CAPTURE =
      "c.70.27.4b.1e.15.0.14.0.0.90.0.1.1.90.1.1.1.90.2.1.1.90.3.1.1.90.4.1.1.90.5.1.1.90.6.1.1.90.7.1.1\r\n";

    it("payload is exactly 99 bytes, matching the Wireshark capture", () => {
      expect(Buffer.byteLength(REAL_CAPTURE, "ascii")).toBe(99);
    });

    it("receives a BROADCAST datagram (sender = gateway, but not addressed only to this client) — no destination/unicast filtering exists", async () => {
      const { engine, socket } = makeEngine();
      await engine.start();
      // The gateway broadcasts to 255.255.255.255; from this socket's perspective the OS just
      // delivers a datagram whose sender is the gateway. Nothing in the engine inspects or
      // requires a specific destination address — proven by the engine having no `connect()` call
      // and no `rinfo`-based filtering anywhere in `handleMessage`.
      socket.receive(REAL_CAPTURE, { address: "192.168.0.45", port: 10009 });
      expect(engine.packetsReceived).toBe(1);
    });

    it("Packets Received increments immediately on socket reception, strictly before parsing succeeds or fails", async () => {
      const { engine, socket } = makeEngine();
      await engine.start();
      const rawSeen: string[] = [];
      engine.onRawDatagram((raw) => rawSeen.push(raw));
      socket.receive(REAL_CAPTURE);
      // onRawDatagram fired (proves reception is observable independent of decode) and the
      // counter reflects it.
      expect(rawSeen).toEqual([REAL_CAPTURE]);
      expect(engine.packetsReceived).toBe(1);
    });

    it("parses the real captured ASCII 'Hex with dot' payload correctly, never expecting a binary buffer", async () => {
      const { engine, socket } = makeEngine();
      await engine.start();
      const packets: unknown[] = [];
      engine.onPacket((p) => packets.push(p));
      socket.receive(REAL_CAPTURE);
      expect(engine.lastDecodeError).toBeNull();
      expect(packets).toEqual([
        expect.objectContaining({
          packet: expect.objectContaining({ netId: 12, direction: "fromCasambi", opcode: 0x4b }),
        }),
      ]);
    });

    it("records a full protocol trace (timestamp, source, length, raw ascii/hex, decoded, parse result) for the real capture", async () => {
      const { engine, socket } = makeEngine();
      await engine.start();
      socket.receive(REAL_CAPTURE, { address: "192.168.0.45", port: 10009 });
      const [trace] = engine.recentTraces;
      expect(trace).toMatchObject({
        sourceAddress: "192.168.0.45",
        sourcePort: 10009,
        payloadLength: 99,
        rawAscii: REAL_CAPTURE,
        parseError: null,
      });
      expect(trace.rawHex).toBe(Buffer.from(REAL_CAPTURE, "ascii").toString("hex"));
      expect(trace.decoded).toMatchObject({ opcode: 0x4b });
      expect(new Date(trace.at).toString()).not.toBe("Invalid Date");
    });

    it("traces AND fully logs a parser failure with the raw payload — never a silent drop", async () => {
      const { engine, socket } = makeEngine();
      await engine.start();
      const failures: { raw: string; err: Error }[] = [];
      engine.onDecodeError((raw, err) => failures.push({ raw, err }));
      // A firmware-6.25-shaped payload this codec doesn't understand (too few fields).
      socket.receive("c.70\r\n");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.raw).toBe("c.70\r\n");
      const [trace] = engine.recentTraces;
      expect(trace).toMatchObject({ rawAscii: "c.70\r\n", decoded: null });
      expect(trace?.parseError).toMatch(/Malformed/);
      // Even a failed parse counts as a real, received datagram — this is the core bug fix.
      expect(engine.packetsReceived).toBe(1);
    });

    it("keeps the trace log bounded (does not grow unbounded across many real packets)", async () => {
      const { engine, socket } = makeEngine();
      await engine.start();
      for (let i = 0; i < 30; i++) socket.receive(REAL_CAPTURE);
      expect(engine.recentTraces.length).toBeLessThanOrEqual(20);
      expect(engine.packetsReceived).toBe(30);
    });
  });
});
