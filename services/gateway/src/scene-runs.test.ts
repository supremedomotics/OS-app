import type { CapabilityCommand, CapabilityKind, Scene } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { SceneRunner, type SceneRunDeps } from "./scene-runs.js";

type Dev = { status: string; room: string; state: Record<string, Record<string, unknown>> };

/** A hand-driven world: devices, a manual clock and timers, and a state feed we control. */
function world(devs: Record<string, Dev>) {
  const sent: string[] = [];
  const subs = new Set<(e: { deviceId: string; capability: CapabilityKind; state: Record<string, unknown> }) => void>();
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  let now = 0;
  const failing = new Set<string>();
  const published: unknown[] = [];
  const deps: SceneRunDeps = {
    roomOf: async (id) => devs[id]?.room ?? null,
    getDevice: async (id) => (devs[id] ? { status: devs[id]!.status, state: devs[id]!.state } : null),
    command: async (id, c: CapabilityCommand) => {
      if (failing.has(id)) throw new Error("driver_error");
      sent.push(`${id}:${JSON.stringify(c)}`);
    },
    onState: (s) => {
      subs.add(s);
      return () => subs.delete(s);
    },
    publish: (r) => published.push(r),
    now: () => new Date(now),
    setTimer: (ms, fn) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return { cancel: () => (t.live = false) };
    },
    newId: (() => {
      let n = 0;
      return () => `run-${++n}`;
    })(),
  };
  const report = (deviceId: string, capability: CapabilityKind, state: Record<string, unknown>) => {
    devs[deviceId]!.state[capability] = state;
    for (const s of subs) s({ deviceId, capability, state });
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers.filter((t) => t.live && t.at <= now)) {
      t.live = false;
      t.fn();
    }
    await tick();
  };
  return { deps, sent, report, advance, failing, published, devs };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const scene = (steps: Scene["steps"], phases: number[][] = []): Scene =>
  ({ id: "sc1", homeId: "h", name: "Relax", scope: "home", roomId: null, ownerUserId: null, icon: null, aiGenerated: false,
    steps, description: null, phases, sourceDriverId: null, sourceSceneId: null, imported: false, syncStatus: null }) as unknown as Scene;

const light = (): Dev => ({ status: "online", room: "living", state: { brightness: { kind: "brightness", on: false, level: 0 } } });
const lightStep = (deviceId: string, level: number) => ({ deviceId, capability: "brightness", values: { action: "set", level } }) as never;

describe("SceneRunner", () => {
  it("confirms a step only when the device reports the target, then completes", async () => {
    const w = world({ a: light() });
    const r = new SceneRunner(w.deps);
    const run = await r.start(scene([lightStep("a", 40)]));
    expect(run.status).toBe("running");
    await tick();
    expect(r.get(run.runId)!.steps[0]!.state).toBe("sent");
    w.report("a", "brightness", { kind: "brightness", on: true, level: 10 }); // wrong value: not it
    await tick();
    expect(r.get(run.runId)!.steps[0]!.state).toBe("sent");
    w.report("a", "brightness", { kind: "brightness", on: true, level: 40 });
    await r.finished(run.runId);
    const done = r.get(run.runId)!;
    expect(done.steps[0]!.state).toBe("confirmed");
    expect(done.status).toBe("completed");
    expect(done.finishedAt).not.toBeNull();
  });

  it("times out a device that never reports, and the run is partial beside a confirmed step", async () => {
    const w = world({ a: light(), b: light() });
    const r = new SceneRunner(w.deps);
    const run = await r.start(scene([lightStep("a", 40), lightStep("b", 40)]));
    await tick();
    w.report("a", "brightness", { kind: "brightness", on: true, level: 40 });
    await w.advance(11_000);
    await r.finished(run.runId);
    const done = r.get(run.runId)!;
    expect(done.steps.map((s) => s.state)).toEqual(["confirmed", "timeout"]);
    expect(done.steps[1]!.reason).toBe("no_report");
    expect(done.status).toBe("partial");
  });

  it("a failed command fails only its step; unreachable devices are skipped, never attempted", async () => {
    const w = world({ a: light(), b: { ...light(), status: "offline" }, c: light() });
    w.failing.add("a");
    const r = new SceneRunner(w.deps);
    const run = await r.start(scene([lightStep("a", 40), lightStep("b", 40), lightStep("c", 40)]));
    await tick();
    w.report("c", "brightness", { kind: "brightness", on: true, level: 40 });
    await r.finished(run.runId);
    const done = r.get(run.runId)!;
    expect(done.steps.map((s) => s.state)).toEqual(["failed", "skipped", "confirmed"]);
    expect(done.steps[0]!.reason).toBe("driver_error");
    expect(done.steps[1]!.reason).toBe("device_unreachable");
    expect(w.sent.some((s) => s.startsWith("b:"))).toBe(false);
    expect(done.status).toBe("partial");
  });

  it("everything failing is 'failed'", async () => {
    const w = world({ a: light() });
    w.failing.add("a");
    const r = new SceneRunner(w.deps);
    const run = await r.start(scene([lightStep("a", 40)]));
    await r.finished(run.runId);
    expect(r.get(run.runId)!.status).toBe("failed");
  });

  it("phases run in order: the next starts only when the previous has concluded from device state", async () => {
    const w = world({ shade: { status: "online", room: "living", state: { position: { kind: "position", position: 100, moving: false } } }, lamp: light() });
    const r = new SceneRunner(w.deps);
    const sc = scene(
      [{ deviceId: "shade", capability: "position", values: { action: "close" } } as never, lightStep("lamp", 30)],
      [[0], [1]],
    );
    const run = await r.start(sc);
    await tick();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toContain("shade");
    expect(r.get(run.runId)!.phase).toBe(1);
    await w.advance(5_000); // time alone does not start the next phase
    expect(w.sent).toHaveLength(1);
    w.report("shade", "position", { kind: "position", position: 50, moving: true });
    await tick();
    expect(w.sent).toHaveLength(1);
    w.report("shade", "position", { kind: "position", position: 0, moving: false });
    await tick();
    expect(w.sent).toHaveLength(2);
    expect(r.get(run.runId)!.phase).toBe(2);
    w.report("lamp", "brightness", { kind: "brightness", on: true, level: 30 });
    await r.finished(run.runId);
    expect(r.get(run.runId)!.status).toBe("completed");
  });

  it("a shade that keeps reporting movement outlasts its deadline; a stalled one times out", async () => {
    const w = world({ shade: { status: "online", room: "living", state: { position: { kind: "position", position: 100, moving: false } } } });
    const r = new SceneRunner({ ...w.deps, deadlines: { position: 3000 } });
    const run = await r.start(scene([{ deviceId: "shade", capability: "position", values: { action: "close" } } as never]));
    await tick();
    await w.advance(2500);
    w.report("shade", "position", { kind: "position", position: 60, moving: true });
    await w.advance(2500); // 5 s in, past the 3 s deadline, but it reported movement 2.5 s ago
    expect(r.get(run.runId)!.steps[0]!.state).toBe("sent");
    await w.advance(1000); // stalled: 3.5 s since the last report
    await r.finished(run.runId);
    expect(r.get(run.runId)!.steps[0]!.state).toBe("timeout");
  });

  it("a target the device already reports concludes from current state", async () => {
    const w = world({ a: { status: "online", room: "living", state: { brightness: { kind: "brightness", on: true, level: 40 } } } });
    const r = new SceneRunner(w.deps);
    const run = await r.start(scene([lightStep("a", 40)]));
    await r.finished(run.runId);
    expect(r.get(run.runId)!.steps[0]!.state).toBe("confirmed");
  });

  it("a step that cannot be verified is dispatched and left at 'sent' — nothing more is claimed", async () => {
    const w = world({ a: { status: "online", room: "living", state: { onoff: { kind: "onoff", on: false } } } });
    const r = new SceneRunner(w.deps);
    const run = await r.start(scene([{ deviceId: "a", capability: "onoff", values: { action: "toggle" } } as never]));
    await r.finished(run.runId);
    const s = r.get(run.runId)!.steps[0]!;
    expect(s.verifiable).toBe(false);
    expect(s.state).toBe("sent");
    expect(r.get(run.runId)!.status).toBe("completed");
  });

  it("scoped to spaces: only steps whose device is in them are part of the run", async () => {
    const w = world({ a: light(), b: { ...light(), room: "dining" } });
    const r = new SceneRunner(w.deps);
    const run = await r.start(scene([lightStep("a", 40), lightStep("b", 40)]), ["dining"]);
    expect(run.spaceIds).toEqual(["dining"]);
    expect(run.steps.map((s) => s.deviceId)).toEqual(["b"]);
    await tick();
    expect(w.sent).toHaveLength(1);
    w.report("b", "brightness", { kind: "brightness", on: true, level: 40 });
    await r.finished(run.runId);
  });

  it("a newer run over the same device supersedes the unfinished part of the older one", async () => {
    const w = world({ a: light() });
    const r = new SceneRunner(w.deps);
    const first = await r.start(scene([lightStep("a", 40)]));
    await tick();
    const second = await r.start(scene([lightStep("a", 70)]));
    await r.finished(first.runId);
    const old = r.get(first.runId)!;
    expect(old.steps[0]!.state).toBe("skipped");
    expect(old.steps[0]!.reason).toBe("superseded");
    expect(old.supersededBy).toBe(second.runId);
    await tick();
    w.report("a", "brightness", { kind: "brightness", on: true, level: 70 });
    await r.finished(second.runId);
    expect(r.get(second.runId)!.status).toBe("completed");
  });

  it("publishes a snapshot on every change, ending with the terminal one", async () => {
    const w = world({ a: light() });
    const r = new SceneRunner(w.deps);
    const run = await r.start(scene([lightStep("a", 40)]));
    await tick();
    w.report("a", "brightness", { kind: "brightness", on: true, level: 40 });
    await r.finished(run.runId);
    const states = (w.published as { status: string; steps: { state: string }[] }[]).map((p) => `${p.status}/${p.steps[0]!.state}`);
    expect(states).toEqual(["running/queued", "running/sent", "running/confirmed", "completed/confirmed"]);
  });
});
