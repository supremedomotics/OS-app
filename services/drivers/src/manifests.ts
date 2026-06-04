import { defineManifest, type DriverManifest } from "@supreme/driver-sdk";

/**
 * First-party driver manifests (§9): KNX, Casambi, DALI, Zigbee, MQTT, Modbus, and
 * Matter. Each wraps an HA integration underneath for now but declares a Supreme
 * capability manifest so a future native rewrite is a drop-in replacement.
 *
 * Matter ships DISABLED — the local Matter controller is enabled on demand by the
 * owner/installer (opt-in), and runs entirely on the hub.
 */
const PUBLISHER = "Supreme Domotics";

export const FIRST_PARTY_MANIFESTS: DriverManifest[] = [
  defineManifest({
    key: "supreme-knx",
    name: "Supreme KNX",
    description: "KNX/EIB bus — lighting, shades, climate.",
    category: "protocol",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "brightness", "position", "temperature"],
    protocols: ["knx"],
    compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
    backend: { type: "ha-integration", ref: "knx" },
  }),
  defineManifest({
    key: "supreme-casambi",
    name: "Supreme Casambi",
    description: "Casambi Bluetooth lighting control.",
    category: "lighting",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "brightness", "color"],
    protocols: ["casambi"],
    compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
    backend: { type: "ha-integration", ref: "casambi" },
  }),
  defineManifest({
    key: "supreme-dali",
    name: "Supreme DALI",
    description: "DALI-2 lighting buses.",
    category: "lighting",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "brightness"],
    protocols: ["dali"],
    compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
    backend: { type: "ha-integration", ref: "dali" },
  }),
  defineManifest({
    key: "supreme-zigbee",
    name: "Supreme Zigbee",
    description: "Zigbee mesh for sensors, lights, and switches.",
    category: "protocol",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "brightness", "color", "sensor"],
    protocols: ["zigbee"],
    compat: { hubMinVersion: "0.1.0", requiresSku: null },
    backend: { type: "ha-integration", ref: "zha" },
  }),
  defineManifest({
    key: "supreme-mqtt",
    name: "Supreme MQTT",
    description: "Generic MQTT device bridge.",
    category: "protocol",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "brightness", "sensor"],
    protocols: ["mqtt"],
    compat: { hubMinVersion: "0.1.0", requiresSku: null },
    backend: { type: "ha-integration", ref: "mqtt" },
  }),
  defineManifest({
    key: "supreme-modbus",
    name: "Supreme Modbus",
    description: "Modbus TCP/RTU for energy and HVAC plant.",
    category: "energy",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["sensor", "onoff", "temperature"],
    protocols: ["modbus"],
    compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
    backend: { type: "ha-integration", ref: "modbus" },
  }),
  defineManifest({
    key: "supreme-matter",
    name: "Supreme Matter",
    description: "Local Matter controller — opt-in, runs entirely on the hub.",
    category: "protocol",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "brightness", "color", "position", "sensor"],
    protocols: ["matter"],
    compat: { hubMinVersion: "0.1.0", requiresSku: null },
    backend: { type: "ha-integration", ref: "matter" },
    shipsDisabled: true,
  }),
];
