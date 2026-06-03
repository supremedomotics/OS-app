import type { Action, ResourceType, UserType } from "@supreme/domain-model";

/**
 * RBAC baseline (§8). Each of the 7 user types seeds a baseline set of allowed
 * (resourceType, action) pairs. Fine-grained, per-resource and time-bound rules
 * are layered on top as ABAC grants (see policy.ts).
 *
 * Baselines are intentionally coarse: they answer "can this kind of user ever do
 * this kind of thing?". Narrowing to specific rooms/devices/time windows is the
 * job of grants.
 */
export type RolePolicy = Partial<Record<ResourceType, Action[]>>;

const ALL: Action[] = ["view", "control", "create", "update", "delete", "admin"];
const VIEW_CONTROL: Action[] = ["view", "control"];

export const BASELINE_ROLES: Record<UserType, RolePolicy> = {
  master: {
    home: ALL,
    room: ALL,
    device: ALL,
    scene: ALL,
    automation: ALL,
    camera: ALL,
    integration: ALL,
    user: ALL,
  },
  admin: {
    home: ["view", "update", "admin"],
    room: ALL,
    device: ALL,
    scene: ALL,
    automation: ALL,
    camera: ALL,
    integration: ALL,
    user: ["view", "create", "update"],
  },
  family: {
    home: ["view"],
    room: VIEW_CONTROL,
    device: VIEW_CONTROL,
    scene: ["view", "control", "create", "update"],
    automation: ["view", "control"],
    camera: ["view"],
  },
  child: {
    home: ["view"],
    room: VIEW_CONTROL,
    device: VIEW_CONTROL,
    scene: ["view", "control"],
  },
  guest: {
    room: VIEW_CONTROL,
    device: VIEW_CONTROL,
    scene: ["view", "control"],
  },
  staff: {
    room: VIEW_CONTROL,
    device: VIEW_CONTROL,
    scene: ["view", "control"],
  },
  installer: {
    room: ALL,
    device: ALL,
    scene: ALL,
    automation: ALL,
    integration: ALL,
    camera: ["view"],
  },
};

export function baselineAllows(
  userType: UserType,
  resourceType: ResourceType,
  action: Action,
): boolean {
  return BASELINE_ROLES[userType][resourceType]?.includes(action) ?? false;
}
