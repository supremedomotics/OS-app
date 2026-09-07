import type { CapabilityKind, CapabilityState } from "@supreme/domain-model";
import { defaultDpt } from "../knx-codec.js";
import { colorModesFromDpt } from "./capability-mapper.js";
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
  config: {
    statusAddress?: string;
    stepAddress?: string;
    dpt: string;
    /** § Shared/central relationships (fifth pass) — additional GAs this capability
     * receives feedback from beyond the primary `statusAddress` (e.g. a local status
     * object AND a central "All Lights OFF" GA both feed the same `onoff` capability).
     * Never replaces the local mapping — see `planBindings`'s doc comment. Omitted when
     * there is nothing beyond the primary status address. */
    extraStatusAddresses?: string[];
    /** Additional GAs this device could also be commanded from beyond the primary
     * `address` (rare — a device with more than one ETS-confirmed send relationship for
     * the same capability). Never actively written to by `SupremeKnxDriver.command()`
     * today (§ known limitation, disclosed rather than silently dropped); preserved here
     * so the relationship isn't lost and future multi-write support has real data to use. */
    extraCommandAddresses?: string[];
    /** § P0-C (Pass 28) — for a `color` capability only: whether the REAL DPT this plan
     * bound to is RGB(W) or Kelvin-only tunable-white (§ `colorModesFromDpt` — the same
     * evidence `SupremeKnxDriver.getCapabilityConfig` uses once bound, computed here so
     * the DISCOVERY/REVIEW stage — before any binding exists — already knows which, not
     * just "color: true"). `undefined` for every non-`color` capability, and for a
     * `color` capability whose DPT doesn't structurally resolve to either. */
    colorModes?: { rgb: boolean; cct: boolean };
  };
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
 * cooler address — never guessed beyond what the grouped signals actually contain.
 *
 * § Command/Feedback Binding Architecture (Production KNX Driver 2.0, third pass) — a
 * capability whose only tagged object is `"status"` (a real ETS Receive-only
 * relationship, or a step-only object) is correctly `bindable: false`, never silently
 * promoted to a write target. This used to fall back to "any bindable object it does
 * have" (`?? own[0]`), which was safe ONLY because every KNX-IoT/functional-block object
 * was already pre-tagged `"primary"` by default (`fallbackTag`, unified-device-mapper.ts)
 * and so never actually reached that fallback — but once real ETS Send/Receive data
 * could legitimately tag an object `"status"` with no `"primary"` object anywhere in the
 * capability's own set, that same fallback would have silently written commands to a
 * device's FEEDBACK address, exactly the failure mode this architecture exists to
 * prevent. Removed — a capability with no explicit write relationship is honestly
 * unbindable, not guessed at. */
export function planBindings(device: UnifiedKnxDevice): BindingPlanItem[] {
  // § Pass 26 — multi-channel actuator home-channel evidence. A multi-channel actuator
  // (e.g. a DALI gateway) shares ONE individual address across every output channel, so
  // the Unified Device Mapper's clustering (out of scope for this fix — see the binding-
  // engine-only mandate this was found under) can legitimately land more than one real
  // channel's group addresses under a single merged `UnifiedKnxDevice`. When that
  // happens, a capability whose OWN command/status GA is legitimately shared with a
  // second physical device (e.g. a diagnostics/logic module also reading the same
  // switch GA — real, valid KNX wiring) gets `local: false` for every candidate, and the
  // `byEvidence` tie-break below used to fall through to a bare lexical GA-id compare —
  // "0/0/1" sorts before "5/3/0" for no reason connected to which channel is actually
  // THIS device's own (confirmed against a real ETS6 project: a DALI gateway's Conference
  // Hanging channel's onoff capability bound to a sibling channel's "0/0/1"/"0/0/2" pair
  // instead of its own "5/3/0"/"5/3/1", while its brightness/color capabilities — which
  // happened to have no cross-device sharing — resolved correctly via `local: true`
  // alone). Anchor the tie-break on whichever channel this device's OTHER, unambiguous
  // (`local: true`) evidence already points to — never fabricated, only read from
  // signals this same device already carries.
  const homeChannel = device.raw.communicationObjects.find((o) => o.local && o.channel != null)?.channel ?? null;
  return device.capabilities.map((capability) => {
    const own = device.raw.communicationObjects.filter(
      (o) => GROUP_ADDRESS_RE.test(o.id) && o.capabilities.includes(capability),
    );
    // § Shared/central relationships (fifth pass) — a device can legitimately have MORE
    // than one "primary" or "status" object for the same capability (its own local
    // switch/status pair PLUS a central "All Lights OFF" GA that also feeds it — §5/§6
    // of the relationship-specific role audit). The first of each becomes the binding's
    // main write/status address (unchanged contract for every existing caller); any
    // additional ones are preserved in `config.extra*Addresses` rather than silently
    // dropped — never forced into the primary slot, never lost.
    // § Binding Evidence Hierarchy (Pass 11.4) — `own` (and therefore `primaryObjs`/
    // `statusObjs`) is filtered from `device.raw.communicationObjects` in ITS OWN
    // insertion order, which is itself input-signal-order-dependent (ETS export order,
    // permutation, etc.). When a capability legitimately has more than one write-capable
    // (or status-capable) object — its own local circuit command PLUS a fanned-in
    // shared/central GA (e.g. "All Lights Off") that also happens to carry a real SEND/
    // RECEIVE relationship to this device — `[0]` picked whichever won the race in the
    // caller's array, not the structurally-correct one. Rank deterministically instead:
    // a LOCAL object (this device's own pre-fan-out signal — see `CommunicationObject
    // .local`'s doc comment) always outranks a fanned-in one; among objects tied on
    // locality (both local, or both fanned-in — e.g. two distinct shared GAs), the GA id
    // itself breaks the tie, never insertion order. A shared GA still legitimately wins
    // when it's the ONLY candidate (no local alternative exists) — this ranking simply
    // never lets it win a tie it didn't earn.
    const byEvidence = (a: CommunicationObject, b: CommunicationObject) =>
      Number(b.local) - Number(a.local) ||
      Number(b.channel === homeChannel) - Number(a.channel === homeChannel) ||
      a.id.localeCompare(b.id);
    const primaryObjs = own.filter((o) => o.role === "primary").sort(byEvidence);
    const statusObjs = own.filter((o) => o.role === "status").sort(byEvidence);
    const writeObj = primaryObjs[0];
    const statusObj = statusObjs[0];
    // Same evidence-hierarchy fix as primary/status above — a plain `.find()` picked
    // whichever step/nudge object (e.g. a local "Relative Dimming" vs a fanned-in shared
    // one) happened to appear first in `own`'s input-order-dependent array.
    const stepObj = own.filter((o) => o.role === "step").sort(byEvidence)[0];
    // § PASS 17 bug fix — a capability's write/status/step group addresses are not
    // guaranteed to share a single DPT family (a `color` capability in particular: KNX
    // has no single "color" DPT — DPT232.600/251.600 are RGB(W), DPT7.600 is a plain
    // absolute Kelvin value for tunable-white fixtures). Previously this ALWAYS used
    // `defaultDpt(capability)`, hardcoding RGB for every color-capability binding
    // regardless of what the real ETS group address actually was — a tunable-white
    // circuit's genuine DPT7.600 object got driven/decoded as if it were 3-byte RGB.
    // Prefer the real DPT the ETS project reported on whichever object actually carries
    // the write relationship (falling back to the status/step object's DPT if the write
    // object itself didn't have one, e.g. a KNX IoT resource with no DPT concept), and
    // only fall back to the generic per-capability default when NONE of this capability's
    // real objects reported a DPT at all.
    const realDpt = writeObj?.dpt ?? statusObj?.dpt ?? stepObj?.dpt ?? null;
    const dpt = realDpt ? `DPT${realDpt}` : defaultDpt(capability as CapabilityState["kind"]);
    // § P0-C (Pass 28) — computed at DISCOVERY/REVIEW time, before any binding exists,
    // from the same real-DPT evidence just resolved above — never a name/label guess.
    const colorModes = capability === "color" ? (colorModesFromDpt(dpt) ?? undefined) : undefined;

    if (!writeObj) {
      return {
        capability,
        address: null,
        config: { dpt, ...(colorModes ? { colorModes } : {}) },
        bindable: false,
        reason: own.length > 0
          ? "only a feedback/step group address was discovered for this capability — no write address to bind"
          : "no classic KNX group address available for this capability — only KNX IoT resources were discovered, and KNX IoT is not registered for bus communication (§ Compatibility Report)",
        sourceObjects: own.length > 0 ? own : device.raw.communicationObjects,
      };
    }
    const extraStatusAddresses = statusObjs.slice(1).map((o) => o.id);
    const extraCommandAddresses = primaryObjs.slice(1).map((o) => o.id);
    const parts = [`write via ${writeObj.id}`];
    if (statusObj) parts.push(`feedback via ${statusObj.id}`);
    if (stepObj) parts.push(`step via ${stepObj.id}`);
    if (!statusObj && !stepObj) parts.push("no separate feedback address discovered — optimistic state only");
    if (extraStatusAddresses.length > 0) parts.push(`additional feedback via ${extraStatusAddresses.join(", ")}`);
    if (extraCommandAddresses.length > 0) parts.push(`additional command relationship via ${extraCommandAddresses.join(", ")}`);
    return {
      capability,
      address: writeObj.id,
      config: {
        statusAddress: statusObj?.id,
        stepAddress: stepObj?.id,
        dpt,
        ...(extraStatusAddresses.length > 0 ? { extraStatusAddresses } : {}),
        ...(extraCommandAddresses.length > 0 ? { extraCommandAddresses } : {}),
        ...(colorModes ? { colorModes } : {}),
      },
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
