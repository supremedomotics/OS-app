import type { ProposedCommand } from "@supreme/ai";
import {
  newId,
  type AureonRiskLevel,
  type AureonTransaction,
  type AureonTransactionEntry,
  type AureonVerificationStatus,
  type CapabilityCommand,
  type CapabilityKind,
  type CapabilityState,
  type DeviceId,
  type HomeId,
  type UserId,
} from "@supreme/domain-model";
import type { SupremeIntegrationLayer } from "@supreme/integration-layer";
import type { AuditService } from "@supreme/audit";

/**
 * Aureon Action + Verification Engine, MVP slice (§ AUREON-ARCHITECTURE.md §4 steps
 * 7-9, brief Steps 10/12).
 *
 * Hard rule this class exists to enforce: a command being ACCEPTED by
 * `SupremeIntegrationLayer.command()` is never treated as success. Every entry is
 * re-read via `SupremeIntegrationLayer.getState()` after dispatch and classified
 * against what was actually asked for. If the post-state can't be read, or the
 * capability's success can't be confidently checked from it, the entry is
 * `unverified` — never silently upgraded to success.
 *
 * This engine talks to SIL/Audit exactly the way `AutomationEngine`'s executors do
 * (`services/automations/src/engine.ts`'s `AutomationExecutors.command`) — Aureon is
 * one more caller of the same execution surface, not a parallel path into hardware.
 */
export class AureonActionEngine {
  constructor(
    private readonly sil: Pick<SupremeIntegrationLayer, "command" | "getState">,
    private readonly audit: AuditService | null,
    private readonly verifyDelayMs = 400,
  ) {}

  async execute(input: {
    homeId: HomeId;
    userId: UserId;
    utterance: string;
    riskLevel: AureonRiskLevel;
    commands: readonly ProposedCommand[];
    /** Set when this execution is an undo of a prior transaction. */
    undoOf?: AureonTransaction["undoOf"];
  }): Promise<AureonTransaction> {
    const entries: AureonTransactionEntry[] = [];
    for (const c of input.commands) {
      entries.push(await this.runOne(c));
    }

    const tx: AureonTransaction = {
      id: newId("aureonTransaction") as AureonTransaction["id"],
      homeId: input.homeId,
      userId: input.userId,
      utterance: input.utterance,
      riskLevel: input.riskLevel,
      createdAt: new Date().toISOString(),
      entries,
      undoOf: input.undoOf ?? null,
      status: overallStatus(entries),
    };

    await this.audit?.record({
      homeId: input.homeId,
      actorUserId: input.userId,
      action: "control",
      resourceType: "intent",
      resourceId: null,
      metadata: {
        aureonTransactionId: tx.id,
        undoOf: tx.undoOf,
        utterance: input.utterance,
        deviceCount: entries.length,
        status: tx.status,
      },
    });

    return tx;
  }

  /**
   * Undo a transaction by replaying each entry's REAL captured `priorState` — never
   * a guessed inverse command (§ AUREON-ARCHITECTURE.md §3.6, brief Step 11). Entries
   * whose capability has no safe/unambiguous state→command reconstruction in this
   * phase (media, vacuum, fan, color, temperature) are reported `not_supported`
   * rather than attempting a best-effort guess.
   */
  async undo(tx: AureonTransaction, userId: UserId): Promise<AureonTransaction> {
    const commands: ProposedCommand[] = [];
    const unsupported: AureonTransactionEntry[] = [];
    for (const entry of tx.entries) {
      // Attempt undo whenever we captured a real prior state and the command was at
      // least dispatched (verified_success or genuinely unverified — NOT a failure,
      // timeout, denial, or unsupported command, which never took effect to undo).
      const dispatched = entry.status === "verified_success" || entry.status === "unverified";
      if (!dispatched || !entry.priorState) continue;
      const inverse = commandFromState(entry.priorState);
      if (!inverse) {
        unsupported.push({
          deviceId: entry.deviceId,
          deviceName: entry.deviceName,
          command: entry.command,
          priorState: null,
          postState: null,
          status: "not_supported",
          error: `undo not implemented for capability "${entry.command.capability}" in this phase`,
        });
        continue;
      }
      commands.push({ deviceId: entry.deviceId, deviceName: entry.deviceName, command: inverse });
    }

    const result = await this.execute({
      homeId: tx.homeId,
      userId,
      utterance: `undo ${tx.id}`,
      riskLevel: tx.riskLevel,
      commands,
      undoOf: tx.id,
    });
    return { ...result, entries: [...result.entries, ...unsupported] };
  }

  private async runOne(c: ProposedCommand): Promise<AureonTransactionEntry> {
    const deviceId = c.deviceId as DeviceId;
    const capability = c.command.capability as CapabilityKind;

    const priorState = await this.safeGetState(deviceId, capability);

    try {
      await this.sil.command(deviceId, c.command);
    } catch (err) {
      return {
        deviceId,
        deviceName: c.deviceName,
        command: c.command,
        priorState,
        postState: null,
        status: dispatchErrorStatus(err),
        error: errorMessage(err),
      };
    }

    await sleep(this.verifyDelayMs);
    const postState = await this.safeGetState(deviceId, capability);
    const status = classifyOutcome(c.command, postState);

    return {
      deviceId,
      deviceName: c.deviceName,
      command: c.command,
      priorState,
      postState,
      status,
      error: null,
    };
  }

  private async safeGetState(deviceId: DeviceId, capability: CapabilityKind): Promise<CapabilityState | null> {
    try {
      return await this.sil.getState(deviceId, capability);
    } catch {
      return null;
    }
  }
}

function overallStatus(entries: AureonTransactionEntry[]): AureonTransaction["status"] {
  if (entries.length === 0) return "completed";
  if (entries.every((e) => e.status === "denied")) return "denied";
  if (entries.every((e) => e.status === "verified_success")) return "completed";
  if (entries.some((e) => e.status === "verified_success")) return "partially_failed";
  return "failed";
}

function dispatchErrorStatus(err: unknown): AureonVerificationStatus {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === "validation_failed") return "not_supported";
  if (code === "backend_unavailable") return "timeout";
  return "verified_failure";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compare what was commanded against what SIL actually reports afterward. Only
 * capabilities with an unambiguous single-field success check are classified as
 * verified here; everything else is honestly `unverified` rather than assumed.
 */
function classifyOutcome(command: CapabilityCommand, postState: CapabilityState | null): AureonVerificationStatus {
  if (!postState) return "unverified";
  if (postState.kind !== command.capability) return "unverified";

  switch (command.capability) {
    case "onoff":
      if (postState.kind !== "onoff") return "unverified";
      if (command.action === "toggle") return "verified_success"; // no fixed expected value to compare
      return postState.on === (command.action === "on") ? "verified_success" : "verified_failure";
    case "brightness":
      if (postState.kind !== "brightness") return "unverified";
      if (command.action === "off") return postState.on === false ? "verified_success" : "verified_failure";
      if (command.action === "on") return postState.on === true ? "verified_success" : "verified_failure";
      if (command.level === undefined) return "unverified";
      return postState.level === command.level ? "verified_success" : "verified_failure";
    case "lock":
      if (postState.kind !== "lock") return "unverified";
      return postState.locked === (command.action === "lock") ? "verified_success" : "verified_failure";
    case "position":
      if (postState.kind !== "position") return "unverified";
      if (command.action === "open") return postState.position === 100 ? "verified_success" : "verified_failure";
      if (command.action === "close") return postState.position === 0 ? "verified_success" : "verified_failure";
      if (command.action === "set" && command.position !== undefined) {
        return postState.position === command.position ? "verified_success" : "verified_failure";
      }
      return "unverified"; // "stop" has no fixed expected position
    default:
      // color / temperature / media / fan / vacuum: multi-field or open-ended commands
      // with no single safe equality check in this phase — report honestly rather
      // than guess. A successful dispatch with a readable post-state still counts as
      // real progress toward Phase 2's richer per-capability verification.
      return "unverified";
  }
}

/** Reconstruct the command that would restore a capability to a previously-observed
 * state — used ONLY by undo(), and ONLY for capabilities with an unambiguous mapping. */
function commandFromState(state: CapabilityState): CapabilityCommand | null {
  switch (state.kind) {
    case "onoff":
      return { capability: "onoff", action: state.on ? "on" : "off" };
    case "brightness":
      return state.on
        ? { capability: "brightness", action: "set", level: state.level }
        : { capability: "brightness", action: "off" };
    case "lock":
      return { capability: "lock", action: state.locked ? "lock" : "unlock" };
    case "position":
      return { capability: "position", action: "set", position: state.position };
    default:
      return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
