import { describe, expect, it } from "vitest";
import { SupremeError } from "@supreme/contracts";
import type { CapabilityCommand, CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import type { ProposedCommand } from "@supreme/ai";
import { AureonActionEngine } from "./action-engine.js";

/** Minimal fake SIL: an in-memory state map, with per-device error injection. */
class FakeSil {
  states = new Map<string, CapabilityState>();
  throwOnCommand = new Map<string, unknown>();
  throwOnGetStateAfterCommand = new Set<string>();
  private commanded = new Set<string>();

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (this.throwOnCommand.has(deviceId)) throw this.throwOnCommand.get(deviceId);
    this.commanded.add(deviceId);
    const key = deviceId;
    if (command.capability === "onoff") {
      this.states.set(key, { kind: "onoff", on: command.action === "on" });
    } else if (command.capability === "brightness") {
      const on = command.action !== "off";
      this.states.set(key, { kind: "brightness", on, level: command.level ?? 0 });
    } else if (command.capability === "lock") {
      this.states.set(key, { kind: "lock", locked: command.action === "lock", jammed: false });
    } else if (command.capability === "position") {
      const position = command.action === "open" ? 100 : command.action === "close" ? 0 : command.position ?? 50;
      this.states.set(key, { kind: "position", position, moving: false });
    }
  }

  async getState(deviceId: DeviceId, _capability: CapabilityKind): Promise<CapabilityState | null> {
    if (this.commanded.has(deviceId) && this.throwOnGetStateAfterCommand.has(deviceId)) {
      throw new Error("state unavailable");
    }
    return this.states.get(deviceId) ?? null;
  }
}

function proposed(deviceId: string, command: CapabilityCommand): ProposedCommand {
  return { deviceId, deviceName: deviceId, command };
}

describe("AureonActionEngine — verification never assumes success", () => {
  it("classifies a matching post-state as verified_success", async () => {
    const sil = new FakeSil();
    sil.states.set("dev_light", { kind: "onoff", on: false });
    const engine = new AureonActionEngine(sil, null, 0);
    const tx = await engine.execute({
      homeId: "home_x" as never,
      userId: "usr_x" as never,
      utterance: "turn on the light",
      riskLevel: 1,
      commands: [proposed("dev_light", { capability: "onoff", action: "on" })],
    });
    expect(tx.entries[0]!.status).toBe("verified_success");
    expect(tx.status).toBe("completed");
  });

  it("classifies a non-matching post-state as verified_failure, never success", async () => {
    const sil = new FakeSil();
    // Device reports itself stuck off despite the command — e.g. a jammed relay.
    sil.states.set("dev_light", { kind: "onoff", on: false });
    sil.command = async () => undefined; // dispatch "succeeds" but state never actually changes
    const engine = new AureonActionEngine(sil, null, 0);
    const tx = await engine.execute({
      homeId: "home_x" as never,
      userId: "usr_x" as never,
      utterance: "turn on the light",
      riskLevel: 1,
      commands: [proposed("dev_light", { capability: "onoff", action: "on" })],
    });
    expect(tx.entries[0]!.status).toBe("verified_failure");
    expect(tx.status).toBe("failed");
  });

  it("reports unverified when post-state can't be read, never claims success", async () => {
    const sil = new FakeSil();
    sil.states.set("dev_light", { kind: "onoff", on: false });
    sil.throwOnGetStateAfterCommand.add("dev_light");
    const engine = new AureonActionEngine(sil, null, 0);
    const tx = await engine.execute({
      homeId: "home_x" as never,
      userId: "usr_x" as never,
      utterance: "turn on the light",
      riskLevel: 1,
      commands: [proposed("dev_light", { capability: "onoff", action: "on" })],
    });
    expect(tx.entries[0]!.status).toBe("unverified");
  });

  it("maps a backend_unavailable dispatch error to timeout, not a fabricated success", async () => {
    const sil = new FakeSil();
    sil.throwOnCommand.set("dev_light", new SupremeError("backend_unavailable", "offline"));
    const engine = new AureonActionEngine(sil, null, 0);
    const tx = await engine.execute({
      homeId: "home_x" as never,
      userId: "usr_x" as never,
      utterance: "turn on the light",
      riskLevel: 1,
      commands: [proposed("dev_light", { capability: "onoff", action: "on" })],
    });
    expect(tx.entries[0]!.status).toBe("timeout");
    expect(tx.entries[0]!.error).toContain("offline");
  });

  it("honestly reports partial success across a multi-device plan (the brief's '47 off, 2 unavailable' case)", async () => {
    const sil = new FakeSil();
    sil.states.set("dev_a", { kind: "onoff", on: true });
    sil.states.set("dev_b", { kind: "onoff", on: true });
    sil.throwOnCommand.set("dev_b", new Error("unreachable"));
    const engine = new AureonActionEngine(sil, null, 0);
    const tx = await engine.execute({
      homeId: "home_x" as never,
      userId: "usr_x" as never,
      utterance: "turn off all lights",
      riskLevel: 1,
      commands: [
        proposed("dev_a", { capability: "onoff", action: "off" }),
        proposed("dev_b", { capability: "onoff", action: "off" }),
      ],
    });
    expect(tx.status).toBe("partially_failed");
    expect(tx.entries.map((e) => e.status)).toEqual(["verified_success", "verified_failure"]);
  });

  it("undo replays the captured priorState, not a guessed inverse command", async () => {
    const sil = new FakeSil();
    sil.states.set("dev_light", { kind: "brightness", on: true, level: 80 });
    const engine = new AureonActionEngine(sil, null, 0);
    const original = await engine.execute({
      homeId: "home_x" as never,
      userId: "usr_x" as never,
      utterance: "dim the light",
      riskLevel: 1,
      commands: [proposed("dev_light", { capability: "brightness", action: "set", level: 20 })],
    });
    expect(original.entries[0]!.status).toBe("verified_success");
    expect(original.entries[0]!.priorState).toEqual({ kind: "brightness", on: true, level: 80 });

    const undone = await engine.undo(original, "usr_x" as never);
    expect(undone.undoOf).toBe(original.id);
    expect(undone.entries[0]!.command).toEqual({ capability: "brightness", action: "set", level: 80 });
    expect(undone.entries[0]!.status).toBe("verified_success");
  });

  it("marks undo as not_supported for capabilities with no safe state→command reconstruction, rather than guessing", async () => {
    const sil = new FakeSil();
    sil.states.set("dev_ac", { kind: "temperature", ambientC: 24, targetC: 22, mode: "cool" });
    sil.command = async () => undefined;
    sil.getState = async () => ({ kind: "temperature", ambientC: 24, targetC: 22, mode: "cool" });
    const engine = new AureonActionEngine(sil, null, 0);
    const original = await engine.execute({
      homeId: "home_x" as never,
      userId: "usr_x" as never,
      utterance: "set the AC to 22",
      riskLevel: 1,
      commands: [proposed("dev_ac", { capability: "temperature", targetC: 22 })],
    });
    const undone = await engine.undo(original, "usr_x" as never);
    expect(undone.entries.some((e) => e.status === "not_supported")).toBe(true);
  });
});
