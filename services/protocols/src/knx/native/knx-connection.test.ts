import { afterEach, describe, expect, it } from "vitest";
import { KnxConnectionError } from "./knx-connection.js";
import { ServiceType } from "./knxnetip-frame.js";
import { KnxHealthMonitor } from "../health/health-monitor.js";
import { GA, IA, createWorld, type World } from "./simulator/test-world.js";

/** SIMULATOR ONLY: NativeKnxConnection against a virtual gateway and line. Not hardware evidence. */
let w: World;
const open = async (o: Parameters<World["connection"]>[0] = {}) => { w = w ?? createWorld(); const c = w.connection(o); await w.until(c.connect()); return c; };
const fresh = (...a: Parameters<typeof createWorld>) => { w = createWorld(...a); return w; };
const settle = (ms = 30) => w.clock.advance(ms);
const kick = () => w.iface.kickChannel(w.tunnels[w.tunnels.length - 1]!.diagnostics().channelId!);

afterEach(async () => {
  for (const c of w.connections) { const p = c.disconnect(); await w.clock.advance(100); await p; }
  await w.clock.advance(300_000);
  w.iface.shutdown();
  expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 }); // nothing any test started may outlive it
});

describe("lifecycle", () => {
  it("connects, group-writes the encoded value, and resolves on transport acceptance only", async () => {
    fresh();
    const act = w.actuator("1.1.1", "1/0/1", "1/1/1");
    const c = await open();
    const res = await w.until(c.writeDetailed("1/0/1", true, "DPT1.001"));
    expect(res).toMatchObject({ evidence: "transport_accepted", transportAck: "ack", attempts: 1 });
    await settle();
    expect(act.state).toBe(true);
    expect(await w.until(res.confirmation)).toBe("confirmed"); // the line carried it; still not "a device did something"
    expect(c.diagnostics().writes).toEqual({ attempted: 1, accepted: 1, notSent: 0, unknown: 0 });
  });

  it("concurrent connect() calls share one attempt (one tunnel, one gateway slot)", async () => {
    fresh();
    const c = w.connection();
    await w.until(Promise.all([c.connect(), c.connect(), c.connect()]));
    expect(w.tunnels).toHaveLength(1);
    expect(w.iface.counters.connects).toBe(1);
    expect(c.linkState).toBe("up");
  });

  it("a failed first connect rejects with the real error and leaves NO timer, socket, listener or retry loop behind", async () => {
    fresh();
    w.iface.faults.refuseConnectStatus = 0x24;
    const c = w.connection();
    await expect(w.until(c.connect())).rejects.toMatchObject({ code: "connect_rejected" });
    expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
    expect(c.linkState).toBe("idle");
    await w.clock.advance(600_000); // ten minutes: a hidden retry loop would have hammered the gateway
    expect(w.iface.counters.refusedConnects).toBe(1);
    expect(w.tunnels).toHaveLength(1);
    w.iface.faults.refuseConnectStatus = null; // the CALLER's retry (the gateway's 60 s loop) still works on the same instance
    await w.until(c.connect());
    expect(c.linkState).toBe("up");
  });

  it("disconnect() closes the tunnel, releases every observer, is idempotent and final", async () => {
    fresh();
    const c = await open();
    const seen: unknown[] = [];
    c.observe("1/1/1", "DPT1.001", (v) => seen.push(v));
    const d1 = c.disconnect(); const d2 = c.disconnect();
    await w.until(Promise.all([d1, d2]));
    expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
    expect(c.diagnostics().bus).toMatchObject({ activeSubscriptions: 0, closed: true });
    await expect(c.write("1/0/1", true, "DPT1.001")).rejects.toMatchObject({ code: "closed", outcome: "not_sent" });
    await expect(c.connect()).rejects.toMatchObject({ code: "closed" });
    w.sender.emit(w.bus, GA("1/1/1"), "1.001", true);
    await settle();
    expect(seen).toEqual([]);
    expect(c.observe("1/1/1", "DPT1.001", () => undefined)).toBeTypeOf("function"); // late observe: inert, never throws
  });

  it("disconnect() during the first connect releases the caller at once; the half-open handshake then runs out its own timeout and leaves nothing", async () => {
    fresh();
    w.iface.faults.online = false; // gateway silent: the handshake would wait out the 5 s connect timeout
    const c = w.connection();
    const pending = c.connect();
    pending.catch(() => undefined);
    await settle(10);
    const t0 = w.clock.now();
    await w.until(c.disconnect());
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(w.clock.now() - t0).toBeLessThan(1000);
    expect(c.diagnostics().link.attachedTunnels).toBe(0);
    await w.clock.advance(6_000);
    expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
  });

  it("disconnect() while a SLOW but answering gateway is still handshaking does not orphan a gateway channel: the late tunnel is closed orderly", async () => {
    fresh();
    w.net.addRule({ match: (p) => p.service === ServiceType.CONNECT_RESPONSE, action: "delay", delayMs: 1_500 });
    const c = w.connection();
    const pending = c.connect();
    pending.catch(() => undefined);
    await settle(100); // CONNECT_REQUEST processed by the gateway (channel allocated); the response is still in the network
    expect(w.iface.activeChannels).toBe(1);
    await w.until(c.disconnect());
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    await w.clock.advance(3_000); // the late CONNECT_RESPONSE arrives → orderly DISCONNECT_REQUEST for the now-known channel
    expect(w.iface.activeChannels).toBe(0);
    expect(c.diagnostics().link.attachedTunnels).toBe(0);
    expect(w.iface.counters.disconnects).toBe(1);
  });

  it("100 connect/disconnect cycles leave no timer, socket, channel or subscription", async () => {
    fresh();
    for (let i = 0; i < 100; i++) {
      const c = w.connection();
      await w.until(c.connect());
      c.observe("1/1/1", "DPT1.001", () => undefined);
      await w.until(c.disconnect());
    }
    expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
    expect(w.iface.counters.connects).toBe(100);
    expect(w.connections.every((c) => c.diagnostics().bus.activeSubscriptions === 0)).toBe(true);
  });
});

describe("connection loss and recovery (supervisor owns an established link)", () => {
  it("a gateway-initiated disconnect recovers on its own; subscriptions survive, never duplicate, and exactly ONE tunnel is attached", async () => {
    fresh();
    const c = await open();
    const seen: boolean[] = [];
    c.observe("1/1/1", "DPT1.001", (v) => seen.push(v as boolean));
    kick();
    await w.clock.advance(1_000);
    expect(c.linkState).toBe("recovering");
    await w.clock.advance(10_000);
    expect(c.linkState).toBe("up");
    expect(w.tunnels).toHaveLength(2);
    expect(c.diagnostics().link.attachedTunnels).toBe(1);
    expect(w.iface.activeChannels).toBe(1);
    w.sender.emit(w.bus, GA("1/1/1"), "1.001", true);
    await settle();
    expect(seen).toEqual([true]); // exactly once: no duplicate feed, no duplicate subscription
    expect(c.diagnostics().bus.activeSubscriptions).toBe(1);
  });

  it("a gateway outage backs off, writes fail visibly as not_sent while down, and the link returns when the gateway does", async () => {
    fresh();
    const c = await open();
    w.iface.reboot(30_000);
    await w.clock.advance(28_000);
    expect(c.linkState).toBe("recovering");
    await expect(c.write("1/0/1", true, "DPT1.001")).rejects.toMatchObject({ code: "not_connected", outcome: "not_sent" });
    await w.clock.advance(60_000);
    expect(c.linkState).toBe("up");
    const m = c.diagnostics().link.supervisor;
    expect(m.failedReconnects).toBeGreaterThanOrEqual(1);
    expect(m.successfulReconnects).toBe(1);
    await w.until(c.write("1/0/1", true, "DPT1.001")); // usable again
  });

  it("disconnect() during the reconnect backoff cancels it: no further attempt is ever made", async () => {
    fresh();
    const c = await open();
    kick();
    await w.clock.advance(500); // the tunnel closed, the 2 s backoff timer is pending
    expect(c.linkState).toBe("recovering");
    expect(c.diagnostics().link.attemptInFlight).toBe(false);
    const before = w.iface.counters.connects;
    await w.until(c.disconnect());
    await w.clock.advance(600_000);
    expect(w.iface.counters.connects).toBe(before);
    expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
  });

  it("disconnect() while a recovery attempt is in flight leaves no tunnel behind, even if the gateway answers late", async () => {
    fresh();
    const c = await open();
    kick();
    w.iface.faults.online = false; // the gateway goes silent right after it drops us
    await w.clock.advance(3_000); // backoff elapsed: an attempt is now waiting on a silent gateway
    expect(c.diagnostics().link.attemptInFlight).toBe(true);
    const d = c.disconnect();
    w.iface.faults.online = true; // late answer
    await w.until(d);
    await w.clock.advance(120_000);
    expect(w.iface.activeChannels).toBe(0);
    expect(w.leaks()).toEqual({ timers: 0, sockets: 0, channels: 0 });
  });

  it("a hook attached via onLinkUp (a health monitor) is started on every link-up and stopped on every link-down and on disconnect — never stale, never doubled", async () => {
    fresh();
    let starts = 0;
    let monitor: KnxHealthMonitor | null = null;
    const c = w.connection({
      onLinkUp: ({ bus }) => {
        const m = new KnxHealthMonitor(w.clock, { readGroup: async () => undefined });
        monitor = m; starts++;
        const sub = bus.subscribe((t) => m.observeTelegram({ source: t.source, destination: t.destination, service: t.service }));
        m.start();
        return () => { sub.unsubscribe(); m.stop(); };
      },
    });
    await w.until(c.connect());
    expect(starts).toBe(1);
    expect(monitor!.isRunning).toBe(true);
    const first = monitor!;
    kick();
    await w.clock.advance(1_000);
    expect(first.isRunning).toBe(false); // stopped the moment the link dropped
    await w.clock.advance(10_000);
    expect(starts).toBe(2);
    expect(monitor!.isRunning).toBe(true);
    expect(c.diagnostics().bus.activeSubscriptions).toBe(1); // the old monitor's subscription is gone
    await w.until(c.disconnect());
    expect(monitor!.isRunning).toBe(false);
    expect(c.diagnostics().hookErrors).toBe(0);
  });
});

describe("observers and telegram feedback attribution", () => {
  it("delivers a device's status telegram with its source address; a connection never sees the echo of its own write", async () => {
    fresh();
    const act = w.actuator("1.1.7", "1/0/1", "1/1/1");
    const c = await open();
    const fb: Array<{ v: unknown; source: number; service: string }> = [];
    const own: unknown[] = [];
    c.observeTelegrams("1/1/1", "DPT1.001", (v, m) => fb.push({ v, source: m.source, service: m.service }));
    c.observe("1/0/1", "DPT1.001", (v) => own.push(v)); // observing the COMMAND address
    await w.until(c.write("1/0/1", true, "DPT1.001"));
    await settle();
    expect(act.state).toBe(true);
    expect(fb).toEqual([{ v: true, source: IA("1.1.7"), service: "write" }]);
    expect(own).toEqual([]); // transport acceptance / own echo is never feedback
  });

  it("receives GroupValueWrite and GroupValueResponse, never GroupValueRead", async () => {
    fresh();
    w.actuator("1.1.7", "1/0/1", "1/1/1");
    const c = await open();
    const svc: string[] = [];
    c.observeTelegrams("1/1/1", "DPT1.001", (_v, m) => svc.push(m.service));
    w.bus.transmit({ source: IA("1.1.50"), destination: GA("1/1/1"), service: "read", data: null });
    await settle();
    expect(svc).toEqual(["response"]); // only the actuator's answer to that read; the read itself is not delivered
    expect(c.diagnostics().decodeFailures).toEqual({}); // filtered by service, not "dropped because a read has no payload to decode"
  });

  it("decodes per DPT and isolates observers: two on one GA, one unsubscribed, one throwing", async () => {
    fresh();
    const c = await open();
    const a: unknown[] = []; const b: unknown[] = [];
    const offA = c.observe("1/2/3", "DPT9.001", (v) => a.push(v));
    c.observe("1/2/3", "DPT9.001", () => { throw new Error("handler bug"); });
    c.observe("1/2/3", "DPT9.001", (v) => b.push(v));
    w.sender.emit(w.bus, GA("1/2/3"), "9.001", 21.5);
    await settle();
    offA(); offA();
    w.sender.emit(w.bus, GA("1/2/3"), "9.001", 22);
    await settle();
    expect(a).toEqual([21.5]);
    expect(b).toEqual([21.5, 22]);
    expect(c.diagnostics().bus.listenerErrors).toBe(2);
  });

  it("drops undecodable payloads (wrong size, 0x7FFF invalid marker), counts them, and keeps delivering later good values", async () => {
    fresh();
    const c = await open();
    const got: unknown[] = [];
    c.observe("1/2/3", "DPT9.001", (v) => got.push(v));
    const raw = (b: number[]) => w.bus.transmit({ source: IA("1.1.50"), destination: GA("1/2/3"), service: "write", data: { kind: "bytes", bytes: Buffer.from(b) } });
    raw([0x01, 0x02, 0x03]); raw([0x7f, 0xff]); raw([0x0c, 0x1a]); // 3 octets · invalid marker · 21
    await settle();
    expect(got).toEqual([21]);
    expect(c.diagnostics().decodeFailures).toEqual({ bad_payload: 1, invalid_data: 1 });
  });

  it("an invalid group address or unsupported DPT yields an inert observer recorded in diagnostics — it never throws into the driver", async () => {
    fresh();
    const c = await open();
    const offs = [c.observe("not-a-ga", "DPT1.001", () => undefined), c.observe("1/1/1", "DPT99.999", () => undefined)];
    offs.forEach((o) => o());
    const d = c.diagnostics();
    expect(d.rejectedObservers).toBe(2);
    expect(d.lastRejectedObservers.map((r) => r.groupAddress)).toEqual(["not-a-ga", "1/1/1"]);
    expect(d.bus.activeSubscriptions).toBe(0);
  });
});

describe("reads and response correlation", () => {
  it("correlates the GroupValueResponse on the read address and reports who answered", async () => {
    fresh();
    w.actuator("1.1.7", "1/0/1", "1/1/1", "1.001", true);
    const c = await open();
    const r = await w.until(c.read("1/1/1", "DPT1.001"));
    expect(r).toMatchObject({ outcome: "value", value: true, source: IA("1.1.7") });
    expect(c.diagnostics().reads).toMatchObject({ attempted: 1, answered: 1, pending: 0 });
    expect(c.diagnostics().bus.activeSubscriptions).toBe(0);
  });

  it("times out as a plain 'timeout' (unknown, not offline); a late response does not resurrect the call but still reaches observers", async () => {
    fresh();
    const a = w.actuator("1.1.7", "1/0/1", "1/1/1", "1.001", true);
    a.faults = { feedbackDelayMs: 5_000 };
    const c = await open();
    const seen: unknown[] = [];
    c.observe("1/1/1", "DPT1.001", (v) => seen.push(v));
    const r = await w.until(c.read("1/1/1", "DPT1.001", { timeoutMs: 1_000 }), 2_000);
    expect(r).toEqual({ outcome: "timeout" });
    await w.clock.advance(5_000);
    expect(seen).toEqual([true]);
    expect(c.diagnostics().reads).toMatchObject({ timedOut: 1, answered: 0, pending: 0 });
  });

  it("does not accept a spontaneous GroupValueWrite or a malformed response as the answer", async () => {
    fresh();
    const c = await open();
    const p = c.read("1/1/1", "DPT9.001", { timeoutMs: 500 });
    w.sender.emit(w.bus, GA("1/1/1"), "9.001", 20); // a write, not a response
    w.bus.transmit({ source: IA("1.1.50"), destination: GA("1/1/1"), service: "response", data: { kind: "bytes", bytes: Buffer.from([1]) } }); // wrong size
    expect(await w.until(p, 1_000)).toEqual({ outcome: "timeout" });
    expect(c.diagnostics().decodeFailures).toEqual({ bad_payload: 1 });
  });

  it("serves many simultaneous callers: independent GAs and a shared GA; the cap rejects the overflow as not_sent", async () => {
    fresh();
    for (let i = 0; i < 10; i++) w.actuator(`1.1.${10 + i}`, `2/0/${i}`, `2/1/${i}`, "1.001", i % 2 === 0);
    const c = await open({ maxPendingReads: 12 });
    const reads = Array.from({ length: 10 }, (_, i) => c.read(`2/1/${i}`, "DPT1.001"));
    const shared = [c.read("2/1/0", "DPT1.001"), c.read("2/1/0", "DPT1.001")];
    await expect(c.read("2/1/9", "DPT1.001")).rejects.toMatchObject({ code: "read_limit", outcome: "not_sent" });
    const results = await w.until(Promise.all([...reads, ...shared]), 3_000);
    expect(results.slice(0, 10).map((r) => (r.outcome === "value" ? r.value : r.outcome))).toEqual([true, false, true, false, true, false, true, false, true, false]);
    expect(results.slice(10).map((r) => (r.outcome === "value" ? r.value : r.outcome))).toEqual([true, true]); // both callers on the shared GA get the answer
    expect(c.diagnostics().reads).toMatchObject({ pending: 0, answered: 12 });
    expect(c.diagnostics().bus.activeSubscriptions).toBe(0);
  });

  it("an AbortSignal cancels one read without touching the others", async () => {
    fresh();
    w.actuator("1.1.10", "2/0/0", "2/1/0", "1.001", true);
    const c = await open();
    const ac = new AbortController();
    const aborted = c.read("2/1/5", "DPT1.001", { signal: ac.signal, timeoutMs: 10_000 });
    const other = c.read("2/1/0", "DPT1.001");
    ac.abort();
    expect(await aborted).toEqual({ outcome: "cancelled", reason: "aborted" });
    expect(await w.until(other)).toMatchObject({ outcome: "value", value: true });
    expect(await c.read("2/1/0", "DPT1.001", { signal: ac.signal })).toEqual({ outcome: "cancelled", reason: "aborted" }); // already-aborted: nothing sent
    expect(c.diagnostics().reads.pending).toBe(0);
  });

  it("disconnect() cancels pending reads", async () => {
    fresh();
    const c = await open();
    const p = c.read("7/7/9", "DPT1.001", { timeoutMs: 60_000 });
    await settle(5);
    await w.until(c.disconnect());
    expect(await p).toEqual({ outcome: "cancelled", reason: "disconnected" });
  });

  it("read while the link is down rejects not_sent and sends nothing", async () => {
    fresh();
    const c = await open();
    w.iface.reboot(60_000);
    await w.clock.advance(30_000);
    const before = w.iface.counters.tunnellingRequests;
    await expect(c.read("1/1/1", "DPT1.001")).rejects.toMatchObject({ code: "not_connected", outcome: "not_sent" });
    expect(w.iface.counters.tunnellingRequests).toBe(before);
  });
});

describe("write outcomes and boundaries", () => {
  it.each([
    ["invalid group address", "a/b/c", true, "DPT1.001", "invalid_address"],
    ["unsupported DPT", "1/2/3", true, "DPT99.001", "invalid_dpt"],
    ["value invalid for the DPT", "1/2/3", "on", "DPT1.001", "invalid_value"],
    ["out-of-range value", "1/2/3", 300, "DPT5.001", "invalid_value"],
  ])("rejects %s as not_sent before any frame is built", async (_n, ga, value, dpt, code) => {
    fresh();
    const c = await open();
    const before = w.iface.counters.tunnellingRequests;
    await expect(c.write(ga, value as never, dpt)).rejects.toMatchObject({ code, outcome: "not_sent" });
    await settle();
    expect(w.iface.counters.tunnellingRequests).toBe(before);
    expect(c.diagnostics().writes).toMatchObject({ attempted: 1, accepted: 0, notSent: 1 });
  });

  it("a gateway that never ACKs yields an UNKNOWN outcome (it may still have been sent) and the link then recovers on its own", async () => {
    fresh();
    const c = await open();
    w.iface.faults.dropAcks = true;
    const err = await w.until(c.write("1/0/1", true, "DPT1.001").then(() => null, (e: unknown) => e), 5_000);
    expect(err).toBeInstanceOf(KnxConnectionError);
    expect(err).toMatchObject({ outcome: "unknown", code: "tunnel", tunnelCode: "ack_timeout" });
    w.iface.faults.dropAcks = false;
    await w.clock.advance(30_000);
    expect(c.linkState).toBe("up");
    expect(c.diagnostics().writes).toMatchObject({ unknown: 1 });
  });

  it("transport acceptance without a bus confirmation is reported as not_confirmed — an unknown, never a device claim", async () => {
    fresh();
    w.iface.faults.suppressConfirmation = true;
    const c = await open();
    const res = await w.until(c.writeDetailed("1/0/1", true, "DPT1.001"));
    expect(res.evidence).toBe("transport_accepted");
    expect(await w.until(res.confirmation, 30_000)).toBe("not_confirmed");
  });

  it("50 simultaneous writes all go out, in order, on one tunnel", async () => {
    fresh();
    const c = await open();
    const sent: number[] = [];
    const off = w.bus.monitor((t) => { if (t.service === "write" && t.data?.kind === "bytes") sent.push(t.data.bytes[0]!); });
    const ps = Array.from({ length: 50 }, (_, i) => c.write(`3/0/${i}`, i, "DPT5.010"));
    await w.until(Promise.all(ps), 5_000);
    off();
    expect(sent).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(c.diagnostics().writes).toMatchObject({ attempted: 50, accepted: 50 });
  });

  it("a full send queue rejects the overflow as not_sent and still sends the accepted frames", async () => {
    fresh({ tunnel: { maxQueuedSends: 2 } });
    const c = await open();
    const ps = Array.from({ length: 6 }, (_, i) => c.write(`3/0/${i}`, true, "DPT1.001").then(() => "ok", (e: KnxConnectionError) => `${e.code}:${e.outcome}:${e.tunnelCode}`));
    const r = await w.until(Promise.all(ps), 5_000);
    expect(r.filter((x) => x === "ok")).toHaveLength(3); // one in flight + two queued
    expect(r.filter((x) => x === "tunnel:not_sent:queue_full")).toHaveLength(3);
  });
});

describe("observe-only mode (the shadow-mode enforcement point)", () => {
  it("receives and decodes traffic but refuses write() and read() before any frame is built", async () => {
    fresh();
    const c = await open({ mode: "observe_only" });
    const got: unknown[] = [];
    c.observe("1/2/3", "DPT9.001", (v) => got.push(v));
    w.sender.emit(w.bus, GA("1/2/3"), "9.001", 19.5);
    await settle();
    expect(got).toEqual([19.5]);
    const before = w.iface.counters.tunnellingRequests;
    await expect(c.write("1/0/1", true, "DPT1.001")).rejects.toMatchObject({ code: "observe_only", outcome: "not_sent" });
    await expect(c.read("1/1/1", "DPT1.001")).rejects.toMatchObject({ code: "observe_only", outcome: "not_sent" });
    await settle();
    expect(w.iface.counters.tunnellingRequests).toBe(before);
  });

  it("[simulator model only] a second observe-only connection sees the telegrams the first one wrote, and adds no bus traffic of its own", async () => {
    fresh();
    const live = await open();
    const shadow = await open({ mode: "observe_only" });
    const seen: Array<{ v: unknown; source: number }> = [];
    shadow.observeTelegrams("1/0/1", "DPT1.001", (v, m) => seen.push({ v, source: m.source }));
    const before = w.iface.counters.tunnellingRequests;
    await w.until(live.write("1/0/1", true, "DPT1.001"));
    await settle();
    expect(seen).toEqual([{ v: true, source: 0xff01 }]);              // attributed to the writing tunnel's individual address
    expect(w.iface.counters.tunnellingRequests - before).toBe(1);      // exactly the live write; the shadow sent nothing (its ACKs/heartbeats are not L_Data.req)
    expect(w.iface.activeChannels).toBe(2);                            // …but it DID consume a second tunnel slot
  });
});
