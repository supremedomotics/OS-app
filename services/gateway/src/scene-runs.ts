import { randomUUID } from "node:crypto";
import type { SceneRun, SceneRunStep } from "@supreme/contracts";
import { CapabilityCommand, expectationOf, type CapabilityKind, type Scene } from "@supreme/domain-model";

/**
 * Hub-orchestrated Experience activation (ADR 0102; docs/architecture/homeowner-contract-gate.md §6).
 *
 * The Hub owns the sequence and the verdict. For every step it (1) sends the command through the
 * SIL, (2) waits for the DEVICE to report a state that satisfies the step's target — the shared
 * `expectationOf`, the same predicate every client uses — and (3) concludes the step as
 * confirmed / failed / timeout. Phases run one after another, each starting only when the previous
 * one has concluded, never by a timer. A step that cannot be verified from state is dispatched and
 * left at `sent`: nothing more is claimed for it.
 *
 * All I/O is injected, so the state machine is tested without a gateway.
 */
export interface SceneRunDeps {
  roomOf(deviceId: string): Promise<string | null>;
  /** Null when the device does not exist. `state` is the last known state per capability kind. */
  getDevice(deviceId: string): Promise<{ status: string; state: Record<string, Record<string, unknown>> } | null>;
  command(deviceId: string, command: CapabilityCommand): Promise<void>;
  /** Subscribe to authoritative device reports (the same feed `/v1/stream` fans out). */
  onState(sub: (e: { deviceId: string; capability: CapabilityKind; state: Record<string, unknown> }) => void): () => void;
  publish(run: SceneRun): void;
  now?: () => Date;
  setTimer?: (ms: number, fn: () => void) => { cancel(): void };
  newId?: () => string;
  /** Per-capability deadline (ms) for a device to report the target. A device that keeps reporting
   * movement (`moving: true`) restarts its deadline. */
  deadlines?: Partial<Record<string, number>>;
}

export const DEFAULT_DEADLINES: Record<string, number> = {
  onoff: 10_000,
  brightness: 10_000,
  media: 10_000,
  temperature: 15_000,
  position: 90_000,
};
const FALLBACK_DEADLINE = 10_000;
const MAX_RUNS = 50;

interface Live {
  run: SceneRun;
  waiters: Map<string, () => void>; // stepId → cancel
  done: Promise<void>;
}

export class SceneRunner {
  private readonly runs = new Map<string, Live>();
  private readonly waiting = new Map<string, Set<(e: { state: Record<string, unknown> }) => void>>(); // "device:cap"
  private readonly unsub: () => void;
  private readonly now: () => Date;
  private readonly setTimer: (ms: number, fn: () => void) => { cancel(): void };
  private readonly deadlines: Record<string, number>;

  constructor(private readonly deps: SceneRunDeps) {
    this.now = deps.now ?? (() => new Date());
    this.setTimer =
      deps.setTimer ??
      ((ms, fn) => {
        const t = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(t) };
      });
    this.deadlines = { ...DEFAULT_DEADLINES };
    for (const [k, v] of Object.entries(deps.deadlines ?? {})) if (v !== undefined) this.deadlines[k] = v;
    this.unsub = deps.onState((e) => {
      const set = this.waiting.get(`${e.deviceId}:${e.capability}`);
      if (set) for (const f of [...set]) f({ state: e.state });
    });
  }

  close(): void {
    this.unsub();
  }

  get(runId: string): SceneRun | null {
    return this.runs.get(runId)?.run ?? null;
  }

  /** Resolves when the run has concluded (tests await this; the HTTP route does not). */
  finished(runId: string): Promise<void> {
    return this.runs.get(runId)?.done ?? Promise.resolve();
  }

  /** Builds the run, publishes its initial snapshot and starts executing; returns at once. */
  async start(scene: Scene, spaceIds: string[] = []): Promise<SceneRun> {
    const steps: SceneRunStep[] = [];
    const commands = new Map<string, CapabilityCommand>();
    const indexOf = new Map<string, number>();
    for (let i = 0; i < scene.steps.length; i++) {
      const st = scene.steps[i]!;
      const roomId = await this.deps.roomOf(st.deviceId);
      if (spaceIds.length > 0 && (roomId === null || !spaceIds.includes(roomId))) continue;
      const stepId = `${scene.id}:${i}`;
      const parsed = CapabilityCommand.safeParse({ capability: st.capability, ...st.values });
      const device = await this.deps.getDevice(st.deviceId);
      const verifiable = parsed.success && expectationOf(st.capability, { capability: st.capability, ...st.values }) !== null;
      let state: SceneRunStep["state"] = "queued";
      let reason: string | null = null;
      if (!parsed.success) {
        state = "skipped";
        reason = "invalid_command";
      } else if (!device) {
        state = "skipped";
        reason = "device_not_found";
      } else if (device.status !== "online") {
        state = "skipped";
        reason = "device_unreachable";
      } else {
        commands.set(stepId, parsed.data);
      }
      indexOf.set(stepId, i);
      steps.push({ stepId, deviceId: st.deviceId, roomId, capability: st.capability, state, verifiable, reason });
    }

    // Phases: ordered groups of step indices; steps in no phase start at once.
    const phased = new Set<number>();
    const groups: string[][] = [];
    for (const ph of scene.phases ?? []) {
      const ids = steps.filter((s) => ph.includes(indexOf.get(s.stepId)!)).map((s) => s.stepId);
      ph.forEach((i) => phased.add(i));
      if (ids.length > 0) groups.push(ids);
    }
    const free = steps.filter((s) => !phased.has(indexOf.get(s.stepId)!)).map((s) => s.stepId);

    const run: SceneRun = {
      runId: (this.deps.newId ?? randomUUID)(),
      sceneId: scene.id,
      spaceIds,
      status: "running",
      startedAt: this.now().toISOString(),
      finishedAt: null,
      phase: 0,
      phases: groups.length,
      steps,
      supersededBy: null,
    };
    const live: Live = { run, waiters: new Map(), done: Promise.resolve() };
    this.supersede(run);
    this.runs.set(run.runId, live);
    while (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value as string);
    this.emit(live);

    const runStep = (id: string) => this.runStep(live, id, commands.get(id));
    live.done = (async () => {
      await Promise.all([
        Promise.all(free.map(runStep)),
        (async () => {
          for (let i = 0; i < groups.length; i++) {
            live.run.phase = i + 1;
            this.emit(live);
            await Promise.all(groups[i]!.map(runStep));
          }
        })(),
      ]);
      this.finish(live);
    })();
    return structuredClone(run);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private step(live: Live, id: string): SceneRunStep {
    return live.run.steps.find((s) => s.stepId === id)!;
  }

  private set(live: Live, id: string, state: SceneRunStep["state"], reason: string | null = null): void {
    const s = this.step(live, id);
    s.state = state;
    s.reason = reason;
    this.emit(live);
  }

  private emit(live: Live): void {
    this.deps.publish(structuredClone(live.run));
  }

  private async runStep(live: Live, id: string, command: CapabilityCommand | undefined): Promise<void> {
    const st = this.step(live, id);
    if (st.state !== "queued" || !command) return; // skipped up front
    try {
      await this.deps.command(st.deviceId, command);
    } catch (err) {
      if (this.step(live, id).state === "queued") this.set(live, id, "failed", err instanceof Error ? err.message : "command_failed");
      return;
    }
    if (this.step(live, id).state !== "queued") return; // superseded while sending
    this.set(live, id, "sent");
    const expectation = expectationOf(st.capability, command as unknown as Record<string, unknown>);
    if (!expectation) return; // dispatched; nothing more can be claimed

    // Already what was asked? Then no report will follow — conclude from the device's current state.
    const dev = await this.deps.getDevice(st.deviceId);
    const now = dev?.state[st.capability];
    if (now && expectation.matches(now)) {
      if (this.step(live, id).state === "sent") this.set(live, id, "confirmed");
      return;
    }

    await new Promise<void>((resolve) => {
      const key = `${st.deviceId}:${st.capability}`;
      const ms = this.deadlines[st.capability] ?? FALLBACK_DEADLINE;
      let timer = this.setTimer(ms, () => conclude("timeout", "no_report"));
      const listener = (e: { state: Record<string, unknown> }): void => {
        if (expectation.matches(e.state)) conclude("confirmed", null);
        else if (e.state.moving === true) {
          timer.cancel();
          timer = this.setTimer(ms, () => conclude("timeout", "no_report"));
        }
      };
      const set = this.waiting.get(key) ?? new Set();
      set.add(listener);
      this.waiting.set(key, set);
      const conclude = (state: SceneRunStep["state"], reason: string | null): void => {
        timer.cancel();
        set.delete(listener);
        live.waiters.delete(id);
        if (this.step(live, id).state === "sent") this.set(live, id, state, reason);
        resolve();
      };
      live.waiters.set(id, () => conclude("skipped", "superseded"));
    });
  }

  /** A newer run over the same device+capability replaces the unfinished part of an older one. */
  private supersede(next: SceneRun): void {
    const mine = new Set(next.steps.filter((s) => s.state === "queued").map((s) => `${s.deviceId}:${s.capability}`));
    for (const live of this.runs.values()) {
      if (live.run.status !== "running") continue;
      let hit = false;
      for (const s of live.run.steps) {
        if ((s.state === "queued" || s.state === "sent") && mine.has(`${s.deviceId}:${s.capability}`)) {
          hit = true;
          const cancel = live.waiters.get(s.stepId);
          if (cancel) cancel();
          else if (s.state === "queued") {
            s.state = "skipped";
            s.reason = "superseded";
          }
        }
      }
      if (hit) live.run.supersededBy = next.runId;
    }
  }

  private finish(live: Live): void {
    const steps = live.run.steps;
    const bad = steps.filter((s) => s.state === "failed" || s.state === "timeout" || s.state === "skipped").length;
    const good = steps.filter((s) => s.state === "confirmed" || s.state === "sent").length;
    live.run.status = bad === 0 ? "completed" : good === 0 ? "failed" : "partial";
    live.run.finishedAt = this.now().toISOString();
    this.emit(live);
  }
}
