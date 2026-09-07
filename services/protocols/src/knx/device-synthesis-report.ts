import type { UnifiedKnxDevice } from "./unified-device-mapper.js";
import { planBindings, type BindingPlanItem } from "./binding-engine.js";

/**
 * § Synthesis Evidence (ninth pass) — a diagnostic-only, backend aggregation of
 * evidence `mapUnifiedDevices`/`planBindings` ALREADY computed and already stores on
 * the device (`groupingEvidence`, `externalControls`, `mergeExplanation`,
 * `sourceHrefs`) plus each capability's own binding `reason` string — never a new
 * inference, never a second synthesis pass, purely "why did SupremeOS create this
 * exact Device Card." Not surfaced in any UI; exists so an installer-import failure or
 * a wrong Device Card can be debugged from this one structure instead of re-deriving
 * the answer by hand from raw ETS data. */
export interface DeviceSynthesisEvidence {
  deviceIdentityEvidence: {
    physicalDevice: string | null;
    channels: number[];
    groupingKey: string;
    groupingEvidence: UnifiedKnxDevice["raw"]["groupingEvidence"];
  };
  namingEvidence: {
    resolvedName: string | null;
    room: string | null;
    mergeExplanation: string[];
  };
  capabilityEvidence: {
    capabilities: string[];
    matchedOn: string[];
  };
  bindingEvidence: { capability: string; bindable: boolean; reason: string }[];
  externalControls: UnifiedKnxDevice["raw"]["externalControls"];
}

export function buildDeviceSynthesisEvidence(device: UnifiedKnxDevice, plans?: BindingPlanItem[]): DeviceSynthesisEvidence {
  const resolvedPlans = plans ?? planBindings(device);
  return {
    deviceIdentityEvidence: {
      physicalDevice: device.raw.physicalDevice?.individualAddress ?? null,
      channels: device.raw.physicalDevice?.channels ?? [],
      groupingKey: device.raw.groupingKey,
      groupingEvidence: device.raw.groupingEvidence,
    },
    namingEvidence: {
      resolvedName: device.raw.metadata.deviceName,
      room: device.raw.metadata.room,
      mergeExplanation: device.raw.mergeExplanation,
    },
    capabilityEvidence: {
      capabilities: device.capabilities,
      matchedOn: device.raw.sourceHrefs,
    },
    bindingEvidence: resolvedPlans.map((p) => ({ capability: p.capability, bindable: p.bindable, reason: p.reason })),
    externalControls: device.raw.externalControls,
  };
}

/**
 * Device Synthesis Report (§18, Production KNX Device Synthesis Audit) — a human-
 * readable debug/test helper, not a UI feature and not a new data model. It only
 * FORMATS what `mapUnifiedDevices` + `planBindings` already computed: one block per
 * synthesized device listing Physical Device / Individual Address / Channel / Room /
 * Circuit / Device Type / Capabilities, each capability showing the command GA and
 * feedback GA (plus any additional shared/central relationship — §5th pass) it
 * resolved to. Never fabricates a field — `null`/"none" prints exactly when the
 * underlying data is null/empty, same honesty contract as everywhere else in this
 * pipeline. */
export function generateDeviceSynthesisReport(devices: UnifiedKnxDevice[]): string {
  if (devices.length === 0) return "No devices synthesized.";

  return devices
    .map((device) => {
      const phys = device.raw.physicalDevice;
      const plans = planBindings(device);
      // § Channel Synthesis (Pass 2) — one line per physical channel this logical
      // device was synthesized from, plus the comm objects that came from it (§13/§23:
      // channel identity must survive a multi-channel merge, visible for diagnostics).
      const channels = phys?.channels ?? [];
      const channelLines = channels.map((ch) => {
        const objsOnChannel = device.raw.communicationObjects.filter((o) => o.channel === ch).map((o) => o.name);
        return `  ${ch}${channels.length > 1 ? " →" : ""} ${objsOnChannel.join(", ") || "(no channel-tagged comm objects)"}`;
      });
      const lines = [
        `Physical Device: ${phys?.individualAddress ?? "(none — no ETS device-tree identity)"}`,
        `Individual Address: ${phys?.individualAddress ?? "null"}`,
        `Manufacturer: ${phys?.manufacturer ?? "null"}`,
        `Model: ${phys?.model ?? "null"}`,
        `Channels:`,
        ...(channelLines.length > 0 ? channelLines : ["  (none)"]),
        `Room: ${device.raw.metadata.room ?? "null"}`,
        `Circuit: ${device.raw.metadata.deviceName ?? device.raw.groupingKey}`,
        `Device Type: ${device.raw.deviceKind}`,
        // § Raw data preservation (Pass 4) — the REAL evidence that caused this merge
        // (`evaluateChannelGroupingEvidence`'s own output), never a fabricated summary.
        // Empty for a single-channel device — nothing to explain.
        ...device.raw.groupingEvidence.flatMap((e, i) => [
          `Grouping Evidence ${device.raw.groupingEvidence.length > 1 ? `#${i + 1} ` : ""}: ${e.evidence.join("; ")}`,
          `Confidence: ${e.confidence[0]!.toUpperCase()}${e.confidence.slice(1)}`,
          `Reason: ${e.reason}`,
        ]),
        `Capabilities:`,
        ...plans.map((p) => {
          const command = p.address ?? "(none — not bindable)";
          const feedback = p.config.statusAddress ?? "(none — optimistic state only)";
          const extraCommand = p.config.extraCommandAddresses?.length ? `, additional command: ${p.config.extraCommandAddresses.join(", ")}` : "";
          const extraFeedback = p.config.extraStatusAddresses?.length ? `, additional feedback: ${p.config.extraStatusAddresses.join(", ")}` : "";
          return `  - ${p.capability}: command=${command}, feedback=${feedback}${extraCommand}${extraFeedback}`;
        }),
        // § Control-Relationship Model (Pass 3) — other physical devices (keypads, scene
        // controllers) that can also trigger a GA this device uses. Never merged into
        // Physical Device/Channels above — a separate, explicit relationship.
        ...(device.raw.externalControls.length > 0
          ? [
              `External Controls:`,
              ...device.raw.externalControls.map((c) => `  ${c.individualAddress}${c.comObjectText ? ` (${c.comObjectText})` : ""} → ${c.groupAddress}`),
            ]
          : []),
      ];
      return lines.join("\n");
    })
    .join("\n\n");
}
