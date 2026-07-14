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
  config: { statusAddress?: string; dpt: string };
  bindable: boolean;
  reason: string;
  /** The communication object(s) this plan was derived from — traceability (§ Diagnostics
   * "Communication Status"). */
  sourceObjects: CommunicationObject[];
}

function findGroupAddress(objects: CommunicationObject[]): CommunicationObject | undefined {
  return objects.find((o) => GROUP_ADDRESS_RE.test(o.id));
}

/** Builds one binding plan per capability the Unified Device Mapper detected. When more
 * than one group address contributed to the device (write GA + separate status/feedback
 * GA — the exact "Kitchen Light SW" / "Kitchen Light STATUS" case from the spec), the
 * first is used as the write address and a second, if present, as the status address —
 * never guessed beyond what the grouped signals actually contain. */
export function planBindings(device: UnifiedKnxDevice): BindingPlanItem[] {
  const groupAddresses = device.raw.communicationObjects.filter((o) => GROUP_ADDRESS_RE.test(o.id));
  const [writeObj, statusObj] = groupAddresses;

  return device.capabilities.map((capability) => {
    const dpt = defaultDpt(capability as CapabilityState["kind"]);
    if (!writeObj) {
      return {
        capability,
        address: null,
        config: { dpt },
        bindable: false,
        reason: "no classic KNX group address available for this device — only KNX IoT resources were discovered, and KNX IoT is not registered for bus communication (§ Compatibility Report)",
        sourceObjects: device.raw.communicationObjects,
      };
    }
    return {
      capability,
      address: writeObj.id,
      config: { statusAddress: statusObj?.id, dpt },
      bindable: true,
      reason: statusObj
        ? `write via ${writeObj.id}, feedback via ${statusObj.id}`
        : `write via ${writeObj.id}; no separate feedback address discovered — optimistic state only`,
      sourceObjects: groupAddresses,
    };
  });
}

/** True only when every capability of the device produced a bindable plan — the signal
 * the installer workflow uses to decide whether a device can go straight to "Ready to
 * Approve" or needs the "Needs Review" bucket (§ Discover Devices UX). */
export function isFullyBindable(plans: BindingPlanItem[]): boolean {
  return plans.length > 0 && plans.every((p) => p.bindable);
}
