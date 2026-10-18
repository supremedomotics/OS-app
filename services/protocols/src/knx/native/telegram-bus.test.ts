import { describe, expect, it } from "vitest";
import { encodeGroupCemi, decodeCemi, CemiMessageCode } from "./cemi.js";
import { KnxBusError, NativeTelegramBus, telegramFromCemi, type NativeTelegram, type TelegramInput } from "./telegram-bus.js";

const W = (destination: number, v = 1, source = 0x1101): TelegramInput => ({ source, destination, service: "write", data: { kind: "short", value: v } });

describe("NativeTelegramBus — subscriptions", () => {
  it("delivers to every subscriber of a group address, in subscription order, with the source attached", () => {
    const bus = new NativeTelegramBus();
    const order: string[] = [];
    bus.subscribe((t) => order.push(`a:${t.source.toString(16)}`), { destination: 10 });
    bus.subscribe(() => order.push("wild"));
    bus.subscribe(() => order.push("b"), { destination: 10 });
    bus.subscribe(() => order.push("other"), { destination: 11 });
    expect(bus.publish(W(10))).toBe("delivered");
    expect(order).toEqual(["a:1101", "wild", "b"]);
  });

  it("unsubscribe removes exactly one handle and is idempotent", () => {
    const bus = new NativeTelegramBus();
    const a: number[] = []; const b: number[] = [];
    const sa = bus.subscribe((t) => a.push(t.seq), { destination: 5 });
    bus.subscribe((t) => b.push(t.seq), { destination: 5 });
    bus.publish(W(5));
    sa.unsubscribe(); sa.unsubscribe();
    bus.publish(W(5));
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
    expect(sa.active).toBe(false);
    expect(bus.stats().activeSubscriptions).toBe(1);
  });

  it("a handler unsubscribed by an earlier handler in the SAME delivery never sees that telegram", () => {
    const bus = new NativeTelegramBus();
    const seen: string[] = [];
    let second!: { unsubscribe(): void };
    bus.subscribe(() => { seen.push("first"); second.unsubscribe(); }, { destination: 1 });
    second = bus.subscribe(() => seen.push("second"), { destination: 1 });
    bus.publish(W(1));
    expect(seen).toEqual(["first"]);
  });

  it("a handler subscribed during delivery starts with the NEXT telegram", () => {
    const bus = new NativeTelegramBus();
    const late: number[] = [];
    let added = false;
    bus.subscribe(() => { if (!added) { added = true; bus.subscribe((t) => late.push(t.seq), { destination: 1 }); } }, { destination: 1 });
    bus.publish(W(1)); bus.publish(W(1));
    expect(late).toEqual([2]);
  });

  it("filters by service", () => {
    const bus = new NativeTelegramBus();
    const got: string[] = [];
    bus.subscribe((t) => got.push(t.service), { destination: 2, services: ["response", "write"] });
    bus.publish({ source: 1, destination: 2, service: "read", data: null });
    bus.publish({ source: 1, destination: 2, service: "response", data: { kind: "short", value: 0 } });
    bus.publish(W(2));
    expect(got).toEqual(["response", "write"]);
  });

  it("refuses to grow past the subscription cap, loudly, and frees the slot on unsubscribe", () => {
    const bus = new NativeTelegramBus({ maxSubscriptions: 3 });
    const subs = [1, 2, 3].map((d) => bus.subscribe(() => undefined, { destination: d }));
    expect(() => bus.subscribe(() => undefined, { destination: 4 })).toThrow(KnxBusError);
    subs[0]!.unsubscribe();
    expect(() => bus.subscribe(() => undefined, { destination: 4 })).not.toThrow();
  });
});

describe("NativeTelegramBus — listener errors and malformed telegrams", () => {
  it("a throwing handler (sync or async) is counted and never affects later handlers or the publisher", async () => {
    const bus = new NativeTelegramBus();
    const got: number[] = [];
    bus.subscribe(() => { throw new Error("boom"); }, { destination: 1 });
    bus.subscribe(() => Promise.reject(new Error("async boom")), { destination: 1 });
    bus.subscribe((t) => got.push(t.seq), { destination: 1 });
    expect(() => bus.publish(W(1))).not.toThrow();
    await Promise.resolve();
    expect(got).toEqual([1]);
    expect(bus.stats().listenerErrors).toBe(2);
    expect(bus.stats().lastListenerError).toBe("async boom");
  });

  it.each<[string, unknown]>([
    ["destination out of range", { source: 1, destination: 0x10000, service: "write", data: { kind: "short", value: 1 } }],
    ["negative source", { source: -1, destination: 1, service: "write", data: { kind: "short", value: 1 } }],
    ["fractional destination", { source: 1, destination: 1.5, service: "write", data: { kind: "short", value: 1 } }],
    ["unknown service", { source: 1, destination: 1, service: "poke", data: null }],
    ["write without data", { source: 1, destination: 1, service: "write", data: null }],
    ["read carrying data", { source: 1, destination: 1, service: "read", data: { kind: "short", value: 0 } }],
    ["short value > 63", { source: 1, destination: 1, service: "write", data: { kind: "short", value: 64 } }],
    ["empty payload", { source: 1, destination: 1, service: "write", data: { kind: "bytes", bytes: Buffer.alloc(0) } }],
    ["15-octet payload", { source: 1, destination: 1, service: "write", data: { kind: "bytes", bytes: Buffer.alloc(15) } }],
    ["not an object", null],
  ])("drops a malformed telegram without delivering or throwing: %s", (_n, input) => {
    const bus = new NativeTelegramBus();
    let called = 0;
    bus.subscribe(() => { called++; });
    expect(bus.publish(input as TelegramInput)).toBe("malformed");
    expect(called).toBe(0);
    expect(bus.stats().malformed).toBe(1);
  });

  it("builds telegrams from cEMI and ignores individually addressed frames", () => {
    const group = decodeCemi(encodeGroupCemi({ messageCode: CemiMessageCode.L_DATA_IND, source: 0x1101, destination: 0x0a01, service: "write", data: { kind: "bytes", bytes: Buffer.from([0x12]) } }));
    expect(telegramFromCemi(group)).toEqual({ source: 0x1101, destination: 0x0a01, service: "write", data: { kind: "bytes", bytes: Buffer.from([0x12]) } });
    expect(telegramFromCemi({ ...group, destinationIsGroup: false })).toBeNull();
    expect(telegramFromCemi({ ...group, group: null })).toBeNull();
  });
});

describe("NativeTelegramBus — bounds, shutdown, volume", () => {
  it("bounds the re-entrancy queue with drop-oldest and counts what it dropped", () => {
    const bus = new NativeTelegramBus({ maxReentrantQueue: 3 });
    const seen: number[] = [];
    let fired = false;
    bus.subscribe((t: NativeTelegram) => {
      seen.push(t.seq);
      if (!fired) { fired = true; for (let i = 0; i < 10; i++) bus.publish(W(2, i % 2)); }
    }, { destination: 1 });
    bus.subscribe((t) => seen.push(t.seq), { destination: 2 });
    bus.publish(W(1));
    // 10 re-entrant publishes (seq 2..11) → only the newest 3 (9,10,11) are kept.
    expect(seen).toEqual([1, 9, 10, 11]);
    expect(bus.stats().overflowDropped).toBe(7);
  });

  it("close() is final: handles go inactive, nothing is delivered, late subscribers are inert, double close is harmless", () => {
    const bus = new NativeTelegramBus();
    let called = 0;
    const s = bus.subscribe(() => { called++; }, { destination: 1 });
    bus.close(); bus.close();
    expect(s.active).toBe(false);
    s.unsubscribe();
    expect(bus.publish(W(1))).toBe("closed");
    const late = bus.subscribe(() => { called++; }, { destination: 1 });
    expect(late.active).toBe(false);
    expect(called).toBe(0);
    expect(bus.stats()).toMatchObject({ activeSubscriptions: 0, closed: true, refusedAfterClose: 1 });
  });

  it("close() from inside a handler stops the rest of that delivery", () => {
    const bus = new NativeTelegramBus();
    const seen: string[] = [];
    bus.subscribe(() => { seen.push("a"); bus.close(); }, { destination: 1 });
    bus.subscribe(() => seen.push("b"), { destination: 1 });
    bus.publish(W(1));
    expect(seen).toEqual(["a"]);
  });

  it("keeps a bounded history ring", () => {
    const bus = new NativeTelegramBus({ historyLimit: 4 });
    for (let i = 0; i < 10; i++) bus.publish(W(1));
    expect(bus.recent().map((t) => t.seq)).toEqual([7, 8, 9, 10]);
  });

  it("handles 200 000 telegrams across 500 group addresses with a bounded footprint and exact counts", () => {
    const bus = new NativeTelegramBus({ historyLimit: 16 });
    const per = new Map<number, number>();
    for (let d = 0; d < 500; d++) bus.subscribe(() => per.set(d, (per.get(d) ?? 0) + 1), { destination: d });
    let wild = 0;
    bus.subscribe(() => { wild++; });
    for (let i = 0; i < 200_000; i++) bus.publish(W(i % 500, i & 1));
    expect(wild).toBe(200_000);
    expect([...per.values()].every((n) => n === 400)).toBe(true);
    const s = bus.stats();
    expect(s).toMatchObject({ published: 200_000, deliveries: 400_000, malformed: 0, overflowDropped: 0, listenerErrors: 0, activeSubscriptions: 501 });
    expect(bus.recent()).toHaveLength(16);
  });

  it("subscribe/unsubscribe churn leaves no residue", () => {
    const bus = new NativeTelegramBus();
    for (let i = 0; i < 5000; i++) bus.subscribe(() => undefined, { destination: i % 7 }).unsubscribe();
    expect(bus.stats().activeSubscriptions).toBe(0);
    let called = 0;
    bus.subscribe(() => { called++; }, { destination: 3 });
    bus.publish(W(3));
    expect(called).toBe(1);
  });
});
