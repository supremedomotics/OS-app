import type {
  CoolMasterConnectionState,
  CoolMasterDiscoveryResult,
  CoolMasterUnitStatus,
} from "./coolmaster-types.js";

/**
 * Internal driver event bus — decoupled from Supreme's `StateListener` (which
 * coolmaster-driver.ts exposes at the INativeProtocolDriver boundary only, translating
 * these into Supreme CapabilityState events). Keeping this separate lets the discovery/
 * polling/connection layers stay ignorant of Supreme's capability model entirely.
 */
export type CoolMasterDriverEvent =
  | { type: "connection-state"; state: CoolMasterConnectionState }
  | { type: "unit-updated"; status: CoolMasterUnitStatus; previous: CoolMasterUnitStatus | null }
  | { type: "discovery-complete"; result: CoolMasterDiscoveryResult }
  | { type: "discovery-failed"; error: Error }
  | { type: "error"; error: Error; scope: string };

export type CoolMasterEventListener = (event: CoolMasterDriverEvent) => void;

export class CoolMasterEventBus {
  private readonly listeners = new Set<CoolMasterEventListener>();

  emit(event: CoolMasterDriverEvent): void {
    for (const l of this.listeners) l(event);
  }

  on(listener: CoolMasterEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
