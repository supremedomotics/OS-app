import { describe, expect, it } from "vitest";
import { ConsumptionEstimator } from "./consumption-estimator.js";

describe("ConsumptionEstimator", () => {
  it("accrues on-time energy and flushes a kWh sample per device", async () => {
    const recorded: { id: string; room: string | null; kwh: number }[] = [];
    let bulbOn = true;
    const est = new ConsumptionEstimator({
      getWatts: async () => ({ bulb: 60, heater: 2000 }),
      isOn: async (id) => (id === "bulb" ? bulbOn : true),
      roomOf: async () => "lr",
      record: async (id, room, kwh) => void recorded.push({ id, room, kwh }),
      flushEveryTicks: 60, // flush after an hour
    });

    for (let i = 0; i < 60; i++) await est.tick(); // one hour, both on
    // bulb: 60W for 60 min = 0.06 kWh; heater: 2000W for 60 min = 2 kWh.
    expect(recorded).toEqual(expect.arrayContaining([
      { id: "bulb", room: "lr", kwh: 0.06 },
      { id: "heater", room: "lr", kwh: 2 },
    ]));
  });

  it("only counts minutes a device is on", async () => {
    const recorded: { id: string; kwh: number }[] = [];
    let on = true;
    const est = new ConsumptionEstimator({
      getWatts: async () => ({ lamp: 60 }),
      isOn: async () => on,
      roomOf: async () => null,
      record: async (id, _r, kwh) => void recorded.push({ id, kwh }),
      flushEveryTicks: 10,
    });
    for (let i = 0; i < 5; i++) await est.tick(); // 5 min on
    on = false;
    for (let i = 0; i < 5; i++) await est.tick(); // 5 min off → flush at tick 10
    // 60W for 5 minutes = 0.005 kWh (rounded to 3 dp).
    expect(recorded).toEqual([{ id: "lamp", kwh: 0.005 }]);
  });

  it("records nothing when no devices have a wattage configured", async () => {
    const recorded: unknown[] = [];
    const est = new ConsumptionEstimator({ getWatts: async () => ({}), isOn: async () => true, roomOf: async () => null, record: async () => void recorded.push(1), flushEveryTicks: 1 });
    await est.tick();
    expect(recorded).toEqual([]);
  });
});
