import type { CapabilityCommand, CapabilityState, DeviceCapability, DeviceId } from "@supreme/domain-model";
import type { MatterBridgeCapabilityPort } from "./capability-port.js";
import type { MatterEndpointRegistry } from "./endpoint-registry.js";
import type { MatterBridgeServer } from "./server.js";
import { matterDeviceTypeRegistry, type MatterDeviceTypeRegistry } from "./device-types/matter-device-type-registry.js";
import { resolveMatterDeviceType, type MatterDeviceTypeResolution } from "./device-types/matter-device-type-resolver.js";
import type { MatterDeviceTypeDefinition } from "./device-types/matter-device-types.js";

export interface MatterBridgeDriverOptions {
  server: MatterBridgeServer;
  registry: MatterEndpointRegistry;
  capabilities: MatterBridgeCapabilityPort;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** Injectable for tests; production always uses the shared, spec-derived registry. */
  deviceTypeRegistry?: MatterDeviceTypeRegistry;
}

/**
 * SupremeOS Universal Entity ↔ Matter (§ Matter Bridge Phase 1 foundation). Routes a genuine
 * Matter command into `capabilities.command()`, and mirrors a genuine SupremeOS capability-state
 * change onto the Matter endpoint's attributes — for WHATEVER Matter Device Type the device
 * resolved to (`device-types/matter-device-type-resolver.ts`), not only On/Off Light as before
 * this Phase. Nothing else — no persistence beyond the endpoint registry, no Driver Manager
 * plumbing (§ Scope boundary), no second device model.
 */
export class MatterBridgeDriver {
  private readonly server: MatterBridgeServer;
  private readonly registry: MatterEndpointRegistry;
  private readonly capabilities: MatterBridgeCapabilityPort;
  private readonly onLog: (level: "info" | "warn" | "error", message: string) => void;
  private readonly deviceTypeRegistry: MatterDeviceTypeRegistry;
  /** endpointNumber → deviceId, for routing an inbound Matter command back to a device. */
  private readonly exposedDevices = new Map<number, DeviceId>();
  /** deviceId → endpointNumber, the reverse index — a device only appears here once it has
   * actually been bridged via `exposeDevice`/restart re-exposure, never allocated on demand
   * for an arbitrary state event (every device in the home emits `onState`, bridged or not). */
  private readonly endpointByDevice = new Map<DeviceId, number>();
  /** endpointNumber → the resolved device type, needed to know WHICH SupremeOS capability
   * drives an endpoint's state (`primaryCapability`) when a live `onState` event arrives. */
  private readonly deviceTypeByEndpoint = new Map<number, MatterDeviceTypeDefinition>();
  private unsubscribeCommand: (() => void) | null = null;
  private unsubscribeState: (() => void) | null = null;
  private started = false;

  constructor(opts: MatterBridgeDriverOptions) {
    this.server = opts.server;
    this.registry = opts.registry;
    this.capabilities = opts.capabilities;
    this.onLog = opts.onLog ?? (() => {});
    this.deviceTypeRegistry = opts.deviceTypeRegistry ?? matterDeviceTypeRegistry;
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
      const deviceType = this.deviceTypeRegistry.byId(mapping.deviceTypeId);
      if (!deviceType) {
        this.onLog(
          "error",
          `matter-bridge: endpoint ${mapping.endpointNumber} (device ${mapping.deviceId}) persists an ` +
            `unrecognized Matter Device Type id 0x${mapping.deviceTypeId.toString(16)} — skipped, endpoint ` +
            `identity preserved for a future SupremeOS version that recognizes it`,
        );
        continue;
      }
      try {
        const state = await this.capabilities.getState(mapping.deviceId, deviceType.primaryCapability);
        await this.server.addEndpoint({
          endpointNumber: mapping.endpointNumber,
          name: mapping.deviceId,
          deviceTypeId: deviceType.id,
          initialState: state,
        });
        this.exposedDevices.set(mapping.endpointNumber, mapping.deviceId);
        this.endpointByDevice.set(mapping.deviceId, mapping.endpointNumber);
        this.deviceTypeByEndpoint.set(mapping.endpointNumber, deviceType);
      } catch (err) {
        this.onLog(
          "error",
          `matter-bridge: failed to re-expose ${mapping.deviceId} at endpoint ${mapping.endpointNumber}: ` +
            `${(err as Error).message} — endpoint identity preserved, will retry next start`,
        );
      }
    }
    this.unsubscribeCommand = this.server.onCommand((endpointNumber, command) => {
      void this.handleMatterCommand(endpointNumber, command);
    });
    this.unsubscribeState = this.capabilities.onState((event) => {
      void this.handleSupremeStateChange(event.deviceId, event.capability, event.state);
    });

    // § Phase 5 §10 — "controlled commissioning logging": the ONLY place this driver ever
    // logs the pairing code, ONE line, ONLY while genuinely uncommissioned (never repeats
    // once paired). Replaces reliance on @matter/main's own uncontrolled NOTICE-level log
    // (suppressed in `real-server.ts` via the SDK's own public `Logger.facilityLevels` API —
    // no fork). This is a stopgap until a real, authenticated gateway route exists (§ Phase
    // 4's security review) — an operator with shell/journald access on the box is the
    // intended audience, same exposure boundary as before, now at least a single, clearly
    // labeled SupremeOS-owned line instead of raw SDK output repeated every boot.
    const commissioning = this.server.getCommissioningState();
    if (!commissioning.commissioned) {
      this.onLog(
        "warn",
        `matter-bridge: SENSITIVE — commissioning window open. Manual pairing code: ` +
          `${commissioning.pairing.manualPairingCode} — do not share this outside the ` +
          `installer commissioning this bridge.`,
      );
    }
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

  /**
   * Bridge one more SupremeOS device onto Matter, at whichever Matter Device Type its full
   * capability set actually justifies (§ Matter Bridge Phase 1 foundation — the fix for the
   * reported bug: this replaces the old onoff-only `exposeLight`, which silently skipped a
   * device unless it carried a bare `onoff` capability entry). Idempotent — calling twice for
   * the same device reuses its existing endpoint and device type.
   *
   * Returns the resolution outcome so the caller (`AppContext.exposeMatterDevices`) can log/
   * track an UNSUPPORTED device honestly instead of it just silently never appearing — the
   * driver itself never throws for "this device doesn't map to a Phase 1 device type," since
   * that is an expected, common outcome (a lock, a sensor, a thermostat), not an error.
   */
  async exposeDevice(deviceId: DeviceId, name: string, capabilities: DeviceCapability[]): Promise<MatterDeviceTypeResolution> {
    const resolution = resolveMatterDeviceType(capabilities, this.deviceTypeRegistry);
    if (resolution.outcome !== "SUPPORTED" || !resolution.deviceType) {
      return resolution;
    }
    const deviceType = resolution.deviceType;
    const mapping = this.registry.resolve(deviceId, deviceType.id);
    // The registry may return an EXISTING mapping whose deviceTypeId differs from what the
    // device resolves to right now (§ endpoint-registry.ts's `resolve` doc) — Phase 1 always
    // exposes using the PERSISTED device type, never silently re-typing an already-bridged
    // endpoint out from under a real ecosystem's cached view of it.
    const effectiveDeviceType = this.deviceTypeRegistry.byId(mapping.deviceTypeId) ?? deviceType;
    const state = await this.capabilities.getState(deviceId, effectiveDeviceType.primaryCapability);
    await this.server.addEndpoint({
      endpointNumber: mapping.endpointNumber,
      name,
      deviceTypeId: effectiveDeviceType.id,
      initialState: state,
    });
    this.exposedDevices.set(mapping.endpointNumber, deviceId);
    this.endpointByDevice.set(deviceId, mapping.endpointNumber);
    this.deviceTypeByEndpoint.set(mapping.endpointNumber, effectiveDeviceType);
    this.onLog(
      "info",
      `matter-bridge: exposed ${deviceId} as endpoint ${mapping.endpointNumber} (${name}) — ${effectiveDeviceType.name}`,
    );
    return { outcome: "SUPPORTED", deviceType: effectiveDeviceType, reason: null };
  }

  /** Unbridge a device LIVE — removes the real Matter endpoint (§ Matter Bridge Phase 1.1:
   * `server.removeEndpoint` calls the real `@matter/main` `Endpoint.delete()`, which detaches
   * it from the aggregator's `parts`, so the Descriptor cluster's PartsList — computed live
   * from that same collection, never hand-maintained — genuinely no longer lists it; this is
   * not a SupremeOS-side illusion of removal) but KEEPS the registry's endpoint-number
   * allocation (never reissued while the device still exists in SupremeOS, §endpoint-
   * registry.ts) — used for "device still exists but is currently unsupported" (e.g. a
   * capability changed), where the SAME endpoint identity should be reclaimed if it becomes
   * supported again. For "device no longer exists in SupremeOS at all," use
   * {@link forgetDevice} instead, which also frees the registry record. */
  async removeLight(deviceId: DeviceId): Promise<void> {
    const endpointNumber = this.endpointByDevice.get(deviceId);
    if (endpointNumber === undefined) return;
    await this.server.removeEndpoint(endpointNumber);
    this.exposedDevices.delete(endpointNumber);
    this.endpointByDevice.delete(deviceId);
    this.deviceTypeByEndpoint.delete(endpointNumber);
    this.lastReported.delete(endpointNumber);
  }

  /** § Matter Bridge Phase 1.1 — full removal for a SupremeOS device that no longer exists at
   * all (not merely unsupported): un-bridges the live endpoint (see {@link removeLight}) AND
   * frees its persisted endpoint-registry record. A genuinely deleted device must never keep
   * squatting on an endpoint number, and must never resurrect on the next restart (`start()`'s
   * re-expose loop only iterates `registry.all()` — once the record is gone, restart can never
   * bring it back). Idempotent: a no-op if the device was never bridged in the first place. */
  async forgetDevice(deviceId: DeviceId): Promise<void> {
    await this.removeLight(deviceId);
    this.registry.remove(deviceId);
  }

  /**
   * § Matter Bridge Phase 1.1 foundation — the lifecycle fix: "Refresh devices" (and every
   * boot) used to be additive-only (`exposeDevice` per current device, nothing else), so a
   * SupremeOS device deleted after being bridged stayed bridged FOREVER — its endpoint kept
   * appearing to every Matter controller with no SupremeOS device backing it. This is the one
   * place that now enforces the invariant "current accepted SupremeOS devices == current
   * Matter bridged endpoints" (except UNSUPPORTED, which is diagnostic-only, never silently
   * dropped either — see the returned `unsupported` list).
   *
   * `desired ∩ existing` → add/update via `exposeDevice` (idempotent, reuses the SAME endpoint
   * number — never rebuilds an unchanged endpoint). `desired - existing` → create. `existing -
   * desired` → {@link forgetDevice} (full removal, live endpoint + persisted record). A device
   * still present in `devices` but no longer resolving to a supported Matter type is
   * un-bridged LIVE via `removeLight` (its registry identity is preserved — it is not "gone
   * from SupremeOS", so a future capability change can reclaim the SAME endpoint number) and
   * reported in `unsupported`, never in `removed`.
   */
  async reconcile(
    devices: { id: DeviceId; name: string; capabilities: DeviceCapability[] }[],
  ): Promise<{
    added: DeviceId[];
    updated: DeviceId[];
    removed: DeviceId[];
    unsupported: { deviceId: DeviceId; reason: string }[];
    failed: { deviceId: DeviceId; error: string }[];
  }> {
    const desiredIds = new Set(devices.map((d) => d.id));
    const added: DeviceId[] = [];
    const updated: DeviceId[] = [];
    const removed: DeviceId[] = [];
    const unsupported: { deviceId: DeviceId; reason: string }[] = [];
    const failed: { deviceId: DeviceId; error: string }[] = [];

    // Isolated per device — one device's construction throwing (§ Recovery, a real bug found
    // live: this loop had no isolation once already, for the old onoff-only version) must
    // never block every other device from being added, updated, or removed in this same pass.
    for (const device of devices) {
      try {
        const wasExposed = this.endpointByDevice.has(device.id);
        const resolution = await this.exposeDevice(device.id, device.name, device.capabilities);
        if (resolution.outcome === "SUPPORTED") {
          (wasExposed ? updated : added).push(device.id);
        } else {
          unsupported.push({ deviceId: device.id, reason: resolution.reason ?? "unsupported" });
          if (wasExposed) {
            // Still a real SupremeOS device, just no longer resolvable — un-bridge live but
            // keep its identity, never forget it (§ distinguishing UNSUPPORTED from REMOVED).
            await this.removeLight(device.id);
            removed.push(device.id);
          }
        }
      } catch (err) {
        failed.push({ deviceId: device.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const deviceId of [...this.endpointByDevice.keys()]) {
      if (!desiredIds.has(deviceId)) {
        try {
          await this.forgetDevice(deviceId);
          removed.push(deviceId);
        } catch (err) {
          failed.push({ deviceId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return { added, updated, removed, unsupported, failed };
  }

  /** § Phase 4 §7 — read this node's real, live commissioning/fabric state. Pass-through to
   * the server; kept on the driver so a future gateway route never needs to reach past this
   * seam into the transport directly. */
  getCommissioningState() {
    return this.server.getCommissioningState();
  }

  /** § Extension Center — Bridged Devices page. Every SupremeOS device currently live on the
   * Matter side, by endpoint number — the driver's own real exposure index, not the registry
   * (`registry.all()` also lists a device that failed to re-expose after a restart; this
   * reflects only what a Matter controller can genuinely see right now). Names are resolved by
   * the caller (AppContext, which owns `home.listDevices()`) — this driver has no device-name
   * source of its own by design (§ Scope boundary, this file's own doc comment). Includes the
   * resolved Matter Device Type name/id (§ Phase 1 foundation — the diagnostics this
   * architecture makes possible: an installer can now see WHAT each bridged device claims to
   * be on the Matter side, not just that it's bridged). */
  listExposedDevices(): { deviceId: DeviceId; endpointNumber: number; deviceTypeId: number; deviceTypeName: string }[] {
    return [...this.exposedDevices.entries()]
      .map(([endpointNumber, deviceId]) => {
        const deviceType = this.deviceTypeByEndpoint.get(endpointNumber);
        return { deviceId, endpointNumber, deviceTypeId: deviceType?.id ?? 0, deviceTypeName: deviceType?.name ?? "Unknown" };
      })
      .sort((a, b) => a.endpointNumber - b.endpointNumber);
  }

  /** § Phase 4 §7 — DELIBERATE, DESTRUCTIVE: see `MatterBridgeServer.factoryReset`'s doc.
   * Nothing in `start()`/`stop()` calls this — a caller (a future explicit "Matter factory
   * reset" action, never a restart/upgrade/rollback) must invoke it on purpose. Clears this
   * driver's own in-memory exposure indexes too, since every endpoint the server just erased
   * no longer genuinely exists on the Matter side.
   *
   * § live-confirmed fix — `server.factoryReset()` leaves the underlying node undefined
   * (`RealMatterBridgeServer.factoryReset`'s own doc: "a caller wanting a fresh node calls
   * start() again"), but this method used to stop there: `this.started` stayed `true` and the
   * command/state subscriptions stayed live, so `start()`'s own `if (this.started) return`
   * guard made every future call a silent no-op. Every driver method touching the node
   * (`getCommissioningState`, `exposeDevice`, …) then threw "server not started" forever —
   * confirmed on a real deployment via `journalctl`, reproducing on every status/refresh
   * poll after one Factory Reset click. A factory reset button that permanently kills the
   * feature it resets is not "reset", so this now restarts immediately with a fresh Matter
   * identity — `start()` re-subscribes and re-exposes every already-registered device at its
   * SAME SupremeOS endpoint number (only the Matter-side fabric/pairing identity is new). */
  async factoryReset(): Promise<void> {
    this.unsubscribeCommand?.();
    this.unsubscribeState?.();
    this.unsubscribeCommand = null;
    this.unsubscribeState = null;
    await this.server.factoryReset();
    this.exposedDevices.clear();
    this.endpointByDevice.clear();
    this.deviceTypeByEndpoint.clear();
    this.lastReported.clear();
    this.started = false;
    await this.start();
  }

  /** Matter ecosystem → SupremeOS (§1 required path, direction 1). A real ecosystem-issued
   * cluster command — never fabricated as a state report — routed through the SAME command
   * path the REST API/automations use, so the existing native driver executes it against the
   * physical device exactly as it would for any other caller. This function does NOT assume
   * success changed physical state: it does not write the Matter attribute itself; that only
   * happens when real feedback arrives via `handleSupremeStateChange` (§11: "Do not fake
   * feedback or assume successful command execution means the physical state changed"). The
   * command already arrives capability-shaped (`real-server.ts` fills in `capability` from the
   * endpoint's resolved device type) — this method is device-type-agnostic. */
  private async handleMatterCommand(endpointNumber: number, command: CapabilityCommand): Promise<void> {
    const deviceId = this.exposedDevices.get(endpointNumber);
    if (!deviceId) {
      this.onLog("warn", `matter-bridge: command for unmapped endpoint ${endpointNumber}`);
      return;
    }
    try {
      await this.capabilities.command(deviceId, command);
    } catch (err) {
      this.onLog("error", `matter-bridge: command failed for ${deviceId}: ${(err as Error).message}`);
    }
  }

  /** Physical device / automation / any other source → SupremeOS → Matter (§1 required path,
   * direction 2, and §11's "physical changes"/"automation changes"/"local physical controls"
   * cases — all of them are just SupremeOS state events at this seam, so one handler covers
   * all three). Loop-safety: this only ever calls `setCapabilityState` (an attribute write),
   * never `onCommand`'s handler — a real Matter attribute write does not re-enter the command
   * path, so there is no cycle to guard against structurally. Only forwards a state change for
   * the capability that IS the endpoint's resolved device type's `primaryCapability` — an
   * unrelated capability change on a multi-capability device (e.g. a thermostat's temperature
   * changing on a device also bridged for something else — not possible in Phase 1's one-
   * capability-per-device-type model, but kept explicit for when Phase 3 changes that) must
   * never be mistaken for this endpoint's own state. */
  /** endpointNumber → the last state actually written to the Matter attribute, cheaply
   * serialized — guards against redundant writes for an identical, unchanged state report
   * (not a correctness requirement, since a no-op write is harmless, but avoids needless
   * `@matter/main` attribute-change event churn on every duplicate `onState` delivery). */
  private readonly lastReported = new Map<number, string>();
  private async handleSupremeStateChange(deviceId: DeviceId, capability: string, state: CapabilityState | null): Promise<void> {
    const endpointNumber = this.endpointByDevice.get(deviceId);
    if (endpointNumber === undefined) return; // not a bridged device — most devices aren't
    const deviceType = this.deviceTypeByEndpoint.get(endpointNumber);
    if (!deviceType || capability !== deviceType.primaryCapability || !state) return;
    const serialized = JSON.stringify(state);
    if (this.lastReported.get(endpointNumber) === serialized) return; // no real change
    this.lastReported.set(endpointNumber, serialized);
    await this.server.setCapabilityState(endpointNumber, state);
  }
}
