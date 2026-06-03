import { z } from "zod";

/**
 * The Supreme capability model.
 *
 * This is the heart of the abstraction guarantee (blueprint §7). Heterogeneous
 * backend domains — HA's `light`, `climate`, `cover`, `media_player`, `lock`, … —
 * are normalized into a small, stable set of Supreme *capabilities*. Clients issue
 * commands and read state purely in terms of these capabilities; the SIL is the
 * only layer that translates them to/from a concrete backend.
 *
 * A device advertises one or more capabilities. Each capability defines:
 *   - the shape of its reported STATE, and
 *   - the COMMANDS that can be issued against it.
 */

export const CapabilityKind = z.enum([
  "onoff", // generic power toggle
  "brightness", // dimmable level 0..100
  "color", // color light (hs + kelvin)
  "temperature", // climate setpoint(s) + ambient
  "position", // covers / blinds / awnings 0..100
  "media", // media player transport + volume
  "lock", // door lock / latch
  "sensor", // read-only measured value
]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

/** A 0..100 percentage, used for brightness and cover position. */
export const Percent = z.number().min(0).max(100);

// ── State shapes (what the device reports up through the SIL) ────────────────

export const OnOffState = z.object({ on: z.boolean() });

export const BrightnessState = z.object({
  on: z.boolean(),
  level: Percent,
});

export const ColorState = z.object({
  on: z.boolean(),
  level: Percent,
  /** Hue 0..360, saturation 0..100; null when in white/kelvin mode. */
  hue: z.number().min(0).max(360).nullable(),
  saturation: Percent.nullable(),
  /** Correlated color temperature in Kelvin; null when in color mode. */
  kelvin: z.number().int().min(1000).max(10000).nullable(),
});

export const TemperatureState = z.object({
  ambientC: z.number(),
  targetC: z.number().nullable(),
  /** Optional dual setpoints for heat/cool ranges. */
  targetLowC: z.number().nullable().optional(),
  targetHighC: z.number().nullable().optional(),
  mode: z.enum(["off", "heat", "cool", "auto", "fan_only"]),
  humidity: Percent.nullable().optional(),
});

export const PositionState = z.object({
  /** 0 = fully closed, 100 = fully open. */
  position: Percent,
  moving: z.boolean().default(false),
});

export const MediaState = z.object({
  playback: z.enum(["playing", "paused", "stopped", "idle"]),
  volume: Percent,
  muted: z.boolean(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  source: z.string().nullable(),
  artworkUrl: z.string().url().nullable(),
});

export const LockState = z.object({
  locked: z.boolean(),
  jammed: z.boolean().default(false),
});

export const SensorState = z.object({
  value: z.number(),
  unit: z.string(),
  /** e.g. "temperature" | "humidity" | "air_quality" | "power" … */
  measure: z.string(),
});

/** Discriminated union of all capability states, keyed by capability kind. */
export const CapabilityState = z.discriminatedUnion("kind", [
  OnOffState.extend({ kind: z.literal("onoff") }),
  BrightnessState.extend({ kind: z.literal("brightness") }),
  ColorState.extend({ kind: z.literal("color") }),
  TemperatureState.extend({ kind: z.literal("temperature") }),
  PositionState.extend({ kind: z.literal("position") }),
  MediaState.extend({ kind: z.literal("media") }),
  LockState.extend({ kind: z.literal("lock") }),
  SensorState.extend({ kind: z.literal("sensor") }),
]);
export type CapabilityState = z.infer<typeof CapabilityState>;

// ── Commands (what clients send down through the SIL) ────────────────────────

export const CapabilityCommand = z.discriminatedUnion("capability", [
  z.object({ capability: z.literal("onoff"), action: z.enum(["on", "off", "toggle"]) }),
  z.object({
    capability: z.literal("brightness"),
    action: z.enum(["set", "on", "off"]),
    level: Percent.optional(),
  }),
  z.object({
    capability: z.literal("color"),
    hue: z.number().min(0).max(360).optional(),
    saturation: Percent.optional(),
    kelvin: z.number().int().min(1000).max(10000).optional(),
    level: Percent.optional(),
  }),
  z.object({
    capability: z.literal("temperature"),
    targetC: z.number().optional(),
    targetLowC: z.number().optional(),
    targetHighC: z.number().optional(),
    mode: z.enum(["off", "heat", "cool", "auto", "fan_only"]).optional(),
  }),
  z.object({
    capability: z.literal("position"),
    action: z.enum(["open", "close", "stop", "set"]),
    position: Percent.optional(),
  }),
  z.object({
    capability: z.literal("media"),
    action: z.enum(["play", "pause", "stop", "next", "previous", "volume", "mute", "unmute"]),
    volume: Percent.optional(),
  }),
  z.object({ capability: z.literal("lock"), action: z.enum(["lock", "unlock"]) }),
]);
export type CapabilityCommand = z.infer<typeof CapabilityCommand>;

/** Capabilities that are read-only (cannot be commanded). */
export const READONLY_CAPABILITIES: readonly CapabilityKind[] = ["sensor"];
