import { newId, type DeviceId } from "@supreme/domain-model";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { HaAdapter } from "./ha-adapter.js";
import { HaWsTransport } from "./ha-ws-transport.js";
import { EntityRegistryMirror } from "../registry.js";
import { SupremeIntegrationLayer } from "../sil.js";

/**
 * Stands up a fake HA WebSocket server implementing the auth handshake, get_states,
 * call_service, and state_changed events — verifying the real transport + adapter
 * end-to-end through the SIL, with no live Home Assistant.
 */
function fakeHa(token: string) {
  const wss = new WebSocketServer({ port: 0 });
  const calls: Array<{ domain: string; service: string; data: unknown }> = [];

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "auth_required" }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth") {
        ws.send(JSON.stringify(msg.access_token === token ? { type: "auth_ok" } : { type: "auth_invalid", message: "nope" }));
      } else if (msg.type === "subscribe_events") {
        ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: null }));
      } else if (msg.type === "get_states") {
        ws.send(
          JSON.stringify({
            id: msg.id,
            type: "result",
            success: true,
            result: [
              { entity_id: "light.kitchen", state: "on", attributes: { brightness: 255, friendly_name: "Kitchen" } },
            ],
          }),
        );
      } else if (msg.type === "call_service") {
        calls.push({ domain: msg.domain, service: msg.service, data: msg.service_data });
        ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: null }));
        // Simulate the device reflecting the change via a state_changed event.
        ws.send(
          JSON.stringify({
            id: 0,
            type: "event",
            event: {
              event_type: "state_changed",
              data: {
                entity_id: "light.kitchen",
                new_state: { entity_id: "light.kitchen", state: "on", attributes: { brightness: 128 } },
              },
            },
          }),
        );
      }
    });
  });

  const port = (wss.address() as AddressInfo).port;
  return { wss, url: `ws://127.0.0.1:${port}`, calls };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("HaWsTransport + HaAdapter (against a fake HA)", () => {
  it("authenticates, commands, and normalizes a state_changed event through the SIL", async () => {
    const token = "test-llt";
    const ha = fakeHa(token);
    const registry = new EntityRegistryMirror();
    const transport = new HaWsTransport({ url: ha.url, token });
    const adapter = new HaAdapter({ transport, registry });
    const sil = new SupremeIntegrationLayer({ adapter, registry });
    cleanup = () => {
      void sil.stop();
      ha.wss.close();
    };

    await sil.start();
    expect(sil.isHealthy()).toBe(true);

    const deviceId = newId("device") as DeviceId;
    sil.mapEntity(deviceId, "brightness", { backendId: "light.kitchen", backendDomain: "light" });

    const events: unknown[] = [];
    sil.subscribe((e) => events.push(e));

    await sil.command(deviceId, { capability: "brightness", action: "set", level: 50 });

    // The fake HA received the mapped service call.
    expect(ha.calls[0]).toMatchObject({ domain: "light", service: "turn_on" });
    expect((ha.calls[0]!.data as { brightness_pct: number }).brightness_pct).toBe(50);

    // And the simulated state_changed was normalized and emitted (128/255 ≈ 50%).
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBeGreaterThan(0);

    const state = await sil.getState(deviceId, "brightness");
    expect(state).toEqual({ kind: "brightness", on: true, level: 100 });
  });

  it("rejects a bad token", async () => {
    const ha = fakeHa("right-token");
    const transport = new HaWsTransport({ url: ha.url, token: "wrong-token" });
    const adapter = new HaAdapter({ transport, registry: new EntityRegistryMirror() });
    const sil = new SupremeIntegrationLayer({ adapter });
    cleanup = () => ha.wss.close();
    await expect(sil.start()).rejects.toThrow(/auth failed/i);
  });
});
