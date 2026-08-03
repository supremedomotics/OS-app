import { describe, expect, it, vi } from "vitest";
import { DriverBindingEngine, type DriverHost } from "./driver-binding-engine.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { DeviceId } from "@supreme/domain-model";
import type { INativeProtocolDriver, ProtocolBinding } from "./protocols/driver.js";

function fakeDriver(protocol: string, connected = true): INativeProtocolDriver {
  return {
    protocol,
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => connected,
    bind: vi.fn(),
    manages: () => true,
    command: vi.fn(),
    getState: () => null,
    discover: vi.fn().mockResolvedValue([]),
    onState: () => () => {},
  };
}

function fakeBinding(deviceId: DeviceId): ProtocolBinding {
  return { deviceId, capability: "onoff", address: "1/1/1" };
}

describe("DriverBindingEngine", () => {
  it("bind() takes a device from UNBOUND to ONLINE via BINDING/BOUND", async () => {
    const registry = new ProviderRegistry();
    const driver = fakeDriver("knx");
    const host: DriverHost = { bind: vi.fn(), driverFor: () => driver };
    const engine = new DriverBindingEngine(host, registry);
    const binding = fakeBinding("d1" as DeviceId);

    await engine.bind(binding, "knx");

    expect(host.bind).toHaveBeenCalledWith(binding, "knx");
    expect(registry.get(binding.deviceId)?.state).toBe("ONLINE");
  });

  it("bind() failure leaves the device in ERROR, not silently UNBOUND", async () => {
    const registry = new ProviderRegistry();
    const host: DriverHost = { bind: vi.fn().mockRejectedValue(new Error("nope")), driverFor: () => null };
    const engine = new DriverBindingEngine(host, registry);
    const binding = fakeBinding("d1" as DeviceId);

    await expect(engine.bind(binding, "knx")).rejects.toThrow("nope");
    expect(registry.get(binding.deviceId)?.state).toBe("ERROR");
  });

  it("unbind() is idempotent for a device never bound", async () => {
    const registry = new ProviderRegistry();
    const host: DriverHost = { bind: vi.fn(), driverFor: () => null };
    const engine = new DriverBindingEngine(host, registry);
    await expect(engine.unbind("ghost" as DeviceId)).resolves.toBeUndefined();
  });

  it("unbind() releases host resources and returns UNBOUND", async () => {
    const registry = new ProviderRegistry();
    const driver = fakeDriver("knx");
    const hostUnbind = vi.fn();
    const host: DriverHost = { bind: vi.fn(), unbindDevice: hostUnbind, driverFor: () => driver };
    const engine = new DriverBindingEngine(host, registry);
    const binding = fakeBinding("d1" as DeviceId);

    await engine.bind(binding, "knx");
    await engine.unbind(binding.deviceId);

    expect(hostUnbind).toHaveBeenCalledWith(binding.deviceId);
    expect(registry.get(binding.deviceId)?.state).toBe("UNBOUND");
  });

  it("rebind() unbinds then binds again", async () => {
    const registry = new ProviderRegistry();
    const driver = fakeDriver("knx");
    const host: DriverHost = { bind: vi.fn(), unbindDevice: vi.fn(), driverFor: () => driver };
    const engine = new DriverBindingEngine(host, registry);
    const binding = fakeBinding("d1" as DeviceId);

    await engine.bind(binding, "knx");
    await engine.rebind(binding, "knx");

    expect(host.bind).toHaveBeenCalledTimes(2);
    expect(registry.get(binding.deviceId)?.state).toBe("ONLINE");
  });

  it("validate() reports a missing driver honestly", () => {
    const registry = new ProviderRegistry();
    const host: DriverHost = { bind: vi.fn(), driverFor: () => null };
    const engine = new DriverBindingEngine(host, registry);
    registry.assign("d1" as DeviceId, "knx");
    expect(engine.validate("d1" as DeviceId)).toEqual({ valid: false, reason: '"knx" has no driver configured on this hub' });
  });

  it("health() never fabricates connection for UNBOUND devices", () => {
    const registry = new ProviderRegistry();
    const host: DriverHost = { bind: vi.fn(), driverFor: () => null };
    const engine = new DriverBindingEngine(host, registry);
    expect(engine.health("never-seen" as DeviceId)).toEqual({ bound: false, connected: false, error: null });
  });

  it("health() reflects real driver connection state once bound", async () => {
    const registry = new ProviderRegistry();
    const driver = fakeDriver("knx", false);
    const host: DriverHost = { bind: vi.fn(), driverFor: () => driver };
    const engine = new DriverBindingEngine(host, registry);
    const binding = fakeBinding("d1" as DeviceId);
    await engine.bind(binding, "knx");
    expect(engine.health(binding.deviceId)).toEqual({ bound: true, connected: false, error: null });
  });

  it("recover() rebinds onto the device's already-recorded provider", async () => {
    const registry = new ProviderRegistry();
    const driver = fakeDriver("knx");
    const host: DriverHost = { bind: vi.fn(), unbindDevice: vi.fn(), driverFor: () => driver };
    const engine = new DriverBindingEngine(host, registry);
    const binding = fakeBinding("d1" as DeviceId);
    await engine.bind(binding, "knx");
    await engine.recover(binding);
    expect(host.bind).toHaveBeenLastCalledWith(binding, "knx");
  });
});
