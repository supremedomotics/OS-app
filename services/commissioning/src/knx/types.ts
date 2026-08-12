import type { CapabilityKind, SupremeDeviceType } from "@supreme/domain-model";

/**
 * KNX Import Engine — shared type system (§ KNX Import Engine).
 *
 * The pipeline is: ets-parser/esf-parser/ga-export-parser (→ KnxProjectModel) →
 * device-recognition-engine (→ RecognizedDevice[]) → room-assignment-engine (fills
 * `.room`/`.floor`/`.building`) → entity-generator + device-card-generator (fills
 * `.supremeType`/bindings and produces the installer-facing card) → learning-store
 * (reconciles installer renames from a prior import) → index.ts orchestrates all of it
 * into a single `KnxImportResultV2`.
 */

// ── ETS project model — the parsed source of truth every stage reads from ──────────

/** Communication flags on a device's connection to a group address (R/W/T/U/C/I). */
export interface KnxComFlags {
  read: boolean;
  write: boolean;
  communicate: boolean;
  transmit: boolean;
  update: boolean;
  readOnInit: boolean;
}

export const DEFAULT_COM_FLAGS: KnxComFlags = {
  read: false,
  write: true,
  communicate: true,
  transmit: false,
  update: true,
  readOnInit: false,
};

/** A single ETS group address, with its full Main/Middle group context and metadata. */
export interface KnxGroupAddressRecord {
  /** ETS internal Id ("GA-xxxx") when the source carries one, else the address itself. */
  id: string;
  address: string; // "1/1/3"
  name: string;
  description: string | null;
  comment: string | null;
  dpt: string | null; // normalized "major.minor"
  mainGroup: string | null;
  middleGroup: string | null;
  /** Every communication object (device connection) referencing this GA, by id. */
  comObjectIds: string[];
}

/** One communication object instance on a device: its function ("Switch", "Status
 * Feedback", "Brightness"), DPT, flags, and the group address(es) it sends/receives on.
 *
 * § Critical Group Address Requirement (Production KNX Driver 2.0, cross-source merge
 * pass) — ETS's real `<Connectors>` structure distinguishes `<Send>` from `<Receive>`
 * GroupAddressRefs per comm object (confirmed in the real XML shape this parser reads);
 * collapsing both into one undifferentiated list (the original `groupAddressIds`)
 * discarded exactly the command-vs-feedback distinction this feature needs.
 * `sendGroupAddressIds`/`receiveGroupAddressIds` preserve that distinction;
 * `groupAddressIds` remains the union of both, unchanged in meaning, so every existing
 * consumer that only needs "which GAs does this comm object touch" is unaffected. */
export interface KnxCommunicationObject {
  id: string;
  deviceInstanceId: string;
  /** ETS "Number" — the manufacturer-assigned index of this object on the device. */
  number: number | null;
  /** The object's function text, e.g. "Switch", "Switch Feedback", "Brightness". */
  text: string;
  dpt: string | null;
  flags: KnxComFlags;
  /** Union of send + receive — backward-compatible with every pre-existing consumer. */
  groupAddressIds: string[];
  /** GAs this comm object WRITES to (ETS `<Send>`) — a command/write target. */
  sendGroupAddressIds: string[];
  /** GAs this comm object READS/LISTENS to (ETS `<Receive>`) — a feedback/status source. */
  receiveGroupAddressIds: string[];
}

/** A physical device placed on the bus (an ETS DeviceInstance). */
export interface KnxDeviceInstance {
  id: string;
  name: string;
  individualAddress: string | null;
  manufacturer: string | null;
  product: string | null;
  hardwareName: string | null;
  /** The Space (room/corridor/…) id this device is physically located in, when ETS placed it. */
  spaceId: string | null;
  comObjectIds: string[];
}

export type KnxSpaceType = "building" | "buildingpart" | "floor" | "room" | "corridor" | "stairway" | "other";

/** A node in the ETS Buildings/Locations tree (building → floor → room → …). */
export interface KnxSpace {
  id: string;
  type: KnxSpaceType;
  name: string;
  parentId: string | null;
  childIds: string[];
  deviceInstanceIds: string[];
}

/** A legacy/simplified device hint: ETS's `<Function>` element groups group-address refs
 * under one named function inside a room, without full Topology/DeviceInstance detail.
 * Some exports (or export options) carry only this — still a first-class grouping signal,
 * used when no richer `KnxCommunicationObject` data exists for the same addresses. */
export interface KnxFunctionGroup {
  id: string;
  name: string;
  spaceId: string | null;
  groupAddressIds: string[];
}

/** The fully parsed ETS project. Every downstream stage reads only from this model —
 * no stage re-parses XML/CSV text. */
export interface KnxProjectModel {
  projectName: string | null;
  spaces: Map<string, KnxSpace>;
  rootSpaceIds: string[];
  deviceInstances: Map<string, KnxDeviceInstance>;
  communicationObjects: Map<string, KnxCommunicationObject>;
  groupAddresses: Map<string, KnxGroupAddressRecord>;
  functions: Map<string, KnxFunctionGroup>;
}

export function emptyProjectModel(projectName: string | null = null): KnxProjectModel {
  return {
    projectName,
    spaces: new Map(),
    rootSpaceIds: [],
    deviceInstances: new Map(),
    communicationObjects: new Map(),
    groupAddresses: new Map(),
    functions: new Map(),
  };
}

// ── Recognition output ──────────────────────────────────────────────────────────

/**
 * The fine-grained device taxonomy the recognition engine classifies against — richer
 * than the small cross-protocol {@link SupremeDeviceType}. Carried through as
 * installer-facing metadata (icon/label/card) and mapped down to a real
 * `SupremeDeviceType` + capability bindings for commissioning — it never becomes a
 * capability of its own, so a device card can never claim a control the driver/bus
 * binding doesn't actually back.
 */
export const KNX_DEVICE_TYPES = [
  // Lighting
  "light_switch",
  "light_dimmable",
  "light_tunable_white",
  "light_rgb",
  "light_rgbw",
  "light_rgbww",
  "light_color_temp",
  // Covers
  "curtain",
  "blind",
  "roller_shutter",
  "garage_door",
  // HVAC
  "thermostat",
  "hvac_vrf",
  "hvac_split_ac",
  "hvac_cassette_ac",
  "hvac_duct_ac",
  "fan_coil",
  "fan",
  // Sensors
  "sensor_temperature",
  "sensor_humidity",
  "sensor_motion",
  "sensor_presence",
  "sensor_lux",
  "sensor_pressure",
  "sensor_co2",
  "sensor_pm25",
  "sensor_leak",
  "sensor_smoke",
  "sensor_door",
  "sensor_window",
  // Energy
  "energy_meter",
  // Scenes
  "scene",
  // Audio
  "audio",
  // Access / outdoor
  "gate",
  "door_lock",
  "irrigation",
  "pool",
  "ventilation",
  // Fallback — still commissioned with whatever capabilities were recognized, never dropped.
  "custom_device",
] as const;
export type KnxDeviceType = (typeof KNX_DEVICE_TYPES)[number];

/** One capability binding on a recognized device, tagged with the functional role that
 * earned it its capability (drives device-card-generator's control choices). */
export interface RecognizedBinding {
  capability: CapabilityKind;
  address: string;
  /** A separate feedback/status group address, when the source declared one distinct
   * from the write address (e.g. a "Switch" write GA + its own "Switch Feedback" GA) —
   * bound as the KNX driver's `statusAddress` so live state reflects the real feedback
   * telegram instead of only the optimistic post-command state. */
  statusAddress: string | null;
  /** The recognized role this address plays, e.g. "switch" | "brightness" | "red" |
   * "position_status" | "temperature_setpoint" — informational, not a capability of its own. */
  role: string;
  dpt: string | null;
}

export interface RecognizedDevice {
  /** Stable identity used by the learning engine to track renames across re-imports —
   * the source DeviceInstance id when available, else a hash of its sorted GA ids. */
  fingerprint: string;
  name: string;
  /** The original ETS-derived name, kept so a learned rename can always be reported
   * ("was 'Living Spot 1', now 'Dining Spot'") rather than silently overwritten. */
  sourceName: string;
  deviceType: KnxDeviceType;
  supremeType: SupremeDeviceType;
  room: string | null;
  floor: string | null;
  building: string | null;
  manufacturer: string | null;
  product: string | null;
  bindings: RecognizedBinding[];
  sourceGroupAddressIds: string[];
  sourceDeviceInstanceId: string | null;
  /** 0..1 — comm-object-backed recognition (real ETS device tree) is 1; name/DPT-only
   * clustering (flat GA export, no device tree) is lower. Surfaced so the installer can
   * prioritize review of low-confidence guesses. */
  confidence: number;
}

export type ImportWarningCode =
  | "duplicate_address"
  | "missing_dpt"
  | "unknown_dpt"
  | "broken_comm_object"
  | "orphan_address"
  | "unused_object"
  | "conflicting_device"
  | "unassigned_room";

export interface ImportWarning {
  code: ImportWarningCode;
  message: string;
  context?: Record<string, unknown>;
}

/** One control the review UI / runtime device card should render for a recognized
 * device type — always tied to a capability the device actually has bound. */
export interface DeviceCardControlSpec {
  kind:
    | "toggle"
    | "brightness_slider"
    | "color_wheel"
    | "color_temperature_slider"
    | "position_slider"
    | "open_close_stop"
    | "temperature_dial"
    | "mode_select"
    | "fan_select"
    | "swing_toggle"
    | "scene_tile"
    | "lock_toggle"
    | "value_readout"
    | "chart";
  capability: CapabilityKind;
}

export interface DeviceCardSpec {
  icon: string;
  controls: DeviceCardControlSpec[];
  quickActions: string[];
}

export interface ImportStats {
  groupAddressCount: number;
  deviceInstanceCount: number;
  recognizedDeviceCount: number;
  roomsFound: number;
  parseMs: number;
}

export interface KnxImportResultV2 {
  devices: RecognizedDevice[];
  warnings: ImportWarning[];
  stats: ImportStats;
}
