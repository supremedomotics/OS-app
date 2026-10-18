/**
 * Connects a {@link KnxHealthMonitor} to the native {@link KnxTunnelClient}: telegram stream in, tunnel state as path evidence, and a READ-ONLY bus
 * port out (GroupValueRead only). Nothing here can issue a write; the port type has no such method. Not wired to any production driver.
 */
import type { KnxTunnelClient } from "../native/tunnel-client.js";
import type { KnxHealthMonitor, ReadOnlyGroupBus } from "./health-monitor.js";

/** Reasons a closed tunnel says nothing about the KNX/IP gateway's reachability (we closed it, or the gateway answered and refused). */
const GATEWAY_UNREACHABLE_REASONS = new Set(["connect_timeout", "heartbeat_lost", "socket_error"]);

export function readOnlyBusFromTunnel(client: KnxTunnelClient, monitor: KnxHealthMonitor): ReadOnlyGroupBus {
  return {
    async readGroup(destination: number): Promise<void> {
      const receipt = await client.sendGroup({ destination, service: "read" });
      void receipt.confirmation.then((o) => monitor.noteSendOutcome(o));
    },
  };
}

/** Feeds telegrams and path state from the tunnel into the monitor. Returns a detach function. */
export function attachTunnelHealth(monitor: KnxHealthMonitor, client: KnxTunnelClient): () => void {
  const sync = (): void => {
    if (client.state === "connected") monitor.setPath({ gateway: "reachable", interface: "up" });
  };
  sync();
  const offTelegram = client.onTelegram((f) => {
    if (!f.destinationIsGroup || !f.group) return;
    monitor.observeTelegram({ source: f.source, destination: f.destination, service: f.group.service });
  });
  const offClosed = client.onClosed((e) => {
    monitor.setPath({ interface: "down", gateway: GATEWAY_UNREACHABLE_REASONS.has(e.reason) ? "unreachable" : "unknown" });
  });
  return () => { offTelegram(); offClosed(); };
}
