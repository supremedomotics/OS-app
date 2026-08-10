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
