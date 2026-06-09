import type { CapabilityKind } from "@supreme/domain-model";
import type { DiscoveredDevice } from "@supreme/integration-layer";

/**
 * Zigbee2MQTT bridge discovery (§3). Zigbee2MQTT retains the full device list on
 * `{base}/bridge/devices` as JSON, each device declaring typed "exposes". This maps
 * those exposes to Supreme capabilities so real Zigbee devices auto-populate the
 * Commissioning surface — `backendId` is the device's base topic, ready to bind.
 */

interface Z2mFeature {
  property?: string;
  name?: string;
}
interface Z2mExpose {
  type?: string;
  property?: string;
  name?: string;
  features?: Z2mFeature[];
}
interface Z2mDevice {
  friendly_name?: string;
  type?: string; // "Router" | "EndDevice" | "Coordinator"
  definition?: { model?: string; vendor?: string; exposes?: Z2mExpose[] } | null;
}

/** Map one device's exposes to a Supreme capability set (deduped, stable order). */
function capabilitiesOf(exposes: Z2mExpose[]): CapabilityKind[] {
  const caps = new Set<CapabilityKind>();
  for (const ex of exposes) {
    const props = new Set((ex.features ?? []).map((f) => f.property ?? f.name).filter(Boolean) as string[]);
    switch (ex.type) {
      case "light":
        caps.add("onoff");
        if (props.has("brightness")) caps.add("brightness");
        if (props.has("color_xy") || props.has("color_hs") || props.has("color_temp")) caps.add("color");
        break;
      case "switch":
        caps.add("onoff");
        break;
      case "cover":
        caps.add("position");
        break;
      case "lock":
        caps.add("lock");
        break;
      case "climate":
        caps.add("temperature");
        break;
      case "numeric":
        // A sensor reading (temperature/humidity/power/…) exposed at the top level.
        caps.add("sensor");
        break;
      case "binary":
        if ((ex.property ?? ex.name) === "state") caps.add("onoff");
        break;
      default:
        break;
    }
  }
  // Keep a stable, predictable order for the UI.
  const order: CapabilityKind[] = ["onoff", "brightness", "color", "position", "lock", "temperature", "sensor"];
  return order.filter((c) => caps.has(c));
}

export function discoveredFromZ2mBridge(payload: unknown, baseTopic: string): DiscoveredDevice[] {
  if (!Array.isArray(payload)) return [];
  const out: DiscoveredDevice[] = [];
  for (const raw of payload as Z2mDevice[]) {
    // Skip the coordinator and any device we can't describe.
    if (!raw.friendly_name || raw.type === "Coordinator") continue;
    const exposes = raw.definition?.exposes ?? [];
    const capabilities = capabilitiesOf(exposes);
    if (capabilities.length === 0) continue;
    out.push({
      backendId: `${baseTopic}/${raw.friendly_name}`,
      suggestedName: raw.friendly_name,
      capabilities,
      raw: {
        vendor: raw.definition?.vendor ?? null,
        model: raw.definition?.model ?? null,
        friendlyName: raw.friendly_name,
      },
    });
  }
  return out;
}
