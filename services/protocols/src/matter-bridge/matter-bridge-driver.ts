import type { DeviceId } from "@supreme/domain-model";
import type { MatterBridgeCapabilityPort } from "./capability-port.js";
import type { MatterEndpointRegistry } from "./endpoint-registry.js";
import type { MatterBridgeServer } from "./server.js";

export interface MatterBridgeDriverOptions {
  server: MatterBridgeServer;
  registry: MatterEndpointRegistry;
  capabilities: MatterBridgeCapabilityPort;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * SupremeOS Universal Light ↔ Matter On/Off Light — the Phase 1 vertical slice
 * (§ Matter Bridge Phase 1). Owns exactly two responsibilities: routing a genuine Matter
 * command into `capabilities.command()`, and mirroring a genuine SupremeOS `onoff` state
 * change onto the Matter attribute. Nothing else — no persistence beyond the endpoint
 * registry, no Driver Manager plumbing (§ Scope boundary), no second device model.
 */
export class MatterBridgeDriver {
  private readonly server: MatterBridgeServer;
  private readonly registry: MatterEndpointRegistry;
  private readonly capabilities: MatterBridgeCapabilityPort;
  private readonly onLog: (level: "info" | "warn" | "error", message: string) => void;
  /** endpointNumber → deviceId, for routing an inbound Matter command back to a device. */
  private readonly exposedDevices = new Map<number, DeviceId>();
  /** deviceId → endpointNumber, the reverse index — a device only appears here once it has
   * actually been bridged via `exposeLight`/restart re-exposure, never allocated on demand
   * for an arbitrary state event (every device in the home emits `onState`, bridged or not). */
  private readonly endpointByDevice = new Map<DeviceId, number>();
  private unsubscribeCommand: (() => void) | null = null;
  private unsubscribeState: (() => void) | null = null;
  private started = false;

  constructor(opts: MatterBridgeDriverOptions) {
    this.server = opts.server;
    this.registry = opts.registry;
    this.capabilities = opts.capabilities;
    this.onLog = opts.onLog ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.started) return;
    // A genuine server startup failure (§ Recovery — "Matter server startup failure") is NOT
    // caught here: it must fail loud and leave `started` false, never a half-connected bridge.
    await this.server.start();
    // Re-expose every previously-bridged device at ITS ALREADY-ASSIGNED endpoint number —
    // this is what makes identity survive a restart (§ Endpoint architecture). Each mapping
    // is isolated: one device whose capability lookup throws (§ Recovery — "unavailable
    // SupremeOS capability during startup") or whose Matter re-add fails must not prevent
    // every OTHER already-working bridged device from coming back online. A failed mapping is
    // logged and left un-exposed for this run — its persisted endpoint number is untouched,
    // so it is retried at the SAME identity next start, never silently reissued.
    for (const mapping of this.registry.all()) {
      try {
        const state = this.capabilities.getState(mapping.deviceId, "onoff");
        await this.server.addOnOffLight({
          endpointNumber: mapping.endpointNumber,
          name: mapping.deviceId,
          initialOn: state?.kind === "onoff" ? state.on : false,
        });
        this.exposedDevices.set(mapping.endpointNumber, mapping.deviceId);
        this.endpointByDevice.set(mapping.deviceId, mapping.endpointNumber);
      } catch (err) {
        this.onLog(
          "error",
          `matter-bridge: failed to re-expose ${mapping.deviceId} at endpoint ${mapping.endpointNumber}: ` +
            `${(err as Error).message} — endpoint identity preserved, will retry next start`,
        );
      }
    }
    this.unsubscribeCommand = this.server.onCommand((endpointNumber, on) => {
      void this.handleMatterCommand(endpointNumber, on);
    });
    this.unsubscribeState = this.capabilities.onState((event) => {
      void this.handleSupremeStateChange(event.deviceId, event.capability, event.state);
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    this.unsubscribeCommand?.();
    this.unsubscribeState?.();
    this.unsubscribeCommand = null;
    this.unsubscribeState = null;
    await this.server.stop();
    this.started = false;
  }

  /** Bridge one more SupremeOS `onoff` device onto Matter as an On/Off Light endpoint.
   * Idempotent — calling twice for the same device reuses its existing endpoint. */
  async exposeLight(deviceId: DeviceId, name: string): Promise<void> {
    const mapping = this.registry.resolve(deviceId, "onOffLight");
    const state = this.capabilities.getState(deviceId, "onoff");
    await this.server.addOnOffLight({
      endpointNumber: mapping.endpointNumber,
      name,
      initialOn: state?.kind === "onoff" ? state.on : false,
    });
    this.exposedDevices.set(mapping.endpointNumber, deviceId);
    this.endpointByDevice.set(deviceId, mapping.endpointNumber);
    this.onLog("info", `matter-bridge: exposed ${deviceId} as endpoint ${mapping.endpointNumber} (${name})`);
  }

  /** Unbridge a device — removes the Matter endpoint but keeps the registry's endpoint-number
   * allocation (never reissued, §endpoint-registry.ts). */
  async removeLight(deviceId: DeviceId): Promise<void> {
    const endpointNumber = this.endpointByDevice.get(deviceId);
    if (endpointNumber === undefined) return;
    await this.server.removeEndpoint(endpointNumber);
    this.exposedDevices.delete(endpointNumber);
    this.endpointByDevice.delete(deviceId);
  }

  /** Matter ecosystem → SupremeOS (§1 required path, direction 1). A real ecosystem-issued
   * On/Off cluster command — never fabricated as a state report — routed through the SAME
   * command path the REST API/automations use, so the existing native driver executes it
   * against the physical device exactly as it would for any other caller. This function does
   * NOT assume success changed physical state: it does not write the Matter attribute itself;
   * that only happens when real feedback arrives via `handleSupremeStateChange` (§11: "Do not
   * fake feedback or assume successful command execution means the physical state changed"). */
  private async handleMatterCommand(endpointNumber: number, on: boolean): Promise<void> {
    const deviceId = this.exposedDevices.get(endpointNumber);
    if (!deviceId) {
      this.onLog("warn", `matter-bridge: command for unmapped endpoint ${endpointNumber}`);
      return;
    }
    try {
      await this.capabilities.command(deviceId, { capability: "onoff", action: on ? "on" : "off" });
    } catch (err) {
      this.onLog("error", `matter-bridge: command failed for ${deviceId}: ${(err as Error).message}`);
    }
  }

  /** Physical device / automation / any other source → SupremeOS → Matter (§1 required path,
   * direction 2, and §11's "physical changes"/"automation changes"/"local physical controls"
   * cases — all of them are just SupremeOS state events at this seam, so one handler covers
   * all three). Loop-safety: this only ever calls `setOnOffState` (an attribute write), never
   * `onCommand`'s handler — a real Matter attribute write does not re-enter the command path,
   * so there is no cycle to guard against structurally. The dedupe below is a cheap guard
   * against redundant no-op writes, not a correctness requirement. */
  private lastReported = new Map<number, boolean>();
  private async handleSupremeStateChange(
    deviceId: DeviceId,
    capability: string,
    state: { kind: string; on?: boolean } | null,
  ): Promise<void> {
    if (capability !== "onoff" || !state || state.kind !== "onoff" || typeof state.on !== "boolean") return;
    const endpointNumber = this.endpointByDevice.get(deviceId);
    if (endpointNumber === undefined) return; // not a bridged device — most devices aren't
    if (this.lastReported.get(endpointNumber) === state.on) return; // no real change
    this.lastReported.set(endpointNumber, state.on);
    await this.server.setOnOffState(endpointNumber, state.on);
  }
}
