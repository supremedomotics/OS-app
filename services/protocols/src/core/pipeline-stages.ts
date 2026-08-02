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

export interface PipelineStage {
  /** Short display name, e.g. "Joined Multicast", "Received Search Response". */
  name: string;
  status: PipelineStageStatus;
  /** Why this stage is in this state — required for `fail` and `waiting` (an installer staring at
   * a non-green row must always be told what it means), optional for `pass`. */
  detail?: string;
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
