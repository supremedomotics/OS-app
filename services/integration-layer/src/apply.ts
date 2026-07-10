import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";

/**
 * Pure device-response model: given a capability's previous state and a Supreme
 * command, compute the resulting state. Shared by the in-process adapters (the
 * `MockAdapter` used in tests and the `SupremeNativeAdapter` native engine), so
 * both respond identically to commands.
 */
export function applyCommand(
  prev: CapabilityState | undefined,
  command: CapabilityCommand,
): CapabilityState | null {
  switch (command.capability) {
    case "onoff":
      return {
        kind: "onoff",
        on:
          command.action === "on"
            ? true
            : command.action === "off"
              ? false
              : !(prev as { on?: boolean })?.on,
      };
    case "brightness": {
      const level = command.level ?? (prev?.kind === "brightness" ? prev.level : 100);
      const on = command.action === "off" ? false : true;
      return { kind: "brightness", on, level };
    }
    case "color": {
      const base = prev?.kind === "color" ? prev : null;
      return {
        kind: "color",
        on: true,
        level: command.level ?? base?.level ?? 100,
        hue: command.hue ?? base?.hue ?? null,
        saturation: command.saturation ?? base?.saturation ?? null,
        kelvin: command.kelvin ?? base?.kelvin ?? null,
      };
    }
    case "position": {
      const position =
        command.position ??
        (command.action === "open"
          ? 100
          : command.action === "close"
            ? 0
            : prev?.kind === "position"
              ? prev.position
              : 0);
      return { kind: "position", position, moving: false };
    }
    case "lock":
      return { kind: "lock", locked: command.action === "lock", jammed: false };
    case "temperature": {
      const base = prev?.kind === "temperature" ? prev : null;
      return {
        kind: "temperature",
        ambientC: base?.ambientC ?? 21,
        targetC: command.targetC ?? base?.targetC ?? 21,
        mode: command.mode ?? base?.mode ?? "auto",
      };
    }
    case "media": {
      const base = prev?.kind === "media" ? prev : null;
      const playback =
        command.action === "play"
          ? "playing"
          : command.action === "pause"
            ? "paused"
            : command.action === "stop"
              ? "stopped"
              : base?.playback ?? "idle";
      return {
        kind: "media",
        playback,
        volume: command.volume ?? base?.volume ?? 30,
        muted: command.action === "mute" ? true : command.action === "unmute" ? false : base?.muted ?? false,
        title: base?.title ?? null,
        artist: base?.artist ?? null,
        source: command.action === "source" ? command.source ?? base?.source ?? null : base?.source ?? null,
        artworkUrl: base?.artworkUrl ?? null,
        durationSec: base?.durationSec ?? null,
        positionSec: command.action === "seek" ? command.positionSec ?? base?.positionSec ?? null : base?.positionSec ?? null,
        shuffle: command.action === "shuffle" ? command.shuffle ?? base?.shuffle ?? null : base?.shuffle ?? null,
        repeat: command.action === "repeat" ? command.repeat ?? base?.repeat ?? null : base?.repeat ?? null,
        advanced: command.action === "advanced" ? { ...base?.advanced, ...command.advanced } : base?.advanced ?? null,
      };
    }
    case "fan": {
      const base = prev?.kind === "fan" ? prev : null;
      return {
        kind: "fan",
        on: command.action === "on" ? true : command.action === "off" ? false : base?.on ?? true,
        preset: command.preset ?? base?.preset ?? "auto",
        direction: command.direction ?? base?.direction ?? "forward",
      };
    }
    case "vacuum": {
      const base = prev?.kind === "vacuum" ? prev : null;
      const status =
        command.action === "start"
          ? "cleaning"
          : command.action === "pause"
            ? "paused"
            : command.action === "stop"
              ? "idle"
              : command.action === "return"
                ? "returning"
                : base?.status ?? "idle";
      return { kind: "vacuum", status, fanSpeed: command.fanSpeed ?? base?.fanSpeed ?? "normal" };
    }
  }
}
