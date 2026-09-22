/**
 * (§ Matter Controller Extension, Phase 2 — Device Interview)
 *
 * Resolves a real Descriptor.DeviceTypeList entry to a friendly name where SupremeOS
 * already recognizes the numeric Matter device type id, using the SAME registry the
 * Matter Bridge already transcribed from `@matter/node`'s own generated device
 * definitions (`matter-bridge/device-types/matter-device-types.ts`'s doc comment names
 * this exact reuse: "requiredServerClusters/optionalServerClusters are what Phase 2
 * reuses from this same registry"). Read-only import — the Bridge module is never
 * modified by the Controller (§ requirement 16).
 *
 * Device type — not cluster presence — is the semantic answer to "what is this
 * endpoint?" (§ requirement 5): this resolver only ever looks at DeviceTypeList.
 */
import { MATTER_DEVICE_TYPES } from "../matter-bridge/device-types/matter-device-types.js";
import type { ResolvedDeviceType } from "./device-model.js";

const NAME_BY_DEVICE_TYPE_ID: ReadonlyMap<number, string> = new Map(
  MATTER_DEVICE_TYPES.map((d) => [d.id, d.name]),
);

/** Resolve one real Descriptor.DeviceTypeList entry. Unknown ids keep their numeric id and
 * revision with `name: null` — never discarded, never given an invented friendly name
 * (§ requirement 5). */
export function resolveDeviceType(deviceType: number, revision: number): ResolvedDeviceType {
  return { deviceType, revision, name: NAME_BY_DEVICE_TYPE_ID.get(deviceType) ?? null };
}
