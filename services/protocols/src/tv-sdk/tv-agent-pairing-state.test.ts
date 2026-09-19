import { describe, expect, it } from "vitest";
import { isAgentUsable, requiresExplicitRepair, transitionAgentPairingState, type TvAgentPairingState } from "./tv-agent-pairing-state.js";

describe("tv-agent-pairing-state — §2 explicit pairing state machine", () => {
  it("follows the documented happy path: discovered -> pairing_required -> pairing -> authenticated -> connected", () => {
    let state: TvAgentPairingState = "discovered";
    for (const next of ["pairing_required", "pairing", "authenticated", "connected"] as const) {
      const result = transitionAgentPairingState(state, next);
      expect(result.ok).toBe(true);
      state = result.state;
    }
    expect(state).toBe("connected");
  });

  it("rejects an illegal transition (e.g. discovered straight to connected) without mutating state", () => {
    const result = transitionAgentPairingState("discovered", "connected");
    expect(result.ok).toBe(false);
    expect(result.state).toBe("discovered");
    expect(result.error).toMatch(/illegal pairing-state transition/);
  });

  it("§2 revocation: connected -> revoked is legal, but revoked cannot go straight back to connected/authenticated/pairing", () => {
    expect(transitionAgentPairingState("connected", "revoked").ok).toBe(true);
    expect(transitionAgentPairingState("revoked", "connected").ok).toBe(false);
    expect(transitionAgentPairingState("revoked", "authenticated").ok).toBe(false);
    expect(transitionAgentPairingState("revoked", "pairing").ok).toBe(false);
    // The ONLY legal way out is back through pairing_required (explicit re-pair).
    expect(transitionAgentPairingState("revoked", "pairing_required").ok).toBe(true);
  });

  it("a same-state transition is an idempotent no-op, not an error", () => {
    const result = transitionAgentPairingState("connected", "connected");
    expect(result.ok).toBe(true);
    expect(result.state).toBe("connected");
  });

  it("rejected and disabled also require explicit re-pairing, never an automatic path back", () => {
    expect(transitionAgentPairingState("rejected", "connected").ok).toBe(false);
    expect(transitionAgentPairingState("rejected", "pairing_required").ok).toBe(true);
    expect(transitionAgentPairingState("disabled", "connected").ok).toBe(false);
    expect(transitionAgentPairingState("disabled", "discovered").ok).toBe(true);
  });

  it("isAgentUsable is true only for 'connected' — 'authenticated' alone is not yet usable feedback", () => {
    expect(isAgentUsable("connected")).toBe(true);
    expect(isAgentUsable("authenticated")).toBe(false);
    expect(isAgentUsable("pairing")).toBe(false);
    expect(isAgentUsable("revoked")).toBe(false);
  });

  it("requiresExplicitRepair is true exactly for revoked/rejected/disabled", () => {
    expect(requiresExplicitRepair("revoked")).toBe(true);
    expect(requiresExplicitRepair("rejected")).toBe(true);
    expect(requiresExplicitRepair("disabled")).toBe(true);
    expect(requiresExplicitRepair("connected")).toBe(false);
    expect(requiresExplicitRepair("pairing")).toBe(false);
  });

  it("every state can reach 'disabled' (an installer can always disable an Agent)", () => {
    const allStates: TvAgentPairingState[] = ["unknown", "discovered", "pairing_required", "pairing", "authenticated", "connected", "revoked", "rejected", "disabled"];
    for (const s of allStates) {
      if (s === "disabled") continue;
      expect(transitionAgentPairingState(s, "disabled").ok, `${s} -> disabled`).toBe(true);
    }
  });
});
