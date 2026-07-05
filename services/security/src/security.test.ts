import { newId, type HomeId, type UserId } from "@supreme/domain-model";
import { describe, expect, it, vi } from "vitest";
import { SecurityService } from "./index.js";

const homeId = newId("home") as HomeId;
const user = newId("user") as UserId;

describe("SecurityService", () => {
  it("starts disarmed and arms/disarms with change notifications", () => {
    const onChange = vi.fn();
    const sec = new SecurityService({ onChange });
    expect(sec.getState(homeId).mode).toBe("disarmed");

    const armed = sec.arm(homeId, "armed_away", user);
    expect(armed.mode).toBe("armed_away");
    expect(onChange).toHaveBeenCalledTimes(1);

    const disarmed = sec.disarm(homeId, user);
    expect(disarmed.mode).toBe("disarmed");
  });

  it("only triggers while armed and disarm clears it", () => {
    const sec = new SecurityService();
    expect(sec.trigger(homeId).triggered).toBe(false); // disarmed → no-op
    sec.arm(homeId, "armed_night", user);
    expect(sec.trigger(homeId).triggered).toBe(true);
    expect(sec.disarm(homeId, user).triggered).toBe(false);
  });

  it("enforces the PIN when configured", () => {
    const sec = new SecurityService({ pin: "1357" });
    expect(() => sec.arm(homeId, "armed_home", user, "0000")).toThrow(/incorrect security PIN/);
    expect(sec.arm(homeId, "armed_home", user, "1357").mode).toBe("armed_home");
  });
});
