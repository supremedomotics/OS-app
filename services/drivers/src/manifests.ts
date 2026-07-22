import { defineManifest, type DriverManifest } from "@supreme/driver-sdk";
import { DEFAULT_DRIVER_OPERATIONS, type DriverConfigField } from "@supreme/domain-model";

/**
 * First-party driver manifests (§9). Each declares a Supreme capability manifest, a config SCHEMA
 * (so the Driver Manager auto-generates its config page), and the operations it supports — so any
 * driver, current or future, appears in the UI automatically with the right controls. A future
 * native rewrite is a drop-in replacement behind the same manifest.
 *
 * Matter ships DISABLED — enabled on demand by the owner/installer (opt-in), runs on the hub.
 */
const PUBLISHER = "Supreme Domotics";

/** Protocol drivers additionally support live connect/disconnect. */
const PROTO_OPS = [...DEFAULT_DRIVER_OPERATIONS, "connect", "disconnect"] as const;

const hostField: DriverConfigField = { key: "host", label: "Gateway host / IP", type: "host", required: true, placeholder: "192.168.1.10", secret: false };
const portField = (def: number): DriverConfigField => ({ key: "port", label: "Port", type: "port", required: true, default: def, secret: false });

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
    backend: { type: "native", ref: "knx" },
    operations: [...PROTO_OPS],
    documentationUrl: "https://docs.supreme.local/extensions/knx",
    releaseNotes:
      "KNXnet/IP tunnelling with automatic group-address discovery from an ETS project export. Supports switching, dimming, shades and climate.",
    changelog: [
      { version: "1.0.0", date: "2026-05-01", notes: "First stable release: KNXnet/IP tunnelling, ETS import, onoff/brightness/position/temperature." },
    ],
    configSchema: [
      hostField,
      portField(3671),
      { key: "individualAddress", label: "Physical address", type: "text", placeholder: "1.1.255", help: "The interface's KNX individual address.", secret: false },
      {
        key: "groupAddressSchema",
        label: "Group Address Schema",
        type: "select",
        required: true,
        default: "auto",
        help: "How this project's group-address names are structured — used to group every operation belonging to one circuit into a single SupremeOS device. \"Automatic\" strips known operation-word suffixes (Switch/Status/Dimming/…) regardless of position — the safe default for a typical flat export (\"Room - Device - Operation\"). Pick a specific schema only when your project follows a strict, consistent hierarchy the automatic detector doesn't match.",
        options: [
          { value: "auto", label: "Automatic (recommended)" },
          { value: "floor-room-device", label: "Floor → Room → Device Name" },
          { value: "circuit-operation-name", label: "Circuit Type → Operation Type → Circuit Name" },
        ],
        secret: false,
      },
    ],
  }),
  defineManifest({
    key: "supreme-casambi",
    name: "Supreme Casambi",
    description: "Casambi Bluetooth-mesh lighting control.",
    category: "lighting",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "brightness", "color", "position", "sensor"],
    protocols: ["casambi"],
    compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
    backend: { type: "native", ref: "casambi" },
    operations: [...PROTO_OPS],
    documentationUrl: "https://docs.supreme.local/extensions/casambi",
    releaseNotes:
      "Native Casambi Cloud driver (REST + WebSocket): live state streaming with heartbeat and auto-reconnect, capabilities derived per fixture, and automatic room mapping from Casambi group names.",
    changelog: [
      { version: "1.0.0", date: "2026-07-10", notes: "First stable release: native REST + WebSocket, onoff/brightness/color/position/sensor, auto room mapping." },
    ],
    configSchema: [
      { key: "apiKey", label: "API key", type: "password", required: true, secret: true, help: "WebSocket-enabled key from Casambi Support." },
      { key: "email", label: "Network admin email", type: "text", required: true, secret: false },
      { key: "password", label: "Network admin password", type: "password", required: true, secret: true },
      { key: "networkId", label: "Network id (optional)", type: "text", help: "Pin a single network for a faster session handshake.", secret: false },
    ],
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
    backend: { type: "native", ref: "dali" },
    operations: [...PROTO_OPS],
    configSchema: [hostField, portField(23), { key: "line", label: "DALI line", type: "number", default: 0, min: 0, max: 15, secret: false }],
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
    backend: { type: "native", ref: "zha" },
    operations: [...PROTO_OPS],
    configSchema: [
      { key: "serialPort", label: "Coordinator serial port", type: "text", required: true, placeholder: "/dev/ttyUSB0", secret: false },
      { key: "channel", label: "Zigbee channel", type: "number", default: 15, min: 11, max: 26, secret: false },
      { key: "permitJoin", label: "Permit join (pairing)", type: "boolean", default: false, secret: false },
    ],
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
    backend: { type: "native", ref: "mqtt" },
    operations: [...PROTO_OPS],
    configSchema: [
      { key: "url", label: "Broker URL", type: "text", required: true, placeholder: "mqtt://192.168.1.10:1883", secret: false },
      { key: "username", label: "Username", type: "text", secret: false },
      { key: "password", label: "Password", type: "password", secret: true },
      { key: "baseTopic", label: "Base topic", type: "text", default: "supreme", secret: false },
    ],
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
    backend: { type: "native", ref: "modbus" },
    operations: [...PROTO_OPS],
    configSchema: [hostField, portField(502), { key: "unitId", label: "Unit / slave id", type: "number", default: 1, min: 1, max: 247, secret: false }],
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
    backend: { type: "native", ref: "matter" },
    shipsDisabled: true,
    operations: [...PROTO_OPS],
    configSchema: [{ key: "fabricLabel", label: "Fabric label", type: "text", default: "Supreme", secret: false }],
  }),
  defineManifest({
    key: "supreme-lutron",
    name: "Supreme Lutron",
    description: "Lutron RadioRA 2 / HomeWorks QS / Caséta (Integration Protocol).",
    category: "lighting",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "brightness", "position"],
    protocols: ["lutron"],
    compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
    backend: { type: "native", ref: "lutron" },
    operations: [...PROTO_OPS],
    configSchema: [
      hostField,
      portField(23),
      { key: "username", label: "Integration username", type: "text", default: "lutron", secret: false },
      { key: "password", label: "Integration password", type: "password", default: "integration", secret: true },
    ],
  }),
  defineManifest({
    key: "supreme-coolmaster",
    name: "Supreme CoolMaster",
    description: "CoolAutomation CoolMasterNet/CoolLinux — VRF/VRV air-conditioning gateway (ASCII_IF + REST v2), with auto-discovery of indoor units, groups, water heaters, and ventilation.",
    category: "climate",
    channel: "official",
    publisher: PUBLISHER,
    version: "2.0.0",
    capabilities: ["onoff", "temperature", "fan"],
    protocols: ["coolmaster"],
    compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
    backend: { type: "native", ref: "coolmaster" },
    operations: [...PROTO_OPS],
    documentationUrl: "https://docs.supreme.local/extensions/coolmaster",
    releaseNotes:
      "Ground-up rewrite: dual ASCII_IF/REST v2 transport with automatic reconnect, full indoor-unit auto-discovery (no manual mapping), group/water-heater/ventilation support, and fan speed/swing/lock/inhibit exposed as advanced climate controls. See docs/coolmaster/README.md for architecture and limitations.",
    changelog: [
      { version: "2.0.0", date: "2026-07-11", notes: "Ground-up rewrite covering the full documented command surface, dual-transport (ASCII_IF + REST v2), auto-discovery of lines/units/groups/water-heaters/ventilation, and structured logging/reconnect. Replaces the prior ASCII_IF-only, onoff+temperature-only driver." },
    ],
    configSchema: [
      hostField,
      {
        key: "protocol",
        label: "Transport",
        type: "select",
        required: false,
        default: "auto",
        options: [
          { value: "auto", label: "Auto (prefer REST, fall back to ASCII_IF)" },
          { value: "ascii", label: "ASCII_IF only" },
          { value: "rest", label: "REST v2 only (status polling; commands still use ASCII_IF)" },
        ],
        secret: false,
      },
      { key: "asciiPort", label: "ASCII_IF port", type: "port", required: false, default: 10102, secret: false },
      { key: "restPort", label: "REST port", type: "port", required: false, default: 10103, secret: false },
      { key: "pollMs", label: "Poll interval (ms)", type: "number", required: false, default: 10_000, min: 2_000, secret: false },
      { key: "timeoutMs", label: "Request timeout (ms)", type: "number", required: false, default: 5_000, min: 1_000, secret: false },
      { key: "retryCount", label: "Retry count", type: "number", required: false, default: 3, min: 0, max: 10, secret: false },
      { key: "debug", label: "Debug logging", type: "boolean", required: false, default: false, secret: false },
    ],
  }),
  defineManifest({
    key: "supreme-avr",
    // § AVR Intelligent Manual Add — one brand-neutral extension in the Extension Center;
    // the manual-add wizard is what's brand-aware (routes to whichever real protocol
    // adapter — this one, or the separate Yamaha extension — actually matches what the
    // installer selects/what answers). The backend `ref`/`protocols` stay literally "avr"
    // (Denon/Marantz Telnet) since that's the one real implementation behind this listing
    // today — renaming the manifest never means claiming new brand support that doesn't
    // exist. See docs/architecture/AV-Adapter-Development-Guide.md for what a genuinely
    // new brand's protocol adapter would need before it could join this same listing.
    name: "AV Receivers",
    description: "Denon and Marantz AV receivers over the classic Telnet IP-control protocol.",
    category: "media",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "media"],
    protocols: ["avr"],
    compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
    backend: { type: "native", ref: "avr" },
    operations: [...PROTO_OPS],
    documentationUrl: "https://docs.supreme.local/extensions/avr",
    releaseNotes:
      "Real Denon/Marantz Telnet control: power, volume, mute, source, Zone 2 (as an independent device on the same connection), tone/DSP, sleep timer, and auto-reconnect. Each receiver is added by IP address through Bus Binding after enabling — there's nothing to configure here. Yamaha AVRs are supported through the separate Yamaha extension; the guided add wizard routes to whichever brand you pick automatically.",
    changelog: [
      { version: "1.0.0", date: "2026-07-10", notes: "First stable release: power/volume/media, Zone 2, tone/DSP, auto-reconnect (ADR 0015)." },
    ],
    configSchema: [],
  }),
  defineManifest({
    key: "supreme-heos",
    name: "Supreme HEOS",
    description: "Denon/Marantz whole-home streaming (HEOS) — multi-room audio and inputs.",
    category: "media",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["media"],
    protocols: ["heos"],
    compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
    backend: { type: "native", ref: "heos" },
    operations: [...PROTO_OPS],
    documentationUrl: "https://docs.supreme.local/extensions/heos",
    releaseNotes:
      "Real HEOS CLI control: one connection reaches every player on the network by pid, so bind as many rooms as you like once enabled. Transport, volume, mute, inputs, shuffle/repeat, now-playing, and play queue. Each player is added by IP + pid through Bus Binding after enabling.",
    changelog: [
      { version: "1.0.0", date: "2026-07-10", notes: "First stable release: multi-pid transport/volume/inputs/queue, auto-reconnect (ADR 0015)." },
    ],
    configSchema: [],
  }),
  defineManifest({
    key: "supreme-yamaha",
    name: "Supreme Yamaha (YXC/MusicCast)",
    description: "Yamaha Extended Control — standalone MusicCast streamers and MusicCast-enabled AVRs.",
    category: "media",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "media"],
    protocols: ["yamaha"],
    compat: { hubMinVersion: "0.1.0", requiresSku: "pro" },
    backend: { type: "native", ref: "yamaha" },
    operations: [...PROTO_OPS],
    documentationUrl: "https://docs.supreme.local/extensions/yamaha",
    releaseNotes:
      "Real Yamaha Extended Control: power, volume, mute, inputs, up to 4 zones per unit, sound program/tone via a genuine getFeatures dynamic-capability query, seek, and live UDP push events. Each unit (and each zone) is added by IP through Bus Binding after enabling.",
    changelog: [
      { version: "1.0.0", date: "2026-07-10", notes: "First stable release: multi-zone power/volume/media, getFeatures capability detection, push events (ADR 0015)." },
    ],
    configSchema: [],
  }),
  defineManifest({
    // Internal key kept stable as an API identifier; the user-facing name is Supreme-branded only —
    // the underlying compatibility bridge is never surfaced by name in the UI.
    key: "supreme-home-assistant",
    name: "Supreme Universal Bridge",
    description: "Bring devices from an existing compatible smart-home gateway into Supreme.",
    category: "other",
    channel: "official",
    publisher: PUBLISHER,
    version: "1.0.0",
    capabilities: ["onoff", "brightness", "color", "temperature", "position", "sensor"],
    protocols: [],
    compat: { hubMinVersion: "0.1.0", requiresSku: null },
    backend: { type: "ha-integration", ref: "core" },
    operations: [...PROTO_OPS],
    configSchema: [
      { key: "url", label: "Gateway URL", type: "text", required: true, placeholder: "http://gateway.local:8123", secret: false },
      { key: "token", label: "Access token", type: "password", required: true, secret: true },
    ],
  }),
];
