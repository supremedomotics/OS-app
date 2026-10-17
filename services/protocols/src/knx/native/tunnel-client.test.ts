import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseGroupAddress } from "./address.js";
import type { CemiFrame } from "./cemi.js";
import { encodeDpt } from "./dpt.js";
import { ServiceType } from "./knxnetip-frame.js";
import { KnxTunnelClient, KnxTunnelError, type TunnelClientOptions } from "./tunnel-client.js";
import type { KnxDatagramSocket, SocketFactory } from "./transport.js";
import { ManualClock, VirtualActuator, VirtualKnxBus, VirtualKnxInterface, VirtualNetwork, VirtualSender } from "./simulator/index.js";

const GW = "10.0.0.2";
const LIGHT_CMD = parseGroupAddress("1/1/1");
const LIGHT_FB = parseGroupAddress("1/1/2");
const SWITCH_IA = 0x1105;

let clock: ManualClock;
let net: VirtualNetwork;
let bus: VirtualKnxBus;
let gw: VirtualKnxInterface;
let light: VirtualActuator;
let clients: KnxTunnelClient[];

beforeEach(() => {
  clock = new ManualClock();
  net = new VirtualNetwork(clock, 1);
  bus = new VirtualKnxBus(clock);
  gw = new VirtualKnxInterface(net, bus, clock, { address: GW });
  light = new VirtualActuator({ individualAddress: 0x1101, commandGa: LIGHT_CMD, feedbackGa: LIGHT_FB, dpt: "1.001", initial: false }, clock);
  bus.addDevice(light);
  clients = [];
});

afterEach(async () => {
  // Resource-leak gate: after every scenario, once all clients are closed and the gateway shut
  // down, no timer and no client socket may remain.
  for (const c of clients) { void c.disconnect(); }
  await clock.advance(10_000);
  gw.shutdown();
  expect(net.openClientSockets).toBe(0);
  expect(clock.pendingTimers).toBe(0);
});

function make(over: Partial<TunnelClientOptions> = {}, factory?: SocketFactory, clientIp = "10.0.0.50"): KnxTunnelClient {
  const c = new KnxTunnelClient({ host: GW, socketFactory: factory ?? net.createSocketFactory(clientIp), clock, ...over });
  clients.push(c);
  return c;
}

async function connected(over: Partial<TunnelClientOptions> = {}, ip = "10.0.0.50"): Promise<KnxTunnelClient> {
  const c = make(over, undefined, ip);
  const p = c.connect();
  await clock.advance(5);
  await p;
  return c;
}

const onFrame = (c: KnxTunnelClient): CemiFrame[] => { const got: CemiFrame[] = []; c.onTelegram((f) => got.push(f)); return got; };
const ON = { destination: LIGHT_CMD, service: "write" as const, data: encodeDpt("1.001", true) };

describe("connect", () => {
  it("establishes a tunnel, learns its assigned address and measures connect latency", async () => {
    const c = await connected();
    expect(c.state).toBe("connected");
    expect(c.assignedAddress).toBe(0xff01);
    expect(c.diagnostics().channelId).toBe(1);
    expect(c.diagnostics().connectLatencyMs).toBe(2); // 1 ms each way on the virtual link
    expect(gw.activeChannels).toBe(1);
  });
  it("times out when the gateway is unreachable and releases everything", async () => {
    gw.faults.online = false;
    const c = make();
    const p = c.connect();
    const assertion = expect(p).rejects.toMatchObject({ code: "connect_timeout" });
    await clock.advance(10_000);
    await assertion;
    expect(c.state).toBe("closed");
    expect(c.diagnostics().closedReason).toBe("connect_timeout");
    expect(net.openClientSockets).toBe(0);
  });
  it("surfaces the gateway's refusal reason", async () => {
    gw.faults.refuseConnectStatus = 0x24;
    const c = make();
    const p = c.connect();
    const assertion = expect(p).rejects.toMatchObject({ code: "connect_rejected", status: 0x24, message: expect.stringMatching(/no more connections/) });
    await clock.advance(10);
    await assertion;
  });
  it("is single-use", async () => {
    const c = await connected();
    await expect(c.connect()).rejects.toBeInstanceOf(KnxTunnelError);
  });
  it("rejects a non-IPv4 host up front", () => {
    expect(() => new KnxTunnelClient({ host: "gateway.local", socketFactory: net.createSocketFactory("10.0.0.50") })).toThrow(KnxTunnelError);
  });
  it("fails cleanly when the socket cannot be opened", async () => {
    const c = make({}, () => { throw new Error("EADDRNOTAVAIL"); });
    await expect(c.connect()).rejects.toMatchObject({ code: "socket_error" });
    expect(c.state).toBe("closed");
  });
});

describe("group communication", () => {
  it("writes reach the bus, are ACKed and bus-confirmed; the actuator reacts and reports feedback", async () => {
    const c = await connected();
    const seen = onFrame(c);
    const receipt = await (async () => { const p = c.sendGroup(ON); await clock.advance(5); return p; })();
    expect(receipt.sequence).toBe(0);
    expect(receipt.attempts).toBe(1);
    expect(receipt.ackLatencyMs).toBe(2);
    await clock.advance(10);
    await expect(receipt.confirmation).resolves.toBe("confirmed");
    expect(light.state).toBe(true);
    // the actuator's own status write comes back as an indication from the actuator
    const fb = seen.find((f) => f.destination === LIGHT_FB);
    expect(fb?.source).toBe(0x1101);
    expect(fb?.group).toEqual({ service: "write", data: { kind: "short", value: 1 } });
    // the tunnel never sees its own command echoed back as an indication
    expect(seen.some((f) => f.destination === LIGHT_CMD)).toBe(false);
    expect(bus.history[0]?.source).toBe(0xff01);
  });
  it("delivers other participants' telegrams to every tunnel, exactly once each", async () => {
    const a = await connected({}, "10.0.0.50");
    const b = await connected({}, "10.0.0.51");
    const sa = onFrame(a), sb = onFrame(b);
    const wall = new VirtualSender(SWITCH_IA);
    bus.addDevice(wall);
    wall.emit(bus, LIGHT_CMD, "1.001", true);
    await clock.advance(20);
    expect(sa.filter((f) => f.destination === LIGHT_CMD)).toHaveLength(1);
    expect(sb.filter((f) => f.destination === LIGHT_CMD)).toHaveLength(1);
  });
  it("GroupValueRead is answered with a GroupValueResponse", async () => {
    const c = await connected();
    const seen = onFrame(c);
    void c.sendGroup({ destination: LIGHT_FB, service: "read" });
    await clock.advance(20);
    expect(seen.find((f) => f.group?.service === "response")?.destination).toBe(LIGHT_FB);
  });
  it("preserves order and survives sequence-number wrap-around", async () => {
    const c = await connected();
    let onBus = 0;
    bus.monitor((t) => { if (t.source === 0xff01 && t.destination === LIGHT_CMD) onBus++; });
    const receipts: Array<{ sequence: number }> = [];
    for (let batch = 0; batch < 6; batch++) { // 6 × 50 stays under the 64-frame queue bound
      const sent = Array.from({ length: 50 }, (_, j) => c.sendGroup({ destination: LIGHT_CMD, service: "write", data: encodeDpt("1.001", (batch * 50 + j) % 2 === 0) }));
      await clock.advance(500);
      receipts.push(...await Promise.all(sent));
    }
    expect(receipts.map((r) => r.sequence)).toEqual(Array.from({ length: 300 }, (_, i) => i & 0xff));
    expect(onBus).toBe(300); // every frame reached the line exactly once (no loss, no duplicate)
    expect(bus.history.length).toBeLessThanOrEqual(256); // history ring stays bounded
    expect(light.state).toBe(false); // 299 is odd → false: last write wins in order
  });
  it("validates arguments, queue bound and connection state", async () => {
    const early = make();
    await expect(early.sendGroup(ON)).rejects.toMatchObject({ code: "not_connected" });
    const c = await connected({ maxQueuedSends: 2 });
    await expect(c.sendGroup({ destination: LIGHT_CMD, service: "read", data: { kind: "short", value: 1 } })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(c.sendGroup({ destination: LIGHT_CMD, service: "write" })).rejects.toMatchObject({ code: "invalid_argument" });
    const ok = [c.sendGroup(ON), c.sendGroup(ON)]; // one goes in flight, one queued (cap=2 queued)
    const third = c.sendGroup(ON);
    const fourth = c.sendGroup(ON);
    await expect(fourth).rejects.toMatchObject({ code: "queue_full" });
    await clock.advance(50);
    await Promise.all([...ok, third]);
  });
});

describe("bus confirmation is separate from the tunnel ACK", () => {
  const send = async (c: KnxTunnelClient) => { const p = c.sendGroup(ON); await clock.advance(5); return p; };
  it("reports a bus-level error when the line is faulted, even though the gateway ACKed", async () => {
    const c = await connected();
    bus.lineFault = true;
    const r = await send(c);
    await clock.advance(20);
    await expect(r.confirmation).resolves.toBe("bus_error");
    expect(light.state).toBe(false);
  });
  it("reports not_confirmed when no L_Data.con arrives", async () => {
    const c = await connected();
    gw.faults.suppressConfirmation = true;
    const r = await send(c);
    await clock.advance(3000);
    await expect(r.confirmation).resolves.toBe("not_confirmed");
    expect(c.diagnostics().confirmations.notConfirmed).toBe(1);
  });
  it("honours a confirmation error flag from the gateway", async () => {
    const c = await connected();
    gw.faults.confirmationError = true;
    const r = await send(c);
    await clock.advance(20);
    await expect(r.confirmation).resolves.toBe("bus_error");
  });
});

describe("loss, retry and duplicates", () => {
  it("retransmits a request the gateway never received and succeeds on attempt 2", async () => {
    const c = await connected();
    net.addRule({ match: (p) => p.service === ServiceType.TUNNELLING_REQUEST && p.to.address === GW, action: "drop", times: 1 });
    const p = c.sendGroup(ON);
    await clock.advance(1100);
    const r = await p;
    expect(r.attempts).toBe(2);
    expect(c.diagnostics().sendRetries).toBe(1);
    expect(light.state).toBe(true);
  });
  it("does not execute a command twice when only the ACK was lost", async () => {
    const c = await connected();
    net.addRule({ match: (p) => p.service === ServiceType.TUNNELLING_ACK && p.from.address === GW, action: "drop", times: 1 });
    const p = c.sendGroup(ON);
    await clock.advance(1100);
    const r = await p;
    expect(r.attempts).toBe(2);
    expect(gw.counters.duplicateRequests).toBe(1);
    expect(bus.history.filter((t) => t.source === 0xff01 && t.destination === LIGHT_CMD)).toHaveLength(1);
  });
  it("terminates the tunnel and fails all queued sends after two unanswered attempts", async () => {
    const c = await connected();
    gw.faults.dropAcks = true;
    const closed: string[] = [];
    c.onClosed((e) => closed.push(e.reason));
    const first = c.sendGroup(ON);
    const second = c.sendGroup(ON);
    const a1 = expect(first).rejects.toMatchObject({ code: "ack_timeout" });
    const a2 = expect(second).rejects.toMatchObject({ code: "ack_timeout" });
    await clock.advance(2100);
    await Promise.all([a1, a2]);
    expect(c.state).toBe("closed");
    expect(closed).toEqual(["ack_timeout"]);
  });
  it("TUN §2.6.1 (G1): after the repeat is also unanswered, the client sends DISCONNECT_REQUEST so the gateway frees the channel", async () => {
    const c = await connected();
    gw.faults.dropAcks = true;
    expect(gw.activeChannels).toBe(1);
    const p = c.sendGroup(ON);
    const assertion = expect(p).rejects.toMatchObject({ code: "ack_timeout" });
    await clock.advance(2100);
    await assertion;
    expect(c.diagnostics().closedReason).toBe("ack_timeout");
    expect(gw.counters.disconnects).toBe(1); // the server saw and honoured the DISCONNECT_REQUEST
    expect(gw.activeChannels).toBe(0);
  });
  it("TUN §2.6.1 (G2): an error ACK is repeated once; if the repeat is ACKed normally the send succeeds", async () => {
    const c = await connected();
    gw.faults.ackStatus = 0x26;
    gw.faults.ackStatusTimes = 1; // first ACK carries an error, the repeat is answered normally
    const p = c.sendGroup(ON);
    await clock.advance(10);
    const r = await p;
    expect(r.attempts).toBe(2);
    expect(c.state).toBe("connected");
    expect(gw.activeChannels).toBe(1);
  });
  it("TUN §2.6.1 (G2): a persistent error ACK terminates the tunnel with DISCONNECT_REQUEST (any status, not only 0x26/0x27)", async () => {
    for (const status of [0x26, 0x21, 0x04]) {
      const c = await connected();
      gw.faults.ackStatus = status;
      gw.faults.ackStatusTimes = Number.POSITIVE_INFINITY;
      const p = c.sendGroup(ON);
      const assertion = expect(p).rejects.toMatchObject({ code: "ack_error", status });
      await clock.advance(20);
      await assertion;
      expect(c.state).toBe("closed");
      expect(c.diagnostics().closedReason).toBe("ack_error");
      expect(gw.activeChannels).toBe(0);
      gw.faults.ackStatus = null;
    }
  });
  it("delivers a duplicated inbound telegram once and re-ACKs", async () => {
    const c = await connected();
    const seen = onFrame(c);
    net.addRule({ match: (p) => p.service === ServiceType.TUNNELLING_REQUEST && p.from.address === GW, action: "duplicate", times: 1 });
    const wall = new VirtualSender(SWITCH_IA);
    bus.addDevice(wall);
    wall.emit(bus, LIGHT_CMD, "1.001", true);
    await clock.advance(50);
    expect(seen.filter((f) => f.destination === LIGHT_CMD)).toHaveLength(1);
    expect(c.diagnostics().duplicateInbound).toBe(1);
  });
  it("ignores out-of-order inbound requests without acknowledging them", async () => {
    const c = await connected();
    const seen = onFrame(c);
    // lose the first indication entirely → gateway retries (same seq) → client still in step
    net.addRule({ match: (p) => p.service === ServiceType.TUNNELLING_REQUEST && p.from.address === GW, action: "drop", times: 1 });
    const wall = new VirtualSender(SWITCH_IA);
    bus.addDevice(wall);
    wall.emit(bus, LIGHT_CMD, "1.001", true);
    await clock.advance(1500);
    expect(seen.filter((f) => f.destination === LIGHT_CMD)).toHaveLength(1);
  });
});

describe("malformed input", () => {
  it("counts a malformed frame, never crashes, and keeps working", async () => {
    const c = await connected();
    net.addRule({ match: (p) => p.service === ServiceType.TUNNELLING_REQUEST && p.from.address === GW, action: "corrupt", times: 1, corrupt: (b) => b.subarray(0, b.length - 3) });
    const errors: string[] = [];
    c.onDecodeError((e) => errors.push(`${e.layer}:${e.code}`));
    const wall = new VirtualSender(SWITCH_IA);
    bus.addDevice(wall);
    wall.emit(bus, LIGHT_CMD, "1.001", true); // delivered truncated → dropped
    await clock.advance(1500); // gateway retries after 1 s with the intact frame
    expect(errors).toEqual(["frame:length_mismatch"]);
    expect(c.diagnostics().malformedFrames).toEqual({ length_mismatch: 1 });
  });
  it("ACKs a well-framed tunnelling request carrying a malformed cEMI, counts it, and stays in sequence", async () => {
    const c = await connected();
    const seen = onFrame(c);
    // Break the NPDU length octet (frame stays structurally valid, cEMI becomes inconsistent).
    net.addRule({
      match: (p) => p.service === ServiceType.TUNNELLING_REQUEST && p.from.address === GW, action: "corrupt", times: 1,
      corrupt: (b) => { b[6 + 4 + 8] = 0x05; return b; },
    });
    const wall = new VirtualSender(SWITCH_IA);
    bus.addDevice(wall);
    wall.emit(bus, LIGHT_CMD, "1.001", true);
    await clock.advance(50);
    expect(c.diagnostics().malformedCemi).toEqual({ length_mismatch: 1 });
    expect(seen.filter((f) => f.destination === LIGHT_CMD)).toHaveLength(0);
    wall.emit(bus, LIGHT_CMD, "1.001", false); // next one flows: sequence stayed in step
    await clock.advance(50);
    expect(seen.filter((f) => f.destination === LIGHT_CMD)).toHaveLength(1);
    expect(gw.activeChannels).toBe(1);
  });
  it("ignores datagrams from an address that is not the gateway", async () => {
    let sock: KnxDatagramSocket | null = null;
    const inner = net.createSocketFactory("10.0.0.50");
    const c = make({}, async (h) => { sock = await inner(h); return sock; });
    const p = c.connect(); await clock.advance(5); await p;
    net.sendFrom({ address: "10.0.0.99", port: 3671 }, { address: "10.0.0.50", port: sock!.localPort }, Buffer.from("061002080008" + "0100", "hex"));
    await clock.advance(5);
    expect(c.diagnostics().foreignDatagrams).toBe(1);
    expect(c.state).toBe("connected");
  });
  it("isolates a throwing subscriber from the session and other subscribers", async () => {
    const c = await connected();
    const good = onFrame(c);
    c.onTelegram(() => { throw new Error("subscriber bug"); });
    const wall = new VirtualSender(SWITCH_IA);
    bus.addDevice(wall);
    wall.emit(bus, LIGHT_CMD, "1.001", true);
    await clock.advance(50);
    expect(good.filter((f) => f.destination === LIGHT_CMD)).toHaveLength(1);
    expect(c.diagnostics().listenerErrors).toBeGreaterThanOrEqual(1); // once per delivered telegram (command + actuator feedback)
    expect(c.state).toBe("connected");
  });
});

describe("heartbeat and session loss", () => {
  it("keeps a quiet session alive past the gateway's idle limit and records RTT", async () => {
    const c = await connected();
    await clock.advance(330_000); // interval re-arms after each response → 5 beats by 5.5 min
    expect(c.state).toBe("connected");
    const hb = c.diagnostics().heartbeat;
    expect(hb.sent).toBe(5);
    expect(hb.failures).toBe(0);
    expect(hb.lastRttMs).toBe(2);
    expect(gw.counters.idleDrops).toBe(0);
  });
  it("declares the tunnel lost after three unanswered heartbeats", async () => {
    const c = await connected();
    const closed: string[] = [];
    c.onClosed((e) => closed.push(e.reason));
    gw.faults.online = false;
    await clock.advance(60_000 + 3 * 10_000 + 100);
    expect(closed).toEqual(["heartbeat_lost"]);
    expect(c.diagnostics().heartbeat.failures).toBe(3);
  });
  it("recovers when the gateway comes back before the third heartbeat attempt", async () => {
    const c = await connected();
    gw.faults.online = false;
    await clock.advance(60_000 + 15_000);
    gw.faults.online = true;
    await clock.advance(30_000);
    expect(c.state).toBe("connected");
    expect(c.diagnostics().heartbeat.failures).toBeGreaterThanOrEqual(1);
  });
  it("detects a tunnel the gateway silently forgot (E_CONNECTION_ID on heartbeat)", async () => {
    const c = await connected();
    const closed: Array<{ reason: string; status?: number }> = [];
    c.onClosed((e) => closed.push({ reason: e.reason, ...(e.error?.status !== undefined ? { status: e.error.status } : {}) }));
    gw.dropChannel(1);
    await clock.advance(61_000);
    expect(closed).toEqual([{ reason: "heartbeat_lost", status: 0x21 }]);
  });
  it("handles a gateway reboot: session dies, a fresh client reconnects once it is back", async () => {
    const c = await connected();
    gw.reboot(20_000);
    await clock.advance(60_000 + 30_100);
    expect(c.state).toBe("closed");
    const c2 = await connected();
    expect(c2.state).toBe("connected");
  });
  it("answers and obeys a gateway-initiated disconnect", async () => {
    const c = await connected();
    const closed: string[] = [];
    c.onClosed((e) => closed.push(e.reason));
    gw.kickChannel(1);
    await clock.advance(10);
    expect(closed).toEqual(["gateway_disconnect"]);
    await expect(c.sendGroup(ON)).rejects.toMatchObject({ code: "not_connected" });
  });
});

describe("orderly disconnect", () => {
  it("tells the gateway, frees the channel and closes", async () => {
    const c = await connected();
    const p = c.disconnect();
    await clock.advance(10);
    await p;
    expect(c.state).toBe("closed");
    expect(c.diagnostics().closedReason).toBe("local_disconnect");
    expect(gw.activeChannels).toBe(0);
    expect(gw.counters.disconnects).toBe(1);
  });
  it("closes after the timeout even if the gateway never answers", async () => {
    const c = await connected();
    gw.faults.online = false;
    const p = c.disconnect();
    await clock.advance(5100);
    await p;
    expect(c.state).toBe("closed");
  });
  it("fails in-flight sends when disconnecting and is idempotent", async () => {
    const c = await connected();
    gw.faults.dropAcks = true;
    const s = c.sendGroup(ON);
    const assertion = expect(s).rejects.toMatchObject({ code: "closed" });
    const d1 = c.disconnect(); const d2 = c.disconnect();
    await clock.advance(5100);
    await Promise.all([assertion, d1, d2]);
    await c.disconnect();
  });
  it("disconnect during connect aborts cleanly", async () => {
    gw.faults.online = false;
    const c = make();
    const p = c.connect();
    const assertion = expect(p).rejects.toBeInstanceOf(KnxTunnelError);
    await clock.advance(1);
    await c.disconnect();
    await assertion;
    expect(c.state).toBe("closed");
  });
});

describe("resource bounds across many reconnects", () => {
  it("50 connect/fail/reconnect cycles leave no timers, sockets or channels behind", async () => {
    for (let i = 0; i < 50; i++) {
      const c = await connected();
      if (i % 2 === 0) { const d = c.disconnect(); await clock.advance(10); await d; }
      else { gw.dropChannel(c.diagnostics().channelId!); await clock.advance(61_000); }
      expect(c.state).toBe("closed");
    }
    expect(gw.activeChannels).toBe(0);
    expect(net.openClientSockets).toBe(0);
  });
});
