import { newId, type DeviceId } from "@supreme/domain-model";
import { describe, expect, it } from "vitest";
import { HaAdapter, type HaTransport } from "./ha-adapter.js";
import { EntityRegistryMirror } from "../registry.js";

/**
 * Deterministic resilience tests for the HA adapter using a controllable fake
 * transport (no sockets): command buffering while disconnected → flush on connect,
 * discovery mapping, and state-event normalization. Complements the WS-server
 * integration test and the gated live-HA test.
 */
class FakeTransport implements HaTransport {
  opened = false;
  readonly sent: Record<string, unknown>[] = [];
  private handler: ((e: Record<string, unknown>) => void) | null = null;
  /** Toggles to simulate a dropped connection. */
  failClosed = false;

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  isOpen(): boolean {
    return this.opened && !this.failClosed;
  }
  onEvent(handler: (e: Record<string, unknown>) => void): void {
    this.handler = handler;
  }
  async send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.sent.push(message);
    if (message.type === "get_states") {
      return {
        result: [
          { entity_id: "light.kitchen", state: "on", attributes: { brightness: 255, friendly_name: "Kitchen" } },
          { entity_id: "sensor.unmapped", state: "5", attributes: {} },
        ],
      };
    }
    return { result: null };
  }
  /** Push a simulated HA state_changed event. */
  emit(entityId: string, state: string, attributes: Record<string, unknown>): void {
    this.handler?.({ event_type: "state_changed", data: { entity_id: entityId, new_state: { entity_id: entityId, state, attributes } } });
  }
}

function setup() {
  const transport = new FakeTransport();
  const registry = new EntityRegistryMirror();
  const adapter = new HaAdapter({ transport, registry });
  return { transport, registry, adapter };
}

describe("HaAdapter resilience", () => {
  it("buffers commands while disconnected and flushes them on connect", async () => {
    const { transport, registry, adapter } = setup();
    const dev = newId("device") as DeviceId;
    registry.map(dev, "brightness", { backendId: "light.kitchen", backendDomain: "light" });

    // Not connected yet → command is buffered, nothing sent.
    await adapter.command(dev, { capability: "brightness", action: "set", level: 60 });
    expect(transport.sent).toHaveLength(0);

    // Connect → buffer flushes as a real call_service.
    await adapter.connect();
    const calls = transport.sent.filter((m) => m.type === "call_service");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ domain: "light", service: "turn_on" });
  });

  it("discovers and maps backend entities to Supreme capabilities", async () => {
    const { adapter } = setup();
    await adapter.connect();
    const discovered = await adapter.discover();
    const light = discovered.find((d) => d.backendId === "light.kitchen");
    expect(light?.capabilities).toContain("brightness");
    expect(light?.suggestedName).toBe("Kitchen");
  });

  it("normalizes inbound state_changed events for mapped devices only", async () => {
    const { transport, registry, adapter } = setup();
    await adapter.connect();
    const dev = newId("device") as DeviceId;
    registry.map(dev, "brightness", { backendId: "light.kitchen", backendDomain: "light" });

    const events: unknown[] = [];
    adapter.onState((e) => events.push(e));

    transport.emit("light.kitchen", "on", { brightness: 128 }); // mapped → forwarded
    transport.emit("light.unmapped", "on", { brightness: 255 }); // unmapped → ignored

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ deviceId: dev, capability: "brightness" });
  });

  it("re-buffers commands when the socket has dropped, then flushes on reconnect", async () => {
    const { transport, registry, adapter } = setup();
    const dev = newId("device") as DeviceId;
    registry.map(dev, "onoff", { backendId: "switch.fan", backendDomain: "switch" });
    await adapter.connect();

    // Simulate a dropped connection: isOpen() now false → command buffers.
    transport.failClosed = true;
    expect(adapter.isConnected()).toBe(false);
    await adapter.command(dev, { capability: "onoff", action: "on" });
    const before = transport.sent.filter((m) => m.type === "call_service").length;

    // Reconnect → buffered command flushes.
    transport.failClosed = false;
    await adapter.connect();
    const after = transport.sent.filter((m) => m.type === "call_service").length;
    expect(after).toBe(before + 1);
  });
});
