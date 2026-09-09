import type {
  CapabilityKind,
  Device,
  DeviceId,
  KeypadMapping,
  KeypadMappingBehavior,
  KeypadMappingInput,
  KeypadMappingTarget,
  Room,
  RoomId,
} from "@supreme/domain-model";
import { LEVEL_STEP_CAPABLE_CAPABILITIES, TOGGLE_CAPABLE_CAPABILITIES } from "@supreme/domain-model";
import type { CreateKeypadMappingRequest, UpdateKeypadMappingRequest } from "@supreme/contracts";
import { CAPABILITY_LABELS, commandableCapabilities, resolveCommandDefinitions } from "./automation-capability-fields.js";

/**
 * Supreme Universal Keypad — pure UI logic (§ Universal Keypad Framework, Stage 3B).
 * Kept separate from `universal-keypad.tsx`'s React component so the room-grouping,
 * request-building, and validation rules are testable the same way every other page's
 * logic already is in this app (see `screens.tsx`'s `categorize()` / `navigation.test.ts`'s
 * pure exports) — this repo has no component-rendering test infra, so anything worth
 * covering with a real test has to be expressible as a plain function.
 */

// ── Discovery / room grouping (§2, §3 — same Device entity as the Room page, no second registry) ──

export interface KeypadRoomGroup {
  room: Room | null; // null = "Unassigned"
  keypads: Device[];
}

const UNASSIGNED_SORT_KEY = "￿"; // sorts after every real room name

/**
 * Groups already-fetched keypad `Device`s (supremeType === "keypad") by room, using the
 * SAME `Room`/`Device` entities the Room page's own Keypads category (`screens.tsx`)
 * already renders — this function invents no new identity, it only regroups data the
 * gateway's existing `/v1/devices` + `/v1/rooms` endpoints already return. A keypad whose
 * `roomId` doesn't match any known room (not yet assigned) lands in an "Unassigned" group,
 * sorted last, mirroring the Room page's own "Unassigned Devices" convention.
 */
export function groupKeypadsByRoom(devices: readonly Device[], rooms: readonly Room[]): KeypadRoomGroup[] {
  const keypads = devices.filter((d) => d.supremeType === "keypad");
  const roomById = new Map(rooms.map((r) => [r.id, r] as const));
  const byRoom = new Map<string, Device[]>();
  for (const kp of keypads) {
    const key = kp.roomId && roomById.has(kp.roomId) ? kp.roomId : UNASSIGNED_SORT_KEY;
    const list = byRoom.get(key);
    if (list) list.push(kp);
    else byRoom.set(key, [kp]);
  }
  const groups: KeypadRoomGroup[] = [];
  for (const [key, list] of byRoom) {
    groups.push({ room: key === UNASSIGNED_SORT_KEY ? null : (roomById.get(key as RoomId) ?? null), keypads: list });
  }
  return groups.sort((a, b) => (a.room?.name ?? UNASSIGNED_SORT_KEY).localeCompare(b.room?.name ?? UNASSIGNED_SORT_KEY));
}

// ── Behavior model (§5, §7, §8, §9 — mirrors the Stage 2 backend exactly, invents nothing new) ──

export const KEYPAD_BEHAVIORS: readonly KeypadMappingBehavior[] = ["direct", "toggle", "alternate", "cycle", "increment", "decrement"];

export const BEHAVIOR_LABELS: Record<KeypadMappingBehavior, string> = {
  direct: "Direct",
  toggle: "Toggle",
  alternate: "Alternate",
  cycle: "Cycle",
  increment: "Increment",
  decrement: "Decrement",
};

/** § Universal Keypad — press-slot summary. `mapping.name` is whatever the installer typed
 * (or the auto-generated "<keypad name> — <control id>" default) when the mapping was
 * created — never a reliable description of WHAT it actually does. This reads the mapping's
 * real target (device name · capability · behavior), the same thumb rule for every keypad,
 * every button, every event — `target` for toggle/alternate/increment/decrement, the first
 * `device_command` action for direct/cycle. Falls back to `mapping.name` only for the
 * genuinely deviceless case (a direct mapping whose actions are all scene/notify/delay). */
export function summarizeMapping(mapping: KeypadMapping, devices: readonly Device[]): string {
  const deviceName = (id: DeviceId) => devices.find((d) => d.id === id)?.name ?? "Unknown device";
  if (mapping.target) {
    return `${deviceName(mapping.target.deviceId)} · ${CAPABILITY_LABELS[mapping.target.capability]} · ${BEHAVIOR_LABELS[mapping.behavior]}`;
  }
  const firstCommand = mapping.actions.find((a) => a.type === "device_command");
  if (firstCommand && firstCommand.type === "device_command") {
    const extra = mapping.actions.length > 1 ? ` +${mapping.actions.length - 1} more` : "";
    return `${deviceName(firstCommand.deviceId)} · ${CAPABILITY_LABELS[firstCommand.command.capability]} · ${BEHAVIOR_LABELS[mapping.behavior]}${extra}`;
  }
  return mapping.name;
}

/** Short, homeowner-facing description of what each behavior does — never mentions
 * `behaviorState`/`lastDirection`/`cycleIndex` (§8: those are backend-owned runtime state,
 * never surfaced as something the installer configures). */
export const BEHAVIOR_DESCRIPTIONS: Record<KeypadMappingBehavior, string> = {
  direct: "Runs one or more actions, in order, every time this button fires.",
  toggle: "Flips the target between on and off, always reading its real current state.",
  alternate: "Alternates direction each press — e.g. dim up, then dim down, then up again.",
  cycle: "Steps through a list of actions one at a time, wrapping back to the first.",
  increment: "Always steps the target up by a fixed amount.",
  decrement: "Always steps the target down by a fixed amount.",
};

/** A behavior needs a `target` (device + capability) for anything but `"direct"` — mirrors
 * `KeypadMapping`'s own `superRefine` in `@supreme/domain-model` exactly; this function exists
 * so the form can show/hide the target picker without re-deriving that rule. */
export function behaviorRequiresTarget(behavior: KeypadMappingBehavior): boolean {
  return behavior !== "direct";
}

/** `"direct"` runs the whole action list; `"cycle"` walks it one at a time — both need at
 * least one configured action. `"toggle"`/`"alternate"`/`"increment"`/`"decrement"` resolve
 * their own single command from `target` and never touch the action list at all. */
export function behaviorRequiresActions(behavior: KeypadMappingBehavior): boolean {
  return behavior === "direct" || behavior === "cycle";
}

/** Only alternate/increment/decrement step a level — the UI's `step` field is meaningless
 * (and hidden) for toggle/direct/cycle. */
export function behaviorUsesStep(behavior: KeypadMappingBehavior): boolean {
  return behavior === "alternate" || behavior === "increment" || behavior === "decrement";
}

/** Homeowner-facing preview of what the two alternating presses will do, for `"alternate"`
 * only — text-only, never reads or exposes `behaviorState.lastDirection`. */
export function alternatePreview(capability: CapabilityKind | undefined): { first: string; next: string } {
  if (capability === "position") return { first: "First activation: Open a step", next: "Next activation: Close a step" };
  return { first: "First activation: Dim up", next: "Next activation: Dim down" };
}

// ── Capability / action picker (§6 — capability-driven, no protocol branch) ────────────────────

/** Every capability this specific device can actually be commanded on — the SAME resolver
 * (`commandableCapabilities`) the Automation Builder already uses, so "what can this target
 * do" is answered identically everywhere in the app, never re-derived per page. */
export function targetableCapabilities(device: Device): CapabilityKind[] {
  return commandableCapabilities(device.capabilities.map((c) => c.kind));
}

/** § live-confirmed fix — `targetableCapabilities` alone let the installer pick a
 * behavior/capability combination the backend's own schema rejects (e.g. "Toggle" + "Color" —
 * toggling between what and what? — `KeypadMapping`'s `TOGGLE_CAPABLE_CAPABILITIES` never
 * included it), surfacing only a generic "request validation failed" at save time. Filters the
 * SAME server-side compatibility lists (`TOGGLE_CAPABLE_CAPABILITIES`/
 * `LEVEL_STEP_CAPABLE_CAPABILITIES` — never a second, drifting copy) so an incompatible
 * combination can't be selected in the first place. `"direct"`/`"cycle"` have no such
 * restriction (they resolve `actions[]`, never a single `target.capability`). */
export function targetCapabilitiesForBehavior(device: Device, behavior: KeypadMappingBehavior): CapabilityKind[] {
  const all = targetableCapabilities(device);
  if (behavior === "toggle") return all.filter((c) => TOGGLE_CAPABLE_CAPABILITIES.includes(c));
  if (behavior === "alternate" || behavior === "increment" || behavior === "decrement") {
    return all.filter((c) => LEVEL_STEP_CAPABLE_CAPABILITIES.includes(c));
  }
  return all;
}

export { CAPABILITY_LABELS, resolveCommandDefinitions };

// ── Form state → API request (§11 — persists behavior/target/actions, never behaviorState) ─────

export interface KeypadActionFormEntry {
  deviceId: DeviceId;
  capability: CapabilityKind;
  /** `null` for a capability whose command has no verb (color/temperature — every param is
   * always relevant), mirroring `CommandDefinition.action` exactly. */
  action: string | null;
  params: Record<string, string | number | boolean>;
}

export interface KeypadMappingFormState {
  name: string;
  keypadId: DeviceId;
  control: string;
  /** Preserves the full lifecycle — `"short_press"` and the independent `"hold_start"`/
   * `"hold_end"` pair (§10) are just different `event` values on otherwise-identical form
   * state; nothing here collapses long-press into one event. */
  event: KeypadMappingInput["event"];
  behavior: KeypadMappingBehavior;
  targetDeviceId: DeviceId | null;
  targetCapability: CapabilityKind | null;
  step: number;
  actions: KeypadActionFormEntry[];
}

export function emptyKeypadMappingForm(keypadId: DeviceId, control: string, event: KeypadMappingInput["event"]): KeypadMappingFormState {
  return { name: "", keypadId, control, event, behavior: "direct", targetDeviceId: null, targetCapability: null, step: 10, actions: [] };
}

function actionEntryToRequestAction(e: KeypadActionFormEntry): Record<string, unknown> {
  const command: Record<string, unknown> = { capability: e.capability, ...e.params };
  if (e.action !== null) command.action = e.action;
  return { type: "device_command", deviceId: e.deviceId, command };
}

/** Client-side completeness check mirroring the domain model's own `superRefine` (never a
 * SEPARATE source of truth for the rule — just gives the form an inline message instead of
 * only finding out after a round trip to the server, which still re-validates for real). */
export function validateKeypadMappingForm(form: KeypadMappingFormState): string | null {
  if (!form.name.trim()) return "Name is required.";
  if (!form.control.trim()) return "Choose a button/control.";
  if (behaviorRequiresTarget(form.behavior) && (!form.targetDeviceId || !form.targetCapability)) {
    return `"${BEHAVIOR_LABELS[form.behavior]}" needs a target device and capability.`;
  }
  if (behaviorRequiresActions(form.behavior) && form.actions.length === 0) {
    return form.behavior === "cycle" ? "Add at least one action to cycle through." : "Add at least one action.";
  }
  return null;
}

function buildTarget(form: KeypadMappingFormState): KeypadMappingTarget | null {
  if (!behaviorRequiresTarget(form.behavior)) return null;
  if (!form.targetDeviceId || !form.targetCapability) return null;
  return { deviceId: form.targetDeviceId, capability: form.targetCapability, step: form.step };
}

/** Assembles a `CreateKeypadMappingRequest` from form state (§11: `behavior`/`target`/
 * `actions` only — `behaviorState` has no field on this form at all, so it is structurally
 * impossible for the UI to send one). Throws with the same message `validateKeypadMappingForm`
 * would return if the form is incomplete — call that first for an inline error instead. */
export function buildCreateKeypadMappingRequest(form: KeypadMappingFormState): CreateKeypadMappingRequest {
  const err = validateKeypadMappingForm(form);
  if (err) throw new Error(err);
  return {
    name: form.name.trim(),
    enabled: true,
    input: { keypadId: form.keypadId, control: form.control, event: form.event },
    conditions: [],
    actions: behaviorRequiresActions(form.behavior) ? form.actions.map(actionEntryToRequestAction) : [],
    behavior: form.behavior,
    target: buildTarget(form),
    variables: {},
  } as CreateKeypadMappingRequest;
}

/** Same assembly for an update — every field is sent explicitly (never a partial "only what
 * changed" diff) because the form always holds the mapping's complete current configuration;
 * `behaviorState` is still never part of the payload, so an edit can never reset a live
 * mapping's `lastDirection`/`cycleIndex` (the backend's `update()` carries it forward from the
 * stored mapping precisely because this request never mentions it — see Stage 3A). */
export function buildUpdateKeypadMappingRequest(form: KeypadMappingFormState): UpdateKeypadMappingRequest {
  const err = validateKeypadMappingForm(form);
  if (err) throw new Error(err);
  return {
    name: form.name.trim(),
    input: { keypadId: form.keypadId, control: form.control, event: form.event },
    actions: behaviorRequiresActions(form.behavior) ? form.actions.map(actionEntryToRequestAction) : [],
    behavior: form.behavior,
    target: buildTarget(form),
  } as UpdateKeypadMappingRequest;
}

/** The inverse of the two builders above — loads an EXISTING mapping into editable form
 * state. Deliberately reads nothing from `mapping.behaviorState` (§8/§11: it is runtime
 * engine state, never something an edit form displays or round-trips). A legacy mapping
 * (`behavior: "direct"`, `target: null` — every mapping created before Stage 2) loads exactly
 * like any other direct mapping; there is no separate "legacy" code path. */
export function mappingToFormState(mapping: KeypadMapping): KeypadMappingFormState {
  return {
    name: mapping.name,
    keypadId: mapping.input.keypadId,
    control: mapping.input.control,
    event: mapping.input.event,
    behavior: mapping.behavior,
    targetDeviceId: mapping.target?.deviceId ?? null,
    targetCapability: mapping.target?.capability ?? null,
    step: mapping.target?.step ?? 10,
    actions: mapping.actions
      .filter((a): a is Extract<typeof a, { type: "device_command" }> => a.type === "device_command")
      .map((a) => {
        const { capability, action, ...params } = a.command as Record<string, unknown> & { capability: CapabilityKind; action?: string };
        return { deviceId: a.deviceId, capability, action: action ?? null, params: params as Record<string, string | number | boolean> };
      }),
  };
}
