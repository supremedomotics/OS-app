/**
 * @supreme/homekit — local HomeKit (HAP) accessory bridge for Apple Home / Siri (blueprint §9).
 * Opt-in, runs entirely on the hub (HomeKit is local-only — no cloud). The capability↔HAP mapping
 * and bridge orchestration are here; the real HAP server (pairing, mDNS) is injected via HapTransport.
 */
export {
  hapServicesFor,
  commandFromCharacteristic,
  characteristicsFromState,
  miredToKelvin,
  kelvinToMired,
  type HapService,
  type HapServiceType,
  type HapCommand,
} from "./hap-mapping.js";
export {
  HapBridge,
  type HapBridgeOptions,
  type HapTransport,
  type HapAccessory,
  type CharacteristicWrite,
  type SupremeDeviceView,
} from "./bridge.js";
