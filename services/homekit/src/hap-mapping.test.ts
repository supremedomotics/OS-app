import { describe, expect, it } from "vitest";
import {
  characteristicsFromState,
  commandFromCharacteristic,
  hapServicesFor,
  kelvinToMired,
  miredToKelvin,
} from "./hap-mapping.js";

describe("HAP capability mapping", () => {
  it("projects capabilities to the right HAP services", () => {
    expect(hapServicesFor("onoff")[0]?.type).toBe("Switch");
    expect(hapServicesFor("brightness")[0]).toMatchObject({ type: "Lightbulb", characteristics: ["On", "Brightness"] });
    expect(hapServicesFor("lock")[0]?.type).toBe("LockMechanism");
    expect(hapServicesFor("position")[0]?.type).toBe("WindowCovering");
    expect(hapServicesFor("media")).toEqual([]); // no first-class HAP service yet
  });

  it("turns characteristic writes into Supreme commands", () => {
    expect(commandFromCharacteristic("On", true)).toEqual({ capability: "onoff", action: "on" });
    expect(commandFromCharacteristic("On", false)).toEqual({ capability: "onoff", action: "off" });
    expect(commandFromCharacteristic("Brightness", 73)).toEqual({ capability: "brightness", action: "set", level: 73 });
    // HAP lock: 1 = secured → lock, 0 = unsecured → unlock.
    expect(commandFromCharacteristic("LockTargetState", 1)).toEqual({ capability: "lock", action: "lock" });
    expect(commandFromCharacteristic("LockTargetState", 0)).toEqual({ capability: "lock", action: "unlock" });
    expect(commandFromCharacteristic("TargetPosition", 40)).toEqual({ capability: "position", action: "set", position: 40 });
    expect(commandFromCharacteristic("TargetTemperature", 21.5)).toEqual({ capability: "temperature", targetC: 21.5 });
    expect(commandFromCharacteristic("CurrentTemperature", 20)).toBeNull(); // read-only
  });

  it("clamps brightness/position into the HomeKit 0..100 range", () => {
    expect(commandFromCharacteristic("Brightness", 150)).toMatchObject({ level: 100 });
    expect(commandFromCharacteristic("TargetPosition", -5)).toMatchObject({ position: 0 });
  });

  it("converts color temperature between mireds and kelvin", () => {
    expect(miredToKelvin(370)).toBe(2703);
    expect(kelvinToMired(2700)).toBe(370);
    const cmd = commandFromCharacteristic("ColorTemperature", 370);
    expect(cmd).toMatchObject({ capability: "color", kelvin: 2703 });
  });

  it("projects Supreme state into HAP characteristics", () => {
    expect(characteristicsFromState("onoff", { on: true })).toEqual({ On: true });
    expect(characteristicsFromState("brightness", { on: true, level: 55 })).toEqual({ On: true, Brightness: 55 });
    expect(characteristicsFromState("lock", { locked: true })).toEqual({ LockCurrentState: 1, LockTargetState: 1 });
    expect(characteristicsFromState("position", { position: 30 })).toMatchObject({ CurrentPosition: 30, TargetPosition: 30 });
  });
});
