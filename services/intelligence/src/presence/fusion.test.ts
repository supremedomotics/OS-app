import { describe, expect, it } from "vitest";
import { fusePresence, fuseUserPresence } from "./fusion.js";
import type { PresenceSignal } from "./sources.js";

const NOW = 1_000_000_000_000;
const sig = (over: Partial<PresenceSignal>): PresenceSignal => ({ source: "wifi_ap", userId: "u1", present: true, strength: 1, ts: NOW, roomId: null, ...over });

describe("fuseUserPresence", () => {
  it("fuses agreeing fresh signals into a high present confidence", () => {
    const e = fuseUserPresence("u1", [
      sig({ source: "mmwave", roomId: "room_lr", strength: 1 }),
      sig({ source: "wifi_ap", roomId: null, strength: 1 }),
      sig({ source: "app_heartbeat", roomId: null, strength: 1 }),
    ], { now: NOW });
    expect(e.status).toBe("present");
    expect(e.confidence).toBeGreaterThan(0.9);
    expect(e.roomId).toBe("room_lr"); // only the mmwave names a room
    expect(e.contributingSources[0]).toBe("mmwave"); // strongest weight first
  });

  it("picks the room with the greatest aggregate weight", () => {
    const e = fuseUserPresence("u1", [
      sig({ source: "pir", roomId: "room_kitchen", strength: 1 }), // weight 0.6
      sig({ source: "mmwave", roomId: "room_bed", strength: 1 }), //  weight 0.95
    ], { now: NOW });
    expect(e.roomId).toBe("room_bed");
  });

  it("decays stale signals so an old association can't keep you present", () => {
    const fresh = fuseUserPresence("u1", [sig({ present: true })], { now: NOW });
    expect(fresh.present).toBe(true);
    // Same lone signal, but 30 min old with a 5-min half-life → dropped past maxAge → no evidence.
    const stale = fuseUserPresence("u1", [sig({ present: true, ts: NOW - 31 * 60_000 })], { now: NOW });
    expect(stale.confidence).toBe(0);
    expect(stale.status).toBe("away");
  });

  it("weighs a strong absent sensor against a weak present one", () => {
    const e = fuseUserPresence("u1", [
      sig({ source: "uwb", present: false, strength: 1 }), //         weight 1.0 → absent
      sig({ source: "local_network", present: true, strength: 1 }), // weight 0.55 → present
    ], { now: NOW });
    // 0.55 / 1.55 ≈ 0.35 → between thresholds → uncertain, not present.
    expect(e.status).toBe("uncertain");
    expect(e.roomId).toBeNull();
  });
});

describe("fusePresence", () => {
  it("produces one estimate per user, most-confident first", () => {
    const out = fusePresence([
      sig({ userId: "u1", source: "mmwave", roomId: "room_a" }),
      sig({ userId: "u2", source: "local_network", present: true, strength: 0.5 }),
    ], { now: NOW });
    expect(out.map((e) => e.userId)).toEqual(["u1", "u2"]);
    expect(out[0]!.confidence).toBeGreaterThanOrEqual(out[1]!.confidence);
  });
});
