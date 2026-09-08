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
  /** endpointNumber → the device's full declared SupremeOS capability-kind set (§ Matter Bridge
   * Phase 1.2) — drives both command routing (`real-server.ts`, via `capabilityKinds` on the
   * endpoint spec) and which incoming state-change events this driver mirrors onto Matter
   * (`handleSupremeStateChange`, below) — a device with independently-addressed onoff/brightness/
   * color capabilities (e.g. KNX) reports state changes on ANY of them, not only the device
   * type's single `primaryCapability`. */
  private readonly capabilityKindsByEndpoint = new Map<number, Set<string>>();
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
          // § live-confirmed fix (Matter Bridge Phase 1.2) — this used to be `mapping.deviceId`,
          // which is EXACTLY what leaked into Apple Home as the accessory's displayed name:
          // `start()` runs on every boot BEFORE any reconcile pass supplies the real name, and
          // `addEndpoint` is deliberately idempotent (a no-op once the endpoint number already
          // exists), so the wrong name set here was never overwritten by the correct one a
          // moment later. `mapping.name` is the registry's own persisted "current SupremeOS
          // device.name," kept fresh by every `exposeDevice`/`reconcile` call — see
          // `endpoint-registry.ts`'s `resolve()`.
          name: mapping.name,
          deviceTypeId: deviceType.id,
          initialState: state,
          capabilityKinds: mapping.capabilityKinds,
        });
        this.exposedDevices.set(mapping.endpointNumber, mapping.deviceId);
        this.endpointByDevice.set(mapping.deviceId, mapping.endpointNumber);
        this.deviceTypeByEndpoint.set(mapping.endpointNumber, deviceType);
        this.capabilityKindsByEndpoint.set(mapping.endpointNumber, new Set(mapping.capabilityKinds));
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
    // § Matter Bridge Phase 1.2 — passing the CURRENT name here is what makes a SupremeOS
    // rename propagate: `resolve()` persists it (requirement 3), and it's also what `start()`'s
    // restart re-expose loop reads on the next boot (`mapping.name`, see its own doc comment).
    const capabilityKinds = capabilities.map((c) => c.kind);
    const mapping = this.registry.resolve(deviceId, deviceType.id, name, capabilityKinds);
    // The registry may return an EXISTING mapping whose deviceTypeId differs from what the
    // device resolves to right now (§ endpoint-registry.ts's `resolve` doc) — Phase 1 always
    // exposes using the PERSISTED device type, never silently re-typing an already-bridged
    // endpoint out from under a real ecosystem's cached view of it.
    const effectiveDeviceType = this.deviceTypeRegistry.byId(mapping.deviceTypeId) ?? deviceType;
    const state = await this.capabilities.getState(deviceId, effectiveDeviceType.primaryCapability);
    await this.server.addEndpoint({
      endpointNumber: mapping.endpointNumber,
      name: mapping.name,
      deviceTypeId: effectiveDeviceType.id,
      initialState: state,
      capabilityKinds: mapping.capabilityKinds,
    });
    // § Matter Bridge Phase 1.2 — `addEndpoint` is deliberately idempotent (a no-op once the
    // endpoint number already exists), so a RENAME of an already-bridged device would otherwise
    // never reach the live Matter attribute. This call is cheap and safe to make unconditionally
    // (a real state-write on the fake in tests; on the real server it's a plain attribute set,
    // not a rebuild) — it's what actually delivers requirement 3 for a device that was already
    // exposed before this call.
    await this.server.updateEndpointName(mapping.endpointNumber, mapping.name);
    this.exposedDevices.set(mapping.endpointNumber, deviceId);
    this.endpointByDevice.set(deviceId, mapping.endpointNumber);
    this.deviceTypeByEndpoint.set(mapping.endpointNumber, effectiveDeviceType);
    this.capabilityKindsByEndpoint.set(mapping.endpointNumber, new Set(mapping.capabilityKinds));
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
    this.capabilityKindsByEndpoint.delete(endpointNumber);
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
   * reset" action, never a restart/upgrade/rollback) must invoke it on purpose.
   *
   * § live-confirmed fix (Matter Bridge Phase 1.2A — "internal error after factory reset").
   * This method used to unsubscribe, clear every in-memory index, and call `this.start()` again
   * — modeled on the (incorrect) assumption that `server.factoryReset()` destroys the underlying
   * Matter node and a fresh one must be built. It does not: `RealMatterBridgeServer.
   * factoryReset()`'s own doc now traces the real SDK behavior (`ServerNode.erase()` wipes
   * commissioning/fabric state and brings the SAME node back online IN PLACE, never touching its
   * endpoint tree) — the driver's exposure indexes, the server's aggregator/endpoints, and the
   * live `onCommand`/`onState` subscriptions were never invalidated by a factory reset, so
   * unsubscribing and restarting was not just unneeded, it was the actual bug: it made `start()`
   * try to `ServerNode.create()` a SECOND node at the SAME storage path while the erased node
   * (still alive, still online, per the SDK's own contract) still held that path's storage lock
   * — throwing `StorageLockError: "Storage is already locked by this process"`, reported to the
   * Extension Center only as a generic "internal error", and orphaning that still-locked node
   * for the rest of the process's life (so every later Enable, even after a Disable, hit the
   * identical error). Only the Matter-side commissioning/pairing identity changes on a factory
   * reset; nothing about SupremeOS↔Matter routing does, so nothing here needs rebuilding. */
  async factoryReset(): Promise<void> {
    await this.server.factoryReset();
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
    // § TEMPORARY — Matter Bridge Phase 1.3 diagnostic tracing (boundaries A/B/C, § FINAL
    // CAPABILITY FAILURE ISOLATION). Remove once KNX/Casambi/Pantry Strip failures are root-
    // caused. Deliberately protocol-agnostic — this fires for EVERY bridged device's command,
    // the one choke point every Matter-issued command passes through regardless of protocol.
    const t0 = Date.now();
    this.onLog(
      "info",
      `matter-bridge TRACE A/B: command received — ts=${t0} endpointId=${endpointNumber} device.id=${deviceId ?? "UNMAPPED"} ` +
        `capability=${command.capability} command=${JSON.stringify(command)}`,
    );
    if (!deviceId) {
      this.onLog("warn", `matter-bridge: command for unmapped endpoint ${endpointNumber}`);
      return;
    }
    try {
      await this.capabilities.command(deviceId, command);
      this.onLog(
        "info",
        `matter-bridge TRACE C: command accepted — ts=${Date.now()} elapsedMs=${Date.now() - t0} endpointId=${endpointNumber} ` +
          `device.id=${deviceId} capability=${command.capability} result=accepted`,
      );
    } catch (err) {
      this.onLog(
        "error",
        `matter-bridge TRACE C: command rejected — ts=${Date.now()} elapsedMs=${Date.now() - t0} endpointId=${endpointNumber} ` +
          `device.id=${deviceId} capability=${command.capability} result=error error=${(err as Error).message}`,
      );
      this.onLog("error", `matter-bridge: command failed for ${deviceId}: ${(err as Error).message}`);
    }
  }

  /** Physical device / automation / any other source → SupremeOS → Matter (§1 required path,
   * direction 2, and §11's "physical changes"/"automation changes"/"local physical controls"
   * cases — all of them are just SupremeOS state events at this seam, so one handler covers
   * all three). Loop-safety: this only ever calls `setCapabilityState` (an attribute write),
   * never `onCommand`'s handler — a real Matter attribute write does not re-enter the command
   * path, so there is no cycle to guard against structurally.
   *
   * § live-confirmed fix (Matter Bridge Phase 1.2 — "live feedback failure") — this used to
   * forward ONLY a state change on the endpoint's device type's single `primaryCapability` (e.g.
   * `"color"` for every Color Temperature Light), which silently dropped every state event on a
   * capability a device declares SEPARATELY from its primary one. A device with independently
   * addressed `onoff`/`brightness`/`color` capabilities (confirmed for KNX —
   * `services/protocols/src/knx/capability-mapper.ts` declares all three separately, unlike
   * Casambi's merged `["brightness","color"]`) reports an onoff-only physical change (e.g. a wall
   * switch) as an `"onoff"` capability-state event, which never matched `"color"` and was
   * therefore dropped before it ever reached Apple Home. Now forwards ANY state event whose
   * capability is one this endpoint actually declared (`capabilityKindsByEndpoint`) — each
   * `setCapabilityState` call only ever writes the Matter attributes ITS OWN state kind covers
   * (see `real-server.ts`'s dispatch), so multiple independent capability events for the same
   * endpoint compose safely, never clobbering an unrelated attribute. Falls back to the single
   * `primaryCapability` check when the endpoint has no persisted capability set yet (a
   * pre-this-fix registry entry that hasn't been re-exposed by a reconcile pass). */
  /** endpointNumber → the last state actually written to the Matter attribute, cheaply
   * serialized — guards against redundant writes for an identical, unchanged state report
   * (not a correctness requirement, since a no-op write is harmless, but avoids needless
   * `@matter/main` attribute-change event churn on every duplicate `onState` delivery). */
  private readonly lastReported = new Map<number, string>();
  private async handleSupremeStateChange(deviceId: DeviceId, capability: string, state: CapabilityState | null): Promise<void> {
    // § TEMPORARY — Matter Bridge Phase 1.3 diagnostic tracing (boundary G, this bridge's own
    // receipt of a SupremeOS state event — the earliest point in THIS file a device/protocol
    // change becomes visible; anything upstream of this — the protocol driver's own event
    // receipt — is outside the Matter Bridge and is not traced here to avoid protocol-specific
    // code in this file). Remove once KNX/Casambi/Pantry Strip failures are root-caused.
    const tG = Date.now();
    const endpointNumber = this.endpointByDevice.get(deviceId);
    this.onLog(
      "info",
      `matter-bridge TRACE G: SupremeOS state event received — ts=${tG} device.id=${deviceId} endpointId=${endpointNumber ?? "NOT_BRIDGED"} ` +
        `capability=${capability} state=${JSON.stringify(state)}`,
    );
    if (endpointNumber === undefined) return; // not a bridged device — most devices aren't
    const deviceType = this.deviceTypeByEndpoint.get(endpointNumber);
    if (!deviceType || !state) return;
    const relevantKinds = this.capabilityKindsByEndpoint.get(endpointNumber);
    const isRelevant = relevantKinds && relevantKinds.size > 0 ? relevantKinds.has(capability) : capability === deviceType.primaryCapability;
    if (!isRelevant) {
      this.onLog(
        "info",
        `matter-bridge TRACE G: state event IGNORED — capability=${capability} is not among this endpoint's relevant capabilities ` +
          `(${relevantKinds ? [...relevantKinds].join(",") : `primaryCapability=${deviceType.primaryCapability}`}) endpointId=${endpointNumber} device.id=${deviceId}`,
      );
      return;
    }
    const serialized = JSON.stringify(state);
    if (this.lastReported.get(endpointNumber) === serialized) {
      this.onLog("info", `matter-bridge TRACE G: state event DEDUPED (identical to last-written) endpointId=${endpointNumber} device.id=${deviceId}`);
      return;
    }
    this.lastReported.set(endpointNumber, serialized);
    await this.server.setCapabilityState(endpointNumber, state);
    // § TRACE H/I — the Matter attribute write itself (`setCapabilityState`) is a synchronous
    // `endpoint.set()` call (real-server.ts) that triggers @matter/main's own attribute-change/
    // report machinery internally — @matter/main's own subscription-report scheduling from this
    // point onward (I) is SDK-internal and not independently traceable from this file.
    this.onLog(
      "info",
      `matter-bridge TRACE H: Matter attribute updated — ts=${Date.now()} elapsedMsSinceG=${Date.now() - tG} endpointId=${endpointNumber} ` +
        `device.id=${deviceId} capability=${capability} state=${JSON.stringify(state)}`,
    );
  }
}
