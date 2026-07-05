import { describe, expect, it } from "vitest";
import { VoiceService, type SupremeDeviceView } from "./index.js";

const light: SupremeDeviceView = { deviceId: "dev-light", name: "Ceiling Light", capabilities: ["onoff", "brightness", "color"] };
const blind: SupremeDeviceView = { deviceId: "dev-blind", name: "Living Blind", capabilities: ["position"] };

describe("VoiceService — account linking", () => {
  it("links and resolves an assistant account to a Supreme account+home", () => {
    const v = new VoiceService();
    v.link({ assistant: "alexa", externalUserRef: "amzn-123", accountId: "acct-1", homeId: "home-1" });
    expect(v.resolve("alexa", "amzn-123")).toMatchObject({ accountId: "acct-1", homeId: "home-1" });
    expect(v.resolve("google", "amzn-123")).toBeUndefined(); // isolated per assistant
  });

  it("unlinks", () => {
    const v = new VoiceService();
    v.link({ assistant: "google", externalUserRef: "g-1", accountId: "a", homeId: "h" });
    v.unlink("google", "g-1");
    expect(v.resolve("google", "g-1")).toBeUndefined();
  });
});

describe("VoiceService — discovery mapping (one model → all ecosystems)", () => {
  it("projects capabilities into Alexa interfaces", () => {
    const d = new VoiceService().discovery("alexa", light);
    expect(d.descriptors).toContain("Alexa.PowerController");
    expect(d.descriptors).toContain("Alexa.BrightnessController");
    expect(d.descriptors).toContain("Alexa.ColorController");
  });

  it("projects capabilities into Google traits", () => {
    const d = new VoiceService().discovery("google", light);
    expect(d.descriptors).toContain("action.devices.traits.OnOff");
    expect(d.descriptors).toContain("action.devices.traits.Brightness");
  });

  it("projects a cover into HomeKit WindowCovering", () => {
    expect(new VoiceService().discovery("homekit", blind).descriptors).toEqual(["WindowCovering"]);
  });
});

describe("VoiceService — directive → Supreme command", () => {
  const v = new VoiceService();
  it("maps power directives to onoff", () => {
    expect(v.directiveToCommand({ deviceId: "d", intent: "TurnOn" })).toEqual({ deviceId: "d", capability: "onoff", value: true });
    expect(v.directiveToCommand({ deviceId: "d", intent: "TurnOff" }).value).toBe(false);
  });
  it("clamps brightness/position to 0–100", () => {
    expect(v.directiveToCommand({ deviceId: "d", intent: "SetBrightness", arg: 140 }).value).toBe(100);
    expect(v.directiveToCommand({ deviceId: "d", intent: "SetPosition", arg: -5 }).value).toBe(0);
  });
  it("maps lock/unlock", () => {
    expect(v.directiveToCommand({ deviceId: "d", intent: "Lock" }).value).toBe(true);
    expect(v.directiveToCommand({ deviceId: "d", intent: "Unlock" }).value).toBe(false);
  });
  it("throws on an unsupported directive", () => {
    expect(() => v.directiveToCommand({ deviceId: "d", intent: "Teleport" })).toThrow(/unsupported/);
  });
});

describe("VoiceService — state reporting", () => {
  it("projects a state change into an assistant report", () => {
    const r = new VoiceService().stateToReport("google", { deviceId: "dev-light", capability: "brightness", value: 60 });
    expect(r).toMatchObject({ assistant: "google", endpointId: "dev-light", descriptor: "action.devices.traits.Brightness", value: 60 });
  });
});
