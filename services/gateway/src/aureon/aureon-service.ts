import type { AssistantService, ProposedCommand } from "@supreme/ai";
import type {
  AureonTransaction,
  AureonTransactionId,
  Grant,
  HomeId,
  User,
} from "@supreme/domain-model";
import type { PolicyEngine } from "@supreme/permissions";
import type { AureonHomeGraph } from "./home-graph.js";
import type { AureonActionEngine } from "./action-engine.js";
import type { InMemoryAureonTransactionStore } from "./transaction-store.js";
import { maxRisk } from "./risk.js";
import { explainTransaction } from "./explain.js";

/**
 * Aureon Conversation/Intent/Planning/Policy orchestrator, MVP slice (§
 * AUREON-ARCHITECTURE.md §2.1-2.2, brief Steps 3/7/8/9/18).
 *
 * Deliberately thin: Understand + Plan is delegated to the EXISTING, unmodified
 * `@supreme/ai` `AssistantService` (deterministic NL planner, optionally backed by
 * the on-box LLM sidecar) — Aureon does not re-implement NL parsing. This class adds
 * exactly what didn't exist before: risk classification, authorization via the
 * EXISTING `PolicyEngine`/RBAC+ABAC (never a second permission system), a
 * confirm-before-consequential-action gate, and delegating execution+verification to
 * {@link AureonActionEngine}.
 *
 * `scene`/`automation` drafts from the assistant are intentionally NOT auto-created
 * in this phase (brief Step 19: "do not prematurely implement... automatic
 * modification of critical automations") — they come back as a proposal for the
 * user to review and create through the existing Scene/Automation APIs.
 */
export interface AureonConverseRequest {
  user: User;
  utterance: string;
  /** True once the user has explicitly accepted a previously-returned proposal. */
  confirm?: boolean;
}

export type AureonConverseResult =
  | { kind: "answer"; summary: string }
  | { kind: "denied"; reason: string }
  | {
      kind: "proposal";
      summary: string;
      riskLevel: 0 | 1 | 2 | 3;
      commands: ProposedCommand[];
    }
  | {
      kind: "draft";
      /** "scene" | "automation" — surfaced for the client to route to the existing
       * Scene/Automation creation UI; Aureon never creates these itself yet. */
      draftKind: "scene" | "automation";
      summary: string;
    }
  | { kind: "executed"; summary: string; transaction: AureonTransaction };

export class AureonService {
  constructor(
    private readonly ai: AssistantService,
    private readonly homeGraph: AureonHomeGraph,
    private readonly policy: PolicyEngine,
    private readonly grantsFor: (userId: User["id"]) => Promise<Grant[]>,
    private readonly actionEngine: AureonActionEngine,
    private readonly transactions: InMemoryAureonTransactionStore,
    private readonly homeId: HomeId,
  ) {}

  async converse(req: AureonConverseRequest): Promise<AureonConverseResult> {
    const context = await this.homeGraph.assistantContext();
    const result = await this.ai.assist({ utterance: req.utterance, context });

    if (result.kind === "answer") {
      return { kind: "answer", summary: result.summary };
    }
    if (result.kind === "scene" || result.kind === "automation") {
      return { kind: "draft", draftKind: result.kind, summary: result.summary };
    }

    // result.kind === "actions"
    const commands = result.commands;
    const riskLevel = maxRisk(commands);

    const grants = await this.grantsFor(req.user.id);
    const decision = this.policy.decide(
      { user: req.user, resourceType: "intent", resourceId: null, action: "control" },
      grants,
    );
    if (!decision.allowed) {
      return { kind: "denied", reason: decision.reason };
    }

    // LEVEL 2/3 always require explicit confirmation — never removable via user
    // preference for LEVEL 3 (§ AUREON-ARCHITECTURE.md §5), and not yet skippable
    // for LEVEL 2 in this phase either (no trust/preference model built yet).
    if (riskLevel >= 2 && !req.confirm) {
      return { kind: "proposal", summary: result.summary, riskLevel, commands };
    }

    const transaction = await this.actionEngine.execute({
      homeId: this.homeId,
      userId: req.user.id,
      utterance: req.utterance,
      riskLevel,
      commands,
    });
    this.transactions.save(transaction);
    return { kind: "executed", summary: explainTransaction(transaction), transaction };
  }

  async undo(transactionId: AureonTransactionId, user: User): Promise<AureonConverseResult> {
    const original = this.transactions.get(transactionId);
    if (!original) {
      return { kind: "denied", reason: "unknown or expired transaction" };
    }
    if (original.homeId !== this.homeId) {
      return { kind: "denied", reason: "transaction belongs to a different home" };
    }
    const grants = await this.grantsFor(user.id);
    const decision = this.policy.decide(
      { user, resourceType: "intent", resourceId: null, action: "control" },
      grants,
    );
    if (!decision.allowed) {
      return { kind: "denied", reason: decision.reason };
    }
    const undone = await this.actionEngine.undo(original, user.id);
    this.transactions.save(undone);
    return { kind: "executed", summary: explainTransaction(undone), transaction: undone };
  }

  getTransaction(id: AureonTransactionId): AureonTransaction | null {
    return this.transactions.get(id);
  }
}
