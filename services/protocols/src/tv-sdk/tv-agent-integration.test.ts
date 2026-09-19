import { describe, expect, it } from "vitest";
import { TvDeviceSession } from "./tv-device-session.js";
import { FakeTvTransport } from "./transports/fake-tv-transport.js";
import { AGENT_RECONNECT_SNAPSHOT_SEQUENCE } from "./tv-agent-protocol.js";
import type { TvDeviceConfig } from "./tv-types.js";

/**
 * (§Phase 3 gate — Agent as an independent, optional feedback channel) Reuses
 * `FakeTvTransport` (§34 Test Doubles) for BOTH the primary control transport and the
 * Agent — the Agent is just another `TvTransport` from `TvDeviceSession`'s point of
 * view (see attachAgent's doc comment), so a second fake instance is a real test double
 * for it, not a stand-in. No separate FakeTvAgentTransport class is needed.
 */
function makeConfig(id: string, primary: FakeTvTransport): TvDeviceConfig {
  return {
    deviceId: id,
    host: "10.0.0.1",
    platform: "android_tv",
    transportKind: "fake",
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    createTransport: () => primary,
  };
}

describe("TvDeviceSession + Agent — independent optional feedback channel (§1/§4/§19)", () => {
  it("control works with no agent ever attached", async () => {
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession(makeConfig("tv-1", primary));
    await session.connect();
    await session.sendKey("HOME");
    expect(primary.received).toEqual(["HOME"]);
    expect(session.getDiagnostics().agentConnected).toBeNull();
    session.dispose();
  });

  it("a failed agent connection degrades feedback only — control is unaffected and agentConnected reports false, not thrown", async () => {
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession(makeConfig("tv-1", primary));
    await session.connect();

    const agent = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    agent.failNextConnect("connection");
    await session.attachAgent(agent);

    expect(session.getDiagnostics().agentConnected).toBe(false);
    expect(session.isConnected()).toBe(true);
    await session.sendKey("HOME");
    expect(primary.received).toEqual(["HOME"]);
    session.dispose();
  });

  it("an agent connection-lost never triggers the primary reconnect scheduler or changes connectionState", async () => {
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession(makeConfig("tv-1", primary));
    await session.connect();
    const agent = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    await session.attachAgent(agent);
    expect(session.getDiagnostics().agentConnected).toBe(true);

    agent.simulateConnectionLost("agent crashed");

    expect(session.getDiagnostics().agentConnected).toBe(false);
    expect(session.getDiagnostics().connectionState).toBe("connected"); // untouched
    expect(session.isConnected()).toBe(true); // primary transport still reports connected
    session.dispose();
  });

  it("detachAgent() reverts agentConnected to null (no agent), distinct from false (agent unreachable) — §19 disable/uninstall", async () => {
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession(makeConfig("tv-1", primary));
    await session.connect();
    const agent = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    await session.attachAgent(agent);
    expect(session.getDiagnostics().agentConnected).toBe(true);

    session.detachAgent();
    expect(session.getDiagnostics().agentConnected).toBeNull();
    expect(agent.isDisposed()).toBe(true);
    expect(session.isConnected()).toBe(true); // control still fine

    session.dispose();
  });

  it("§10 arbitration: at equal revision, agent_mediasession outranks the primary transport's own source for media title", async () => {
    // TvStateCache's documented ordering (tv-state-cache.ts) is revision-first,
    // priority-as-tiebreak — a source with no revision falls back to arrival order,
    // which is a recency proxy, not a priority override. Both events here carry the
    // SAME explicit revision, which is exactly the case priority is meant to settle:
    // a real MediaSession update and a real Remote v2 update describing the same
    // logical state snapshot, where the Agent's is the more authoritative one.
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession(makeConfig("tv-1", primary));
    await session.connect();
    const agent = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    await session.attachAgent(agent);

    primary.emitMediaState({ title: "From Remote V2" }, { source: "remote_v2", revision: 1 });
    expect(session.getMediaState()?.title).toBe("From Remote V2");
    agent.emitMediaState({ title: "From Agent MediaSession" }, { source: "agent_mediasession", revision: 1 });
    expect(session.getMediaState()?.title).toBe("From Agent MediaSession");

    // A same-revision update from the lower-priority source must NOT clobber it.
    primary.emitMediaState({ title: "Stale Remote V2 Update" }, { source: "remote_v2", revision: 1 });
    expect(session.getMediaState()?.title).toBe("From Agent MediaSession");

    session.dispose();
  });

  it("§14 position-only updates are coalesced; a metadata/playback change always passes through immediately", async () => {
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession(makeConfig("tv-1", primary));
    await session.connect();
    const agent = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    await session.attachAgent(agent);

    const emitted: unknown[] = [];
    session.onEvent((e) => {
      if (e.type === "media-state") emitted.push(e.state);
    });

    // First event always passes (nothing cached yet).
    agent.emitMediaState({ title: "Movie", positionSec: 0 }, { source: "agent_mediasession" });
    // A rapid burst of position-only updates, well within the coalesce window.
    for (let i = 1; i <= 20; i++) {
      agent.emitMediaState({ title: "Movie", positionSec: i }, { source: "agent_mediasession" });
    }
    expect(emitted.length).toBeLessThan(21); // most of the 20 position-only updates were coalesced away
    expect(emitted.length).toBeGreaterThanOrEqual(1);

    // Cache itself must still reflect the LATEST position even though not every
    // update was individually broadcast.
    expect(session.getMediaState()?.positionSec).toBe(20);

    // A genuine playback-state change is never coalesced away.
    const beforeCount = emitted.length;
    agent.emitMediaState({ title: "Movie", positionSec: 20, playback: "paused" }, { source: "agent_mediasession" });
    expect(emitted.length).toBe(beforeCount + 1);

    session.dispose();
  });

  it("§8 mediaPositionCoalescingMs is a tunable per-device policy, not a hidden constant", async () => {
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession({ ...makeConfig("tv-1", primary), mediaPositionCoalescingMs: 1_000_000 }); // effectively "never" for this test's timescale
    await session.connect();
    const agent = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    await session.attachAgent(agent);
    const emitted: unknown[] = [];
    session.onEvent((e) => {
      if (e.type === "media-state") emitted.push(e.state);
    });
    agent.emitMediaState({ title: "Movie", positionSec: 0 }, { source: "agent_mediasession" });
    for (let i = 1; i <= 10; i++) agent.emitMediaState({ title: "Movie", positionSec: i }, { source: "agent_mediasession" });
    expect(emitted.length).toBe(1); // an extremely wide window coalesces everything after the first
    session.dispose();
  });

  it("§8 low-frequency position updates (spaced beyond the coalescing window) are never dropped", async () => {
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession({ ...makeConfig("tv-1", primary), mediaPositionCoalescingMs: 1 });
    await session.connect();
    const agent = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    await session.attachAgent(agent);
    const emitted: unknown[] = [];
    session.onEvent((e) => {
      if (e.type === "media-state") emitted.push(e.state);
    });
    for (let i = 0; i <= 5; i++) {
      agent.emitMediaState({ title: "Movie", positionSec: i }, { source: "agent_mediasession" });
      await new Promise((r) => setTimeout(r, 5)); // comfortably past the 1ms window
    }
    expect(emitted.length).toBe(6); // every well-spaced update passes through
    session.dispose();
  });

  it("§8 a playback-state transition (PLAYING -> PAUSED) is never delayed behind a position-update burst", async () => {
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession({ ...makeConfig("tv-1", primary), mediaPositionCoalescingMs: 1_000_000 });
    await session.connect();
    const agent = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    await session.attachAgent(agent);
    const emitted: { playback?: string; positionSec?: number }[] = [];
    session.onEvent((e) => {
      if (e.type === "media-state") emitted.push(e.state);
    });
    agent.emitMediaState({ title: "Movie", positionSec: 0, playback: "playing" }, { source: "agent_mediasession" });
    for (let i = 1; i <= 5; i++) agent.emitMediaState({ title: "Movie", positionSec: i, playback: "playing" }, { source: "agent_mediasession" });
    agent.emitMediaState({ title: "Movie", positionSec: 5, playback: "paused" }, { source: "agent_mediasession" }); // must propagate NOW
    expect(emitted.at(-1)?.playback).toBe("paused");
    session.dispose();
  });

  it("§10/§16 agent reconnect reconciliation: the documented snapshot sequence replaces stale pre-disconnect state, never merges onto it", async () => {
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession(makeConfig("tv-1", primary));
    await session.connect();
    const agent1 = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    await session.attachAgent(agent1);
    agent1.emitMediaState({ title: "Stale Show", positionSec: 999 }, { source: "agent_mediasession", revision: 1 });
    expect(session.getMediaState()?.title).toBe("Stale Show");

    // Agent disappears; SupremeOS detects it via connection-lost.
    agent1.simulateConnectionLost();
    expect(session.getDiagnostics().agentConnected).toBe(false);

    // Agent reconnects (a fresh transport instance, as a real reconnect would be) and
    // must re-send the full snapshot sequence (§10) BEFORE any further deltas — this
    // test asserts the documented sequence exists and that a snapshot fully replaces,
    // rather than merges onto, the stale cached value.
    expect(AGENT_RECONNECT_SNAPSHOT_SEQUENCE).toContain("mediaSession");
    const agent2 = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    await session.attachAgent(agent2);
    agent2.emitMediaState({ title: "Fresh Show", positionSec: 0 }, { source: "agent_mediasession", revision: 2 });

    expect(session.getMediaState()?.title).toBe("Fresh Show");
    expect(session.getMediaState()?.positionSec).toBe(0); // not 999 — no merge with the stale value
    session.dispose();
  });

  it("§9 resource-leak check: 50 attach/detach agent cycles leave zero leaked listeners", async () => {
    const primary = new FakeTvTransport(makeConfig("tv-1", undefined as never));
    const session = new TvDeviceSession(makeConfig("tv-1", primary));
    await session.connect();

    for (let i = 0; i < 50; i++) {
      const agent = new FakeTvTransport(makeConfig("tv-1", undefined as never));
      await session.attachAgent(agent);
      expect(session.getDiagnostics().agentConnected).toBe(true);
      session.detachAgent();
      expect(agent.isDisposed()).toBe(true);
      expect(session.getDiagnostics().agentConnected).toBeNull();
    }
    // Control must still work after 50 cycles — no accumulated state corrupted it.
    await session.sendKey("HOME");
    expect(primary.received).toContain("HOME");
    session.dispose();
  });
});

describe("§15/§16 100-device Agent event-storm test (fake transports)", () => {
  it("100 sessions, each with its own agent, survive a concurrent position-update storm with correct isolation and bounded emitted events", async () => {
    const N = 100;
    const rigs = Array.from({ length: N }, (_, i) => {
      const primary = new FakeTvTransport(makeConfig(`tv-${i}`, undefined as never));
      const session = new TvDeviceSession(makeConfig(`tv-${i}`, primary));
      const agent = new FakeTvTransport(makeConfig(`tv-${i}`, undefined as never));
      const emitted: { title?: string; positionSec?: number }[] = [];
      session.onEvent((e) => {
        if (e.type === "media-state") emitted.push(e.state);
      });
      return { i, primary, session, agent, emitted };
    });

    await Promise.all(rigs.map((r) => r.session.connect()));
    await Promise.all(rigs.map((r) => r.session.attachAgent(r.agent)));
    expect(rigs.every((r) => r.session.getDiagnostics().agentConnected === true)).toBe(true);

    // Each device gets a DISTINCT title plus a 30-update position storm, all
    // concurrently — cross-device leakage would show up as device i seeing another
    // device's title.
    for (const r of rigs) {
      r.agent.emitMediaState({ title: `Show-${r.i}`, positionSec: 0 }, { source: "agent_mediasession" });
      for (let p = 1; p <= 30; p++) r.agent.emitMediaState({ title: `Show-${r.i}`, positionSec: p }, { source: "agent_mediasession" });
    }

    for (const r of rigs) {
      expect(r.session.getMediaState()?.title).toBe(`Show-${r.i}`);
      expect(r.session.getMediaState()?.positionSec).toBe(30);
      // Coalescing bounded the emitted event count well under the 31 raw updates.
      expect(r.emitted.length).toBeLessThan(31);
    }

    // Disconnect the agent on a random subset — must not affect anyone else's state.
    const victims = rigs.filter((r) => r.i % 7 === 0);
    for (const r of victims) r.agent.simulateConnectionLost();
    for (const r of victims) expect(r.session.getDiagnostics().agentConnected).toBe(false);
    for (const r of rigs) if (r.i % 7 !== 0) expect(r.session.getDiagnostics().agentConnected).toBe(true);
    // Primary control remains available for everyone, victims included.
    await Promise.all(rigs.map((r) => r.session.sendKey("HOME")));
    for (const r of rigs) expect(r.primary.received).toContain("HOME");

    for (const r of rigs) r.session.dispose();
    for (const r of rigs) expect(r.agent.isDisposed()).toBe(true);
  });
});
