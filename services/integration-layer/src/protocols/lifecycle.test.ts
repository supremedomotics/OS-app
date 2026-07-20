import { describe, expect, it, vi } from "vitest";
import { DriverLifecycleController, InvalidLifecycleTransitionError } from "./lifecycle.js";

describe("DriverLifecycleController — state machine", () => {
  it("starts at 'created' and moves forward through the real sequence", () => {
    const c = new DriverLifecycleController();
    expect(c.currentState).toBe("created");
    for (const s of ["initialized", "registered", "bound", "connecting", "connected", "ready", "operational"] as const) {
      c.transition(s);
      expect(c.currentState).toBe(s);
    }
  });

  it("rejects a backward transition through the forward sequence", () => {
    const c = new DriverLifecycleController();
    c.transition("connected");
    expect(() => c.transition("binding")).toThrow(InvalidLifecycleTransitionError);
  });

  it("transitioning to the current state is a safe no-op (repeated calls must be safe)", () => {
    const c = new DriverLifecycleController();
    c.transition("connected");
    expect(() => c.transition("connected")).not.toThrow();
    expect(c.currentState).toBe("connected");
  });

  it("allows the recoverable reconnect path from any forward state, then back into the sequence", () => {
    const c = new DriverLifecycleController();
    c.transition("operational");
    c.transition("disconnected");
    c.transition("reconnecting");
    c.transition("connecting");
    c.transition("connected");
    expect(c.currentState).toBe("connected");
  });

  it("rejects ANY transition once destroyed — terminal means terminal", async () => {
    const c = new DriverLifecycleController();
    c.transition("ready");
    await c.runCleanups();
    expect(c.currentState).toBe("destroyed");
    expect(() => c.transition("ready")).toThrow(InvalidLifecycleTransitionError);
  });
});

describe("DriverLifecycleController — resource cleanup registry", () => {
  it("runs every registered cleanup exactly once, in LIFO order", async () => {
    const c = new DriverLifecycleController();
    const order: number[] = [];
    c.registerCleanup(() => { order.push(1); });
    c.registerCleanup(() => { order.push(2); });
    c.registerCleanup(() => { order.push(3); });
    expect(c.pendingCleanupCount).toBe(3);

    const result = await c.runCleanups();
    expect(result.ok).toBe(true);
    expect(order).toEqual([3, 2, 1]);
    expect(c.pendingCleanupCount).toBe(0);
    expect(c.currentState).toBe("destroyed");
  });

  it("tolerates one cleanup throwing without skipping the rest — no leak survives a broken release", async () => {
    const c = new DriverLifecycleController();
    const ran: string[] = [];
    c.registerCleanup(() => { ran.push("timer"); });
    c.registerCleanup(() => { throw new Error("socket close failed"); });
    c.registerCleanup(() => { ran.push("subscription"); });

    const result = await c.runCleanups();
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(ran).toEqual(["subscription", "timer"]); // LIFO — the failing one is in the middle
    expect(c.pendingCleanupCount).toBe(0); // nothing left registered, even the failed one
  });

  it("supports async cleanups (socket.destroy()-style)", async () => {
    const c = new DriverLifecycleController();
    const closed = vi.fn();
    c.registerCleanup(async () => {
      await new Promise((r) => setTimeout(r, 1));
      closed();
    });
    await c.runCleanups();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("runCleanups() is idempotent — calling it twice never re-runs a cleanup or throws", async () => {
    const c = new DriverLifecycleController();
    const fn = vi.fn();
    c.registerCleanup(fn);
    await c.runCleanups();
    await c.runCleanups();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("early-release via the returned unregister function skips that cleanup entirely", async () => {
    const c = new DriverLifecycleController();
    const fn = vi.fn();
    const unregister = c.registerCleanup(fn);
    unregister();
    expect(c.pendingCleanupCount).toBe(0);
    await c.runCleanups();
    expect(fn).not.toHaveBeenCalled();
  });

  it("no resources remain after runCleanups() — the mandated 'no leaked references' guarantee", async () => {
    const c = new DriverLifecycleController();
    for (let i = 0; i < 50; i++) c.registerCleanup(() => {});
    expect(c.pendingCleanupCount).toBe(50);
    await c.runCleanups();
    expect(c.pendingCleanupCount).toBe(0);
  });
});
