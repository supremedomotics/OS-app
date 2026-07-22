import type { CapabilityKind, CapabilityState } from "@supreme/domain-model";
import { defaultDpt } from "../knx-codec.js";
import type { CommunicationObject, UnifiedKnxDevice } from "./unified-device-mapper.js";

/**
 * Binding Engine (§ Unified Device Intelligence — Phase 4).
 *
 * Turns a {@link UnifiedKnxDevice} into per-capability binding plans — the exact input
 * shape the EXISTING gateway commissioning API (`InstallerContext.bindProtocol`/
 * `commissionDevice` in `services/gateway/src/installer-context.ts`) already accepts
 * (`{ capability, address, config }`, minus `deviceId` which only exists once the
 * installer approves and the gateway mints one). This engine does NOT reimplement
 * binding persistence, ownership, or device-registry writes — those already exist
 * (§ Native Driver Architecture, § Device Ownership) and are reused as-is; this is only
 * the KNX-specific step of deciding WHAT address/config each capability should bind to.
 *
 * A classic KNX group address (`n/n/n`) is directly bindable through KNX Ultimate's
 * `bus.group_write`/`bus.group_read` task kinds. A KNX-IoT-only communication object
 * (a CoAP host/resource, no group address) is NOT yet bindable through those same task
 * kinds — KNX IoT is registered only for `discovery.*` (§ Phase 2 Compatibility Report),
 * so such a capability is reported with `bindable: false` and an honest reason, never a
 * fabricated address.
 */

const GROUP_ADDRESS_RE = /^\d{1,2}\/\d{1,2}\/\d{1,3}$/;

export interface BindingPlanItem {
  capability: CapabilityKind;
  /** Present only when a real group address was found; the exact address to write to. */
  address: string | null;
  config: { statusAddress?: string; stepAddress?: string; dpt: string };
  bindable: boolean;
  reason: string;
  /** The communication object(s) this plan was derived from — traceability (§ Diagnostics
   * "Communication Status"). */
  sourceObjects: CommunicationObject[];
}

/** Builds one binding plan per capability the Unified Device Mapper detected — each
 * plan uses ONLY the communication objects tagged with THAT capability (§ production
 * defect: a merged multi-capability device — e.g. a Tunable White circuit's onoff +
 * brightness + color — used to blindly reuse the device's first two group addresses
 * for every capability, silently binding brightness and color to the switch's address
 * once clustering correctly stopped splitting them into separate single-capability
 * devices). Within a capability's own objects: the `"primary"` one is the write
 * address, a `"status"` one (if present) is the feedback address, a `"step"` one (if
 * present — e.g. "Relative Dimming"/"Relative Color Temperature") is the nudge/warmer-
 * cooler address — never guessed beyond what the grouped signals actually contain. A
 * capability with no `"primary"` object among its own tagged objects (KNX IoT-only, or
 * a capability that only ever had a step/status object) falls back to any bindable
 * object it does have rather than silently doing nothing. */
export function planBindings(device: UnifiedKnxDevice): BindingPlanItem[] {
  return device.capabilities.map((capability) => {
    const own = device.raw.communicationObjects.filter(
      (o) => GROUP_ADDRESS_RE.test(o.id) && o.capabilities.includes(capability),
    );
    const writeObj = own.find((o) => o.role === "primary") ?? own[0];
    const statusObj = own.find((o) => o.role === "status");
    const stepObj = own.find((o) => o.role === "step");
    const dpt = defaultDpt(capability as CapabilityState["kind"]);

    if (!writeObj) {
      return {
        capability,
        address: null,
        config: { dpt },
        bindable: false,
        reason: own.length > 0
          ? "only a feedback/step group address was discovered for this capability — no write address to bind"
          : "no classic KNX group address available for this capability — only KNX IoT resources were discovered, and KNX IoT is not registered for bus communication (§ Compatibility Report)",
        sourceObjects: own.length > 0 ? own : device.raw.communicationObjects,
      };
    }
    const parts = [`write via ${writeObj.id}`];
    if (statusObj) parts.push(`feedback via ${statusObj.id}`);
    if (stepObj) parts.push(`step via ${stepObj.id}`);
    if (!statusObj && !stepObj) parts.push("no separate feedback address discovered — optimistic state only");
    return {
      capability,
      address: writeObj.id,
      config: { statusAddress: statusObj?.id, stepAddress: stepObj?.id, dpt },
      bindable: true,
      reason: parts.join(", "),
      sourceObjects: own,
    };
  });
}

/** True only when every capability of the device produced a bindable plan — the signal
 * the installer workflow uses to decide whether a device can go straight to "Ready to
 * Approve" or needs the "Needs Review" bucket (§ Discover Devices UX). */
export function isFullyBindable(plans: BindingPlanItem[]): boolean {
  return plans.length > 0 && plans.every((p) => p.bindable);
}
