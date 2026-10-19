import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "./simulator/index.js";
import { NativeTelegramBus } from "./telegram-bus.js";
import { SupervisedTunnel } from "./supervised-tunnel.js";
import type { KnxTunnelClient } from "./tunnel-client.js";

/**
 * Cancellation races a real tunnel makes hard to reach, driven with a stub tunnel whose handshake the test settles by hand and whose
 * disconnect() does NOT abort it (the worst case: nothing but SupervisedTunnel's own bookkeeping can stop a late connect from attaching).
 */
class StubTunnel {
  state: "idle" | "connecting" | "connected" | "closed" = "idle";
  disconnects = 0;
  readonly telegram = new Set<unknown>();
  readonly closed = new Set<(e: { reason: string }) => void>();
  private release!: () => void;
  private fail!: (e: Error) => void;
  private readonly gate = new Promise<void>((res, rej) => { this.release = res; this.fail = rej; });
  async connect(): Promise<void> { this.state = "connecting"; await this.gate; }
  /** Completes the handshake; `as` is the state the tunnel is in when the caller resumes. */
  finish(as: "connected" | "closed" = "connected"): void { this.state = as; this.release(); }
  refuse(e: Error): void { this.state = "closed"; this.fail(e); }
  async disconnect(): Promise<void> { this.disconnects++; this.state = "closed"; }
  onTelegram(fn: unknown): () => void { this.telegram.add(fn); return () => { this.telegram.delete(fn); }; }
  onClosed(fn: (e: { reason: string }) => void): () => void { this.closed.add(fn); return () => { this.closed.delete(fn); }; }
  sendGroup(): Promise<never> { return Promise.reject(new Error("stub")); }
}

const clock = new ManualClock();
let created: StubTunnel[] = [];
const make = () => new SupervisedTunnel({ clock, bus: new NativeTelegramBus(), createTunnel: () => { const t = new StubTunnel(); created.push(t); return t as unknown as KnxTunnelClient; }, reconnect: { random: () => 0.5 } });
afterEach(async () => { created = []; await clock.advance(600_000); expect(clock.pendingTimers).toBe(0); });

describe("SupervisedTunnel cancellation races (stub tunnel)", () => {
  it("a handshake that completes AFTER disconnect() is closed, never attached, and the first connect() rejects", async () => {
    const s = make();
    const p = s.connect();
    p.catch(() => undefined);
    await clock.flush();
    const d = s.disconnect();
    created[0]!.finish();
    await d;
    await expect(p).rejects.toMatchObject({ code: "closed" });
    expect(created[0]!.disconnects).toBeGreaterThanOrEqual(1);
    expect(created[0]!.telegram.size + created[0]!.closed.size).toBe(0);
    expect(s.diagnostics()).toMatchObject({ link: "closed", attachedTunnels: 0 });
    expect(s.diagnostics().supervisor).toMatchObject({ state: "disconnected", failedReconnects: 0 }); // a cancelled attempt is not a failed reconnect
  });

  it("a tunnel already closed when the handshake resumes is not attached and the first connect() rejects", async () => {
    const s = make();
    const p = s.connect();
    p.catch(() => undefined);
    await clock.flush();
    created[0]!.finish("closed");
    await expect(p).rejects.toMatchObject({ code: "closed" });
    expect(created[0]!.telegram.size + created[0]!.closed.size).toBe(0);
    expect(s.link).toBe("idle");
    await clock.advance(600_000); // nothing was handed to the supervisor, so no reconnect loop exists
    expect(created).toHaveLength(1);
  });

  it("a link listener that disconnects inside the 'up' event cannot leave a supervised, reconnecting link behind", async () => {
    const s = make();
    s.onLinkChange((e) => { if (e.state === "up") void s.disconnect(); });
    const p = s.connect();
    p.catch(() => undefined);
    await clock.flush();
    created[0]!.finish();
    await expect(p).rejects.toMatchObject({ code: "closed" });
    await clock.advance(600_000);
    expect(created).toHaveLength(1);
    expect(s.link).toBe("closed");
    expect(s.diagnostics().supervisor.state).toBe("disconnected"); // the supervisor was never handed a link that is already closed
  });

  it("a refused first connect rejects with the real error and can be retried on the same instance", async () => {
    const s = make();
    const p = s.connect();
    p.catch(() => undefined);
    await clock.flush();
    created[0]!.refuse(new Error("no more connections"));
    await expect(p).rejects.toThrow("no more connections");
    expect(s.link).toBe("idle");
    const again = s.connect();
    await clock.flush();
    created[1]!.finish();
    await again;
    expect(s.link).toBe("up");
    expect(s.diagnostics()).toMatchObject({ tunnelsCreated: 2, attachedTunnels: 1 });
    await s.disconnect();
  });

  it("a stale tunnel's late closed event never touches the current link", async () => {
    const s = make();
    const p = s.connect();
    await clock.flush();
    created[0]!.finish();
    await p;
    const staleClose = [...created[0]!.closed][0]!;
    created[0]!.state = "closed";
    staleClose({ reason: "socket_error" });          // real drop: supervisor schedules ONE reconnect
    await clock.advance(2_100);
    created[1]!.finish();
    await clock.flush();
    expect(s.link).toBe("up");
    staleClose({ reason: "socket_error" });          // late duplicate from the dead tunnel: ignored
    await clock.advance(10_000);
    expect(created).toHaveLength(2);
    expect(s.link).toBe("up");
    await s.disconnect();
  });
});

describe("SupervisedTunnel.quiesced() — bounded settlement of an unfinished handshake (stub tunnel)", () => {
  it("is true at once when nothing is in flight", async () => {
    const s = make();
    expect(await s.quiesced(1_000)).toBe(true);
    await s.disconnect();
  });

  it("disconnect() stays prompt; quiesced() waits for the handshake to end AND for the discarded tunnel to be closed, then reports true", async () => {
    const s = make();
    const p = s.connect(); p.catch(() => undefined);
    await clock.flush();
    await s.disconnect();                                // returns without waiting for the handshake
    let done: boolean | null = null;
    void s.quiesced(60_000).then((r) => { done = r; });
    await clock.advance(5_000);
    expect(done).toBeNull();                             // handshake still unfinished
    created[0]!.finish();
    await clock.advance(1);
    expect(done).toBe(true);
    expect(created[0]!.disconnects).toBeGreaterThanOrEqual(1);
  });

  it("is bounded: false at the timeout, without cancelling anything or leaving its own timer behind", async () => {
    const s = make();
    const p = s.connect(); p.catch(() => undefined);
    await clock.flush();
    await s.disconnect();
    const r = s.quiesced(2_000);
    await clock.advance(2_000);
    expect(await r).toBe(false);
    expect(created[0]!.disconnects).toBe(0);             // the late tunnel is still the supervisor's to close
    created[0]!.finish();
    await clock.advance(1);
    expect(created[0]!.disconnects).toBeGreaterThanOrEqual(1);
    expect(await s.quiesced(2_000)).toBe(true);
  });

  it("a refused handshake settles too (nothing to discard)", async () => {
    const s = make();
    const p = s.connect(); p.catch(() => undefined);
    await clock.flush();
    created[0]!.refuse(new Error("no more connections"));
    await expect(p).rejects.toThrow();
    expect(await s.quiesced(1_000)).toBe(true);
    await s.disconnect();
  });
});
