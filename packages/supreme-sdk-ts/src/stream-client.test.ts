import { describe, expect, it, vi } from "vitest";
import { SupremeStream, type WebSocketCtor, type WebSocketLike } from "./stream-client.js";

/** A minimal, controllable fake WebSocket — records every constructed instance so a test
 * can simulate the server side (send a frame, force a close) without a real socket. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  listeners: { open: (() => void)[]; close: (() => void)[]; message: ((ev: { data: unknown }) => void)[] } = {
    open: [], close: [], message: [],
  };
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: string, listener: (...args: never[]) => void): void {
    (this.listeners[type as "open"] as unknown[]).push(listener);
  }
  // Test helpers, not part of WebSocketLike.
  triggerOpen(): void { for (const l of this.listeners.open) l(); }
  triggerClose(): void { for (const l of this.listeners.close) l(); }
  triggerMessage(data: unknown): void { for (const l of this.listeners.message) l({ data: JSON.stringify(data) }); }
}

function freshCtor(): WebSocketCtor {
  FakeSocket.instances = [];
  return FakeSocket as unknown as WebSocketCtor;
}

// § Reconnection Handling — the transport itself must reconnect and re-establish
// subscriptions after an unexpected drop; the caller (App.tsx) should not have to notice
// a dead socket and recreate one by hand.
describe("SupremeStream — reconnection", () => {
  it("re-subscribes to previously-subscribed rooms automatically on reconnect", () => {
    vi.useFakeTimers();
    const ctor = freshCtor();
    const stream = new SupremeStream("wss://hub", "tok", ctor);
    stream.connect({});
    const first = FakeSocket.instances[0]!;
    first.triggerOpen();
    stream.subscribe(["*"]);
    expect(first.sent).toContainEqual(JSON.stringify({ type: "subscribe", rooms: ["*"] }));

    // Server drops the connection unexpectedly.
    first.triggerClose();
    vi.advanceTimersByTime(1000);

    expect(FakeSocket.instances.length).toBe(2);
    const second = FakeSocket.instances[1]!;
    second.triggerOpen();
    // The room subscribed before the drop is re-sent automatically — the caller never
    // had to remember/rebuild it.
    expect(second.sent).toContainEqual(JSON.stringify({ type: "subscribe", rooms: ["*"] }));
    vi.useRealTimers();
  });

  it("calls onOpen on every reconnection, not just the first — the signal a caller uses to trigger a reconciliation fetch", () => {
    vi.useFakeTimers();
    const ctor = freshCtor();
    const stream = new SupremeStream("wss://hub", "tok", ctor);
    const onOpen = vi.fn();
    stream.connect({ onOpen });
    FakeSocket.instances[0]!.triggerOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);

    FakeSocket.instances[0]!.triggerClose();
    vi.advanceTimersByTime(1000);
    FakeSocket.instances[1]!.triggerOpen();
    expect(onOpen).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not reconnect after an explicit close() — a deliberate teardown must not resurrect the socket", () => {
    vi.useFakeTimers();
    const ctor = freshCtor();
    const stream = new SupremeStream("wss://hub", "tok", ctor);
    stream.connect({});
    FakeSocket.instances[0]!.triggerOpen();
    stream.close();
    FakeSocket.instances[0]!.triggerClose();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances.length).toBe(1);
    vi.useRealTimers();
  });

  // § Live-confirmed fix — a real network with intermittent connectivity made this
  // socket FLAP (open, then drop again within a couple seconds) rather than staying
  // down cleanly. Resetting backoff on bare "open" (the old behavior) let a flapping
  // socket reconnect at roughly the base interval forever, since it kept "succeeding"
  // just long enough to reset the counter before dying again — defeating the entire
  // point of exponential backoff, and (via `onOpen`'s reconciliation-fetch trigger in
  // App.tsx) flooding the origin with a fresh REST fetch on every flap.
  it("keeps escalating backoff across repeated brief opens — a flapping connection must not reset it", () => {
    vi.useFakeTimers();
    const ctor = freshCtor();
    const stream = new SupremeStream("wss://hub", "tok", ctor);
    stream.connect({});

    // Attempt 1: opens, then dies almost immediately (well under the stability window).
    FakeSocket.instances[0]!.triggerOpen();
    vi.advanceTimersByTime(500);
    FakeSocket.instances[0]!.triggerClose();

    // First reconnect fires at the base backoff (1000ms) — advancing less must not
    // have already reconnected.
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(2);

    // Attempt 2: same pattern — opens, dies immediately, well before stabilizing.
    FakeSocket.instances[1]!.triggerOpen();
    vi.advanceTimersByTime(500);
    FakeSocket.instances[1]!.triggerClose();

    // If backoff had wrongly reset to base on the attempt-2 "open", this would
    // reconnect at 1000ms again. It must instead wait the DOUBLED interval (2000ms).
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.instances.length).toBe(2); // still waiting — proves it did NOT reset
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(3);
    vi.useRealTimers();
  });

  it("resets backoff only after the connection has genuinely stayed open past the stability window", () => {
    vi.useFakeTimers();
    const ctor = freshCtor();
    const stream = new SupremeStream("wss://hub", "tok", ctor);
    stream.connect({});

    // Attempt 1 flaps quickly, escalating backoff to 2000ms for attempt 2.
    FakeSocket.instances[0]!.triggerOpen();
    vi.advanceTimersByTime(500);
    FakeSocket.instances[0]!.triggerClose();
    vi.advanceTimersByTime(1000);

    // Attempt 2 opens and this time genuinely STAYS open past the stability window
    // (10s) before eventually dropping — a real recovered connection.
    FakeSocket.instances[1]!.triggerOpen();
    vi.advanceTimersByTime(10_000);
    FakeSocket.instances[1]!.triggerClose();

    // Backoff is back to the base interval — a genuinely-stable connection earns the
    // reset, unlike the flapping case above.
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(3);
    vi.useRealTimers();
  });

  it("dispatches driver-state frames to onDriverState only, distinct from device-state frames", () => {
    const ctor = freshCtor();
    const stream = new SupremeStream("wss://hub", "tok", ctor);
    const onState = vi.fn();
    const onDriverState = vi.fn();
    stream.connect({ onState, onDriverState });
    const socket = FakeSocket.instances[0]!;
    socket.triggerMessage({ type: "driver", driverId: "knx-1", state: "connecting", ts: new Date().toISOString() });
    expect(onDriverState).toHaveBeenCalledTimes(1);
    expect(onState).not.toHaveBeenCalled();
    socket.triggerMessage({
      type: "state", homeId: "h1", roomId: null, deviceId: "d1",
      state: { kind: "onoff", on: true }, seq: 1, ts: new Date().toISOString(),
    });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onDriverState).toHaveBeenCalledTimes(1);
  });
});
