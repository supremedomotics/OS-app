import ModbusRTU from "modbus-serial";
import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModbusProtocolDriver } from "./modbus-driver.js";

/**
 * Drives the real Modbus TCP driver against an in-process Modbus server (a real
 * coil + holding-register store) — exercising actual Modbus framing end-to-end with
 * no hardware. Proves: writeCoil drives a relay (onoff), and polling a holding
 * register surfaces a scaled sensor reading as a Supreme capability event.
 */
const { ServerTCP } = ModbusRTU as unknown as {
  ServerTCP: new (vector: object, opts: { host: string; port: number; unitID: number }) => {
    close: (cb?: () => void) => void;
  };
};

describe("ModbusProtocolDriver (in-process Modbus server)", () => {
  // Backing store: one coil (relay) + one holding register (energy meter, 0.1 kWh/LSB).
  const coils: Record<number, boolean> = { 0: false };
  const holding: Record<number, number> = { 100: 2304 };
  let server: { close: (cb?: () => void) => void };
  let driver: ModbusProtocolDriver;
  let port = 0;

  beforeAll(async () => {
    port = 15020 + Math.floor(Math.random() * 1000);
    const vector = {
      getCoil: (addr: number) => coils[addr] ?? false,
      setCoil: (addr: number, value: boolean) => {
        coils[addr] = value;
      },
      getHoldingRegister: (addr: number) => holding[addr] ?? 0,
      getInputRegister: (addr: number) => holding[addr] ?? 0,
    };
    server = new ServerTCP(vector, { host: "127.0.0.1", port, unitID: 1 });
    await new Promise((r) => setTimeout(r, 150)); // let the server bind

    driver = new ModbusProtocolDriver({
      host: "127.0.0.1",
      port,
      pollMs: 1_000_000, // we drive poll() manually for determinism
    });
    await driver.connect();
  });
  afterAll(async () => {
    await driver.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("writes a coil for onoff and reads a scaled holding register as a sensor", async () => {
    const relay = "device-pump-1" as DeviceId;
    const meter = "device-meter-1" as DeviceId;
    await driver.bind({ deviceId: relay, capability: "onoff", address: "0", config: { type: "coil" } });
    await driver.bind({
      deviceId: meter,
      capability: "sensor",
      address: "100",
      config: { type: "holding", scale: 0.1, unit: "kWh", measure: "energy" },
    });

    const events: BackendStateEvent[] = [];
    driver.onState((e) => events.push(e));

    // Command the relay → the real coil flips on the server.
    await driver.command(relay, { capability: "onoff", action: "on" });
    expect(coils[0]).toBe(true);

    // Poll → the meter register (2304 * 0.1) surfaces as a sensor reading.
    await driver.poll();
    const sensor = events.find((e) => e.capability === "sensor");
    expect(sensor?.state).toEqual({ kind: "sensor", value: 230.4, unit: "kWh", measure: "energy" });
    expect(driver.getState(relay, "onoff")).toEqual({ kind: "onoff", on: true });

    // A second poll with no change emits no duplicate sensor event.
    const before = events.length;
    await driver.poll();
    expect(events.length).toBe(before);
  });
});
