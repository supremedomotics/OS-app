/**
 * § LAN receive-path investigation — protocol-agnostic pipeline stage reporting.
 *
 * Both Casambi and KNX/IP fail in the same silent way on Docker bridge networking: a socket binds,
 * a multicast group joins, no error is ever raised, and nothing arrives. An installer sees a
 * screen with no red on it and no explanation. This module is the shared vocabulary that makes
 * "nothing is wrong AND nothing is working" a first-class, displayable state.
 *
 * Lives in `core/` (not in either protocol's folder) because it is genuinely shared and carries no
 * protocol knowledge — the same way `driver-health-engine.ts` and `driver-metrics-engine.ts`
 * already do. Future LAN protocols (mDNS, SSDP, Matter, Apple TV, Denon) report their pipelines
 * with the identical three states rather than inventing a per-protocol status vocabulary.
 *
 * The three states are deliberately exhaustive and deliberately NOT a boolean:
 *  - `pass`    — verified to have happened, from a real counter or real state.
 *  - `fail`    — verified to have gone wrong, with a concrete reason.
 *  - `waiting` — correctly configured, nothing has happened YET. This is the state the old
 *                diagnostics could not express, and the reason a joined-but-silent multicast
 *                socket used to render as a reassuring green tick.
 *
 * A stage is NEVER `pass` merely because a setup call returned without throwing. `joinMulticast()`
 * succeeding proves the IGMP membership was accepted inside the local network namespace; it proves
 * nothing about whether any datagram will ever be delivered (verified experimentally: on Docker
 * bridge the join succeeds and delivery never happens; on host networking the identical code
 * receives traffic). Reception stages must be backed by a received-packet counter.
 */
export type PipelineStageStatus = "pass" | "fail" | "waiting";

/**
 * § Runtime Data Path Verification — per-stage instrumentation: "Every stage must expose packets
 * entered, packets exited, failures, timestamps, latency."
 *
 * Every field is `number | null` / `string | null` because for several real stages some of these
 * are genuinely not observable, and a `0` would be a lie in exactly the place this investigation
 * cannot afford one — "zero packets entered" and "we cannot count what enters this stage" lead to
 * opposite conclusions. Any `null` MUST be explained in {@link unmeasured}; a null with no reason
 * is a bug in the reporter, not an acceptable gap.
 */
export interface StageMetrics {
  /** Datagrams that reached this stage's input. */
  entered: number | null;
  /** Datagrams this stage successfully passed on to the next one. `entered - exited` is the loss
   * attributable to THIS stage, which is the whole point of measuring both. */
  exited: number | null;
  failures: number | null;
  firstAt: string | null;
  lastAt: string | null;
  /** Real measured time attributable to this stage, when something measures it. Never estimated
   * by dividing an end-to-end figure across stages. */
  latencyMs: number | null;
  /** Why any field above is `null`. Required whenever one is. */
  unmeasured: string | null;
}

export interface PipelineStage {
  /** Short display name, e.g. "Joined Multicast", "Received Search Response". */
  name: string;
  status: PipelineStageStatus;
  /** Why this stage is in this state — required for `fail` and `waiting` (an installer staring at
   * a non-green row must always be told what it means), optional for `pass`. */
  detail?: string;
  /** § Runtime Data Path Verification. Optional so the existing Casambi/KNX stage builders are
   * unchanged; stages that carry it render the full instrumented row. */
  metrics?: StageMetrics;
}

/** Builds a {@link StageMetrics} with every field defaulting to "not measured", so a caller can
 * only ever report a number it actually has. Enforces the null-needs-a-reason rule structurally:
 * omitting a field leaves it `null`, and `unmeasured` is a required argument. */
export function stageMetrics(unmeasured: string | null, known: Partial<Omit<StageMetrics, "unmeasured">> = {}): StageMetrics {
  const metrics: StageMetrics = {
    entered: known.entered ?? null,
    exited: known.exited ?? null,
    failures: known.failures ?? null,
    firstAt: known.firstAt ?? null,
    lastAt: known.lastAt ?? null,
    latencyMs: known.latencyMs ?? null,
    unmeasured,
  };
  // Enforce the null-needs-a-reason rule for the one case a caller forgets most easily. Most
  // stages in a receive path genuinely have no latency of their own to measure — the handoff is a
  // synchronous function call — and silently leaving that null would look like a missing
  // measurement rather than an absent concept.
  if (metrics.latencyMs === null) {
    metrics.unmeasured = joinReasons(metrics.unmeasured, NO_STAGE_LATENCY);
  }
  return metrics;
}

const NO_STAGE_LATENCY =
  "No latency is attributed to this stage: the handoff to the next stage is a synchronous in-process call, so there is no queue or transport in between whose delay could be measured. Splitting an end-to-end figure across stages would be an estimate, not a measurement.";

function joinReasons(a: string | null, b: string): string {
  return a && a.length > 0 ? `${a} ${b}` : b;
}

/** Helper: a stage backed by a real counter. `waiting` (not `fail`) while the count is zero and
 * nothing has gone wrong — "hasn't happened yet" is not the same as "is broken". */
export function countedStage(name: string, count: number, opts: { waitingDetail: string; passDetail?: (n: number) => string } ): PipelineStage {
  return count > 0
    ? { name, status: "pass", detail: opts.passDetail?.(count) ?? `${count}` }
    : { name, status: "waiting", detail: opts.waitingDetail };
}

/** Helper: a stage that is simply true/false right now (a socket is bound, or it isn't). */
export function booleanStage(name: string, ok: boolean, opts: { failDetail: string; passDetail?: string }): PipelineStage {
  return ok ? { name, status: "pass", detail: opts.passDetail } : { name, status: "fail", detail: opts.failDetail };
}

/** The first stage that isn't `pass` — "prove exactly where the pipeline stopped" as one answer.
 * `null` when every stage passed. */
export function firstNonPassingStage(stages: readonly PipelineStage[]): PipelineStage | null {
  return stages.find((s) => s.status !== "pass") ?? null;
}

/** Renders the ✓ / ✗ / … checklist. Kept separate from the data so a UI can style it instead. */
export function formatPipelineStages(stages: readonly PipelineStage[]): string {
  return stages
    .map((s) => {
      const mark = s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : "…";
      return s.detail ? `${mark} ${s.name} — ${s.detail}` : `${mark} ${s.name}`;
    })
    .join("\n");
}
