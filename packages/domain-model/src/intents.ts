import { z } from "zod";
import { AutomationId, DeviceId, RoomId, SceneId } from "./ids.js";
import { CapabilityKind } from "./capabilities.js";

/**
 * Universal Intent & Capability Engine (§ Phase 2 — ADR 0017).
 *
 * The semantic layer between "something happened" (a keypad press, a scene
 * trigger, a future AI utterance, a voice assistant) and "write this capability
 * command to this device." Nothing upstream of an Intent ever names a protocol,
 * manufacturer, or driver — an Intent names WHAT the user means
 * (`ToggleLight`, `VolumeUp`, `IncreaseTemperature`), and the Intent & Capability
 * Engine (`@supreme/intent-engine`) resolves WHICH device(s) and WHICH concrete
 * `CapabilityCommand` satisfy it, at the moment it runs — never baked in ahead of
 * time. Replacing a KNX dimmer with a Casambi one changes nothing about a
 * `ToggleLight` mapping; only which driver the resolved command reaches changes.
 *
 * This module is pure schema/types (the existing domain-model convention); the
 * registry, resolution, and translation LOGIC live in the new `@supreme/
 * intent-engine` service, exactly like `CapabilityKind`/`CapabilityCommand` are
 * schema here while `SupremeIntegrationLayer` is the service that acts on them.
 */

export const IntentCategory = z.enum(["lighting", "climate", "av", "blinds", "security", "system"]);
export type IntentCategory = z.infer<typeof IntentCategory>;

/** What kind of thing an Intent can be pointed at. Deliberately NOT tied to a
 * single device id at the schema/definition level — resolution to a concrete
 * device (or set of devices) is the Capability Engine's job at run time. */
export const IntentTargetKind = z.enum(["device", "room", "scene", "automation", "home"]);
export type IntentTargetKind = z.infer<typeof IntentTargetKind>;

/** A concrete target for one Intent invocation — resolved to a real device (or
 * every matching device in a room) by the Capability Engine at run time. */
export const IntentTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), deviceId: DeviceId }),
  /** Every device in this room that supports the intent's required capability —
   * the "Movie Mode button dims every light in the room" case. */
  z.object({ kind: z.literal("room"), roomId: RoomId }),
  z.object({ kind: z.literal("scene"), sceneId: SceneId }),
  z.object({ kind: z.literal("automation"), automationId: AutomationId }),
  /** For home-scoped system intents with no device/room/scene/automation to name
   * (Arm/Disarm/Panic, Notification, …) — single-home-per-hub, so no id is
   * needed (mirrors `ctx.homeId` being implicit everywhere else in the gateway). */
  z.object({ kind: z.literal("home") }),
]);
export type IntentTarget = z.infer<typeof IntentTarget>;

export const IntentParameterType = z.enum(["number", "boolean", "string", "enum"]);
export type IntentParameterType = z.infer<typeof IntentParameterType>;

/** One named parameter an Intent accepts (e.g. `step` for `IncreaseBrightness`,
 * `mode` for `HVACMode`) — validated by the Capability Engine before translation,
 * never trusted blindly. */
export const IntentParameterSpec = z.object({
  key: z.string().min(1),
  type: IntentParameterType,
  required: z.boolean().default(false),
  /** Numeric bounds (type "number" only). */
  min: z.number().optional(),
  max: z.number().optional(),
  /** Allowed values (type "enum" only). */
  options: z.array(z.string()).optional(),
  /** Applied when the caller omits this parameter entirely. */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().default(""),
});
export type IntentParameterSpec = z.infer<typeof IntentParameterSpec>;

/**
 * The Intent Registry's unit of record. Pure, serializable metadata — safe to
 * ship over the wire (a future Universal Keypad Editor, an AI assistant, or a
 * marketplace template all consume exactly this shape) and safe to store in a
 * template file. The EXECUTABLE behavior (how to turn params + current state into
 * a `CapabilityCommand`) is intentionally NOT part of this schema — functions
 * aren't serializable — and instead lives server-side in `@supreme/intent-engine`'s
 * registry alongside this definition (see `IntentTranslator`).
 */
export const IntentDefinition = z.object({
  /** Stable id, e.g. "toggleLight". Never renamed once shipped — a mapping or
   * template stores this string verbatim. */
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, "expected a camelCase intent id"),
  name: z.string().min(1),
  category: IntentCategory,
  description: z.string().default(""),
  /** Capability kind(s) a target DEVICE must expose for this intent to apply.
   * Empty for system-level intents (RunScene, RunAutomation, Notification, …)
   * that don't address a capability at all. */
  requiredCapabilities: z.array(CapabilityKind).default([]),
  parameters: z.array(IntentParameterSpec).default([]),
  /** Which `IntentTarget.kind`s this intent accepts — e.g. `ToggleLight` only
   * accepts `device`/`room`; `RunScene` only accepts `scene`. */
  targetKinds: z.array(IntentTargetKind).min(1),
  /** Semver — additive changes bump minor, a breaking parameter change (never
   * done lightly) bumps major. Lets a future template/AI-generated mapping
   * assert compatibility instead of guessing. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/).default("1.0.0"),
  /** i18n key for a future localized name/description lookup; `null` = use
   * `name`/`description` verbatim (English-only today, ready for a translation
   * table keyed on this string without a schema change). */
  i18nKey: z.string().nullable().default(null),
});
export type IntentDefinition = z.infer<typeof IntentDefinition>;
