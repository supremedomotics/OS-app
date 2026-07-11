import type { Action, ResourceType, UserType } from "@supreme/domain-model";

/**
 * RBAC baseline (§8). Each user type seeds a baseline set of allowed (resourceType,
 * action) pairs. Fine-grained, per-resource and time-bound rules are layered on top as
 * ABAC grants (see policy.ts).
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
  homeowner: {
    // The primary resident of a self-managed home: full day-to-day control PLUS the ability to
    // shape their own home — add/rename/remove rooms and add/configure integrations & drivers.
    // Still not a system administrator (no integration `admin`, no destructive home actions).
    home: ["view", "update"],
    room: ALL,
    device: VIEW_CONTROL,
    scene: ["view", "control", "create", "update", "delete"],
    automation: ["view", "control", "create", "update"],
    camera: VIEW_CONTROL,
    integration: ["view", "control", "create", "update", "delete"],
    user: ["view"],
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
    camera: ALL,
  },
  service_engineer: {
    // Diagnostics + maintenance: can view/control to test devices and inspect
    // integrations, but no user administration and no destructive actions.
    room: VIEW_CONTROL,
    device: VIEW_CONTROL,
    scene: ["view", "control"],
    automation: ["view"],
    integration: ["view"],
    camera: ["view"],
  },
  developer: {
    // Same shape as installer (full build/debug access to everything except home
    // settings and user administration) — a developer needs to create/inspect/tear
    // down devices, scenes, automations and integrations while building or diagnosing
    // drivers, but never manages other accounts.
    room: ALL,
    device: ALL,
    scene: ALL,
    automation: ALL,
    integration: ALL,
    camera: ALL,
  },
};

/**
 * The roles offered in the "Create New User" UI, in presentation order, with display
 * labels mapped onto the internal {@link UserType} keys. Drives GET /v1/roles.
 */
export const ASSIGNABLE_ROLES = [
  { key: "master", label: "Super Administrator", description: "Full control of the entire system." },
  { key: "admin", label: "Administrator", description: "Manage the home, devices, scenes and users." },
  { key: "homeowner", label: "Homeowner", description: "Primary resident — full day-to-day control of the home." },
  { key: "family", label: "Family Member", description: "Control rooms and devices; create scenes." },
  { key: "guest", label: "Guest", description: "Limited, often time-bound access to shared spaces." },
  { key: "installer", label: "Installer", description: "Commission devices and integrations; no user administration." },
  { key: "developer", label: "Developer", description: "Diagnostics and protocol/driver tooling; no user administration." },
  { key: "service_engineer", label: "Service Engineer", description: "Diagnostics and maintenance access." },
] as const satisfies ReadonlyArray<{ key: UserType; label: string; description: string }>;

export function baselineAllows(
  userType: UserType,
  resourceType: ResourceType,
  action: Action,
): boolean {
  return BASELINE_ROLES[userType][resourceType]?.includes(action) ?? false;
}
