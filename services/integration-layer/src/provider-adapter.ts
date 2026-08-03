import type { DeviceId } from "@supreme/domain-model";
import type { DiscoveredDevice } from "./adapter.js";

/**
 * Generic provider interface (ADR-0023). Every provider — Casambi, KNX, Matter, MQTT,
 * DALI, Modbus, Home Assistant, future drivers — implements exactly this and nothing
 * more. No provider-specific behavior lives outside this shape; the router and state
 * engine never branch on which provider a device came from.
 */
export interface ProviderAdapter {
  readonly id: string; // e.g. "casambi", "knx", "homeassistant"
  discover(): Promise<DiscoveredDevice[]>;
  bind(deviceId: DeviceId): Promise<void>;
  unbind(deviceId: DeviceId): Promise<void>;
  diagnostics(deviceId: DeviceId): Promise<ProviderDiagnostics | null>;
  metadata(): ProviderMetadata;
  health(): Promise<ProviderHealth>;
  events(listener: (event: ProviderEvent) => void): () => void;
}

export interface ProviderMetadata {
  id: string;
  displayName: string;
  version?: string;
}

export interface ProviderHealth {
  healthy: boolean;
  detail?: string;
}

export interface ProviderDiagnostics {
  deviceId: DeviceId;
  bound: boolean;
  connectionStatus: "connected" | "disconnected" | "unknown";
  lastEvent?: string;
  recoveryAttempts?: number;
}

export type ProviderEvent =
  | { type: "device-online"; deviceId: DeviceId }
  | { type: "device-offline"; deviceId: DeviceId }
  | { type: "device-error"; deviceId: DeviceId; detail: string };
