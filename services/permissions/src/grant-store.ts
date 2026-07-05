import {
  newId,
  type Action,
  type Effect,
  type Grant,
  type GrantId,
  type ResourceType,
  type ScheduleWindow,
  type UserId,
} from "@supreme/domain-model";

/**
 * Grant persistence boundary (§8). Grants are the ABAC overlay — per-resource,
 * time-bounded allow/deny rules layered on the RBAC baseline. The Postgres
 * implementation in `@supreme/persistence` satisfies the same interface.
 */
export interface IGrantStore {
  listForUser(userId: UserId): Promise<Grant[]>;
  add(grant: Grant): Promise<void>;
  remove(id: GrantId): Promise<void>;
}

export class InMemoryGrantStore implements IGrantStore {
  private readonly byUser = new Map<UserId, Grant[]>();
  async listForUser(userId: UserId) {
    return this.byUser.get(userId) ?? [];
  }
  async add(grant: Grant) {
    const list = this.byUser.get(grant.userId) ?? [];
    list.push(grant);
    this.byUser.set(grant.userId, list);
  }
  async remove(id: GrantId) {
    for (const [user, list] of this.byUser) {
      this.byUser.set(
        user,
        list.filter((g) => g.id !== id),
      );
    }
  }
}

export interface CreateGrantInput {
  userId: UserId;
  resourceType: ResourceType;
  resourceId?: string | null;
  action: Action;
  effect?: Effect;
  validFrom?: string | null;
  validUntil?: string | null;
  schedule?: ScheduleWindow[] | null;
}

/** Build a Grant record with a fresh id from an input. */
export function buildGrant(input: CreateGrantInput): Grant {
  return {
    id: newId("grant") as GrantId,
    userId: input.userId,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    action: input.action,
    effect: input.effect ?? "allow",
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    schedule: input.schedule ?? null,
  };
}
