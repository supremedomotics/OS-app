import { describe, expect, it } from "vitest";
import type { PresenceEstimate } from "../presence/fusion.js";
import type { HouseOccupancy } from "../zones.js";
import { type EnergyDeviceInput, type EnergyIntelInput, evaluateDevice, evaluateEnergyIntelligence } from "./decision.js";

const NOW = 1_000_000_000_000;

const present = (userId: string, roomId: string | null, confidence = 0.95): PresenceEstimate => ({ userId, status: "present", present: true, confidence, roomId, contributingSources: [], ts: NOW });
const away = (userId: string): PresenceEstimate => ({ userId, status: "away", present: false, confidence: 0.05, roomId: null, contributingSources: [], ts: NOW });

const house = (zones: { zoneId: string; occupants: string[] }[], present: string[]): HouseOccupancy => ({
  present,
  occupied: present.length > 0,
  vacantForMs: 0,
  arrived: [],
  departed: [],
  zones: zones.map((z) => ({ zoneId: z.zoneId, name: z.zoneId, occupants: z.occupants, occupied: z.occupants.length > 0, vacantForMs: 0, arrived: [], departed: [] })),
});

const fan = (over: Partial<EnergyDeviceInput> = {}): EnergyDeviceInput => ({
  deviceId: "dev_fan",
  name: "Living Room Fan",
  roomId: "room_lr",
  zoneId: "z_ground",
  on: true,
  onSinceMs: NOW - 32 * 60_000,
  watts: 75,
  intel: { ownerUserId: "usr_mujeeb" },
  ...over,
});

const input = (over: Partial<EnergyIntelInput> = {}): EnergyIntelInput => ({
  now: NOW,
  devices: [fan()],
  presence: [away("usr_mujeeb")],
  house: house([{ zoneId: "z_ground", occupants: [] }], []),
  ratePerKwh: 8,
  currency: "INR",
  ...over,
});

describe("evaluateDevice", () => {
  it("flags a forgotten device in a vacant room with its owner away", () => {
    const ev = evaluateDevice(fan(), input());
    expect(ev.candidate).toBe(true);
    expect(ev.confidence.roomVacancy).toBe(1);
    expect(ev.confidence.ownership).toBeCloseTo(0.95, 2); // 1 - away confidence 0.05
    expect(ev.confidence.decision).toBeCloseTo(0.95, 2); // weakest link = ownership
    expect(ev.onMinutes).toBe(32);
    expect(ev.estimatedWatts).toBe(75);
    expect(ev.estimatedCost).toBeCloseTo((75 / 1000) * (32 / 60) * 8, 2); // ≈ 0.32 INR so far
  });

  it("never flags when the owner is in the same room", () => {
    const ev = evaluateDevice(fan(), input({ presence: [present("usr_mujeeb", "room_lr", 0.98)], house: house([{ zoneId: "z_ground", occupants: ["usr_mujeeb"] }], ["usr_mujeeb"]) }));
    expect(ev.candidate).toBe(false);
    expect(ev.skipReason).toBe("area_occupied");
    expect(ev.confidence.roomVacancy).toBeCloseTo(0.02, 2);
  });

  it("respects critical / ignoreAutoPilot / expectedAlwaysOn", () => {
    expect(evaluateDevice(fan({ intel: { critical: true } }), input()).skipReason).toBe("critical");
    expect(evaluateDevice(fan({ intel: { ignoreAutoPilot: true } }), input()).skipReason).toBe("ignored");
    expect(evaluateDevice(fan({ intel: { expectedAlwaysOn: true } }), input()).skipReason).toBe("expected_always_on");
  });

  it("waits out a recently-switched-on device and skips unknown wattage", () => {
    expect(evaluateDevice(fan({ onSinceMs: NOW - 5 * 60_000 }), input()).skipReason).toBe("recently_on");
    expect(evaluateDevice(fan({ watts: undefined, intel: { ownerUserId: "usr_mujeeb" } }), input()).skipReason).toBe("no_wattage");
  });

  it("prefers DeviceIntel.estimatedWatts over the live watts", () => {
    const ev = evaluateDevice(fan({ watts: undefined, intel: { ownerUserId: "usr_mujeeb", estimatedWatts: 60 } }), input());
    expect(ev.estimatedWatts).toBe(60);
    expect(ev.candidate).toBe(true);
  });
});

describe("evaluateEnergyIntelligence", () => {
  it("emits one observation per device and a suggestion per candidate", () => {
    const out = evaluateEnergyIntelligence(input());
    expect(out.observations).toHaveLength(1);
    expect(out.suggestions).toHaveLength(1);
    const s = out.suggestions[0]!;
    expect(s.key).toBe("energy:idle:dev_fan");
    expect(s.deviceId).toBe("dev_fan");
    expect(s.ownerUserId).toBe("usr_mujeeb");
    expect(s.actions).toEqual(["turn_off", "keep_on", "ignore_today", "always_ignore", "enable_auto_pilot"]);
    expect(s.estimatedWatts).toBe(75);
    expect(s.currency).toBe("INR");
    expect(s.body).toContain("32 min");
  });

  it("produces no suggestion when nothing is a candidate", () => {
    const out = evaluateEnergyIntelligence(input({ devices: [fan({ intel: { critical: true } })] }));
    expect(out.suggestions).toHaveLength(0);
    expect(out.observations).toHaveLength(1);
  });
});
