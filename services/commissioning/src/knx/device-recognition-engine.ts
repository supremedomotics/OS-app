import { classifyDpt, type DptCategory } from "./dpt-analyzer.js";
import { humanizeName, splitNameSegments } from "./name-cleanup.js";
import type {
  ImportWarning,
  KnxComFlags,
  KnxDeviceType,
  KnxGroupAddressRecord,
  KnxProjectModel,
  RecognizedBinding,
  RecognizedDevice,
} from "./types.js";

/**
 * Device Recognition Engine (§ Device Recognition Engine, § Recognition Priority). Turns
 * the flat set of parsed group addresses into complete, logical devices — never one
 * entity per group address.
 *
 * Two decisions happen here, using DIFFERENT signals on purpose:
 *
 *   1. CLUSTERING — which group addresses belong to the same physical/logical device.
 *      Driven by the shared base name across the addresses (after stripping the
 *      function word), exactly as ETS installers already name them: "Living Spot-1
 *      Switch" / "Living Spot-1 Switch Feedback" / "Living Spot-1 Relative Dimming" all
 *      share the base name "Living Spot-1". A single ETS `DeviceInstance` (the physical
 *      actuator module) commonly carries MANY independent channels/circuits — an 8-fold
 *      switch actuator is one DeviceInstance with 8 unrelated circuits — so grouping by
 *      DeviceInstance alone would wrongly merge independent devices. Name-proximity
 *      clustering is corroborated (not replaced) by DeviceInstance/comm-object data: a
 *      cluster whose addresses share one DeviceInstance gets full (1.0) confidence.
 *
 *   2. CLASSIFICATION — what KIND of device a cluster is. This DOES follow the
 *      documented priority order: communication objects (function text + flags) > DPT >
 *      Main Group > Middle Group > product > group-address name — evaluated over the
 *      full set of roles gathered for the cluster.
 *
 * Capability binding is honest about today's real limitation: Supreme's protocol-binding
 * model is one write/status group address per capability. A combined-DPT RGB/RGBW/colour-
 * temperature address, a single switch/dimmer/cover/lock/sensor address, or one HVAC
 * setpoint address all bind cleanly. Individual discrete RGB(W) channels and the
 * mode/fan/swing addresses of a multi-GA HVAC unit do NOT fit that model — rather than
 * fabricate a fused binding that would silently do the wrong thing, those addresses are
 * reported via `unused_object`/`orphan_address` warnings with their raw addresses, so the
 * installer can bind them individually in Bus Binding instead of losing them.
 */

// ── Role classification ─────────────────────────────────────────────────────────

/** Control/telemetry ROLE words to strip out of a device's own name. Deliberately
 * excludes device-TYPE nouns like "shutter"/"blind"/"curtain"/"fan" that legitimately
 * name the physical device itself ("the Shutter", "the Fan") — `looksLikeCover()` below
 * uses its own separate word list for cover CLASSIFICATION and is unaffected by this one. */
const FUNCTION_WORDS = new Set([
  "switch", "toggle", "on/off", "onoff", "on off", "status", "state", "feedback",
  "dim", "dimming", "brightness", "value", "level", "relative", "absolute",
  "position", "move", "up/down", "stop",
  "temperature", "temp", "setpoint", "current", "actual", "ambient", "mode", "swing",
  "lock", "unlock", "scene", "recall", "colour", "color", "rgb", "rgbw", "rgbww", "white",
]);

function looksLikeCover(text: string): boolean {
  return /(blind|shutter|shade|cover|curtain|awning|garage|gate)/.test(text);
}
function looksLikeDimmableLight(text: string): boolean {
  return /(dim|light|lamp|spot|downlight|led)/.test(text);
}

/** Normalize a raw comm-object/GA function label into a stable role tag used both for
 * capability inference and for the review-facing binding label. */
function classifyRole(dptCategory: DptCategory, roleText: string, mainGroup: string, gaName: string): string {
  const t = roleText.toLowerCase();
  const mg = mainGroup.toLowerCase();
  const n = gaName.toLowerCase();
  const context = `${t} ${mg} ${n}`;

  if (/\bred\b/.test(t)) return "red_channel";
  if (/\bgreen\b/.test(t)) return "green_channel";
  if (/\bblue\b/.test(t)) return "blue_channel";
  if (/warm\s*white|cool\s*white|\bwhite\b/.test(t) && dptCategory !== "color_rgbw") return "white_channel";

  if (dptCategory === "color_rgb") return "rgb";
  if (dptCategory === "color_rgbw") return "rgbw";
  if (dptCategory === "color_temperature_kelvin") return "color_temperature";
  if (dptCategory === "hvac_mode") return "hvac_mode";
  if (dptCategory === "hvac_fan_speed") return "hvac_fan_speed";
  if (dptCategory === "scene_control") return "scene";

  if (/\block\b|\bunlock\b/.test(t)) return /status|feedback|state/.test(t) ? "lock_status" : "lock";
  if (/swing/.test(t)) return "hvac_swing";
  if (/\bfan\b/.test(t) && /speed|level/.test(t)) return "hvac_fan_speed";
  if (/\bmode\b/.test(t) && /hvac|climate|heat|cool|thermostat|ac\b/.test(context)) return "hvac_mode";

  if (dptCategory === "binary_occupancy" || /occupan|presence|motion|\bpir\b/.test(t)) return "presence";
  if (dptCategory === "binary_windowdoor" || /\bwindow\b|\bdoor\b/.test(t)) return "window_door";
  if (/leak|flood/.test(t)) return "leak";
  if (/smoke|fire/.test(t)) return "smoke";
  if (dptCategory === "float_co2" || /co2|air.?quality/.test(t)) return "sensor_co2";
  if (dptCategory === "float_lux" || /\blux\b|illuminance/.test(t)) return "sensor_lux";
  if (dptCategory === "float_pressure" || /pressure/.test(t)) return "sensor_pressure";
  if (dptCategory === "float_humidity" || /humid/.test(t)) return "sensor_humidity";

  if (dptCategory === "float_temperature") {
    if (/set ?point|target|desired/.test(t)) return "temperature_setpoint";
    if (/current|actual|ambient|room/.test(t)) return "temperature_ambient";
    return "temperature_generic";
  }

  if (dptCategory === "counter_energy" || dptCategory === "float14_power") return "sensor_power";
  if (dptCategory === "float14_voltage") return "sensor_voltage";
  if (dptCategory === "float14_current") return "sensor_current";
  if (dptCategory === "counter_generic" || dptCategory === "float_generic" || dptCategory === "float14_generic") {
    return "sensor_generic";
  }

  const cover = looksLikeCover(context);
  if (cover) {
    if (/stop/.test(t)) return "stop";
    if (/status|feedback|state/.test(t)) return "position_status";
    if (dptCategory === "binary_updown" || /up.?down|move/.test(t)) return "updown";
    return "position";
  }

  if (dptCategory === "step_dimming" || (dptCategory === "percentage" && looksLikeDimmableLight(context))) {
    return /status|feedback|state/.test(t) ? "brightness_status" : "brightness";
  }
  if (dptCategory === "percentage") return /status|feedback|state/.test(t) ? "brightness_status" : "brightness";
  if (dptCategory === "binary_switch" || dptCategory === "binary_generic") {
    return /status|feedback|state/.test(t) ? "switch_status" : "switch";
  }
  if (dptCategory === "binary_alarm") return "alarm";

  return "unknown";
}

/** Roles this engine can honestly bind to ONE real Supreme capability today (see the
 * module docstring). Everything else is recognized/labeled but reported as unbound.
 * "updown"/"stop" (1-bit, DPT1.008/1.010) are deliberately excluded from `position`: the
 * codec's position writes are 0..100 percentages, byte-compatible only with a percentage
 * (DPT5.xxx) address — writing a percentage number to a 1-bit up/down GA would encode
 * wrong. A cover with only Up/Down/Stop and no percentage address isn't yet auto-bindable. */
const BINDABLE_CAPABILITY_BY_ROLE: Record<string, string> = {
  switch: "onoff",
  switch_status: "onoff",
  brightness: "brightness",
  brightness_status: "brightness",
  position: "position",
  position_status: "position",
  rgb: "color",
  rgbw: "color",
  color_temperature: "color",
  lock: "lock",
  lock_status: "lock",
  temperature_setpoint: "temperature",
  temperature_ambient: "temperature",
  temperature_generic: "temperature",
  sensor_co2: "sensor",
  sensor_lux: "sensor",
  sensor_pressure: "sensor",
  sensor_humidity: "sensor",
  sensor_power: "sensor",
  sensor_voltage: "sensor",
  sensor_current: "sensor",
  sensor_generic: "sensor",
  presence: "sensor",
  window_door: "sensor",
  leak: "sensor",
  smoke: "sensor",
  alarm: "sensor",
};

/** When two signals collide on the same non-sensor capability (a write GA + its status/
 * feedback GA, or a thermostat's setpoint + ambient), the lower-priority-number role wins
 * the ONE binding that capability. Deterministic — no reliance on XML declaration order. */
const ROLE_PRIORITY: Record<string, number> = {
  switch: 0,
  switch_status: 1,
  brightness: 0,
  brightness_status: 1,
  position: 0,
  position_status: 1,
  lock: 0,
  lock_status: 1,
  temperature_setpoint: 0,
  temperature_generic: 1,
  temperature_ambient: 2,
  rgb: 0,
  rgbw: 0,
  color_temperature: 0,
};

/** Roles representing an independent MEASUREMENT (not a write/status pair of the same
 * function) — a device can only hold one "sensor"-capability state slot (Supreme's
 * per-device state is keyed by capability kind), so when a cluster has more than one of
 * these, every one past the first becomes its OWN device rather than silently dropping
 * real data (see the module docstring "one binding per capability" limitation). */
const SENSOR_ROLES = new Set([
  "sensor_co2", "sensor_lux", "sensor_pressure", "sensor_humidity",
  "sensor_power", "sensor_voltage", "sensor_current", "sensor_generic",
  "presence", "window_door", "leak", "smoke", "alarm",
]);

const SENSOR_ROLE_LABEL: Record<string, string> = {
  sensor_co2: "CO₂",
  sensor_lux: "Illuminance",
  sensor_pressure: "Pressure",
  sensor_humidity: "Humidity",
  sensor_power: "Power",
  sensor_voltage: "Voltage",
  sensor_current: "Current",
  sensor_generic: "Sensor",
  presence: "Presence",
  window_door: "Window/Door",
  leak: "Leak",
  smoke: "Smoke",
  alarm: "Alarm",
};

// ── Clustering ───────────────────────────────────────────────────────────────────

interface GaSignal {
  ga: KnxGroupAddressRecord;
  category: DptCategory;
  role: string;
  roleText: string;
  flags: KnxComFlags | null;
  deviceInstanceId: string | null;
  functionId: string | null;
  functionName: string | null;
}

/** Strip every WORD that's a known function/role word (or a word from the matched role
 * text) out of each segment of an ETS name, leaving the device's own identity — "Living
 * Spot 1 - Switch Feedback" and "Living Spot 1 - Relative Dimming" both reduce to "Living
 * Spot 1" even though their function phrase is two words, not one. */
function deviceBaseName(gaName: string, roleText: string): string {
  const segments = splitNameSegments(gaName);
  const roleTokens = new Set(roleText.toLowerCase().split(/\s+/).filter(Boolean));
  const kept: string[] = [];
  for (const seg of segments) {
    const words = seg.split(/\s+/).filter(Boolean);
    const remaining = words.filter((w) => {
      const lc = w.toLowerCase();
      return !FUNCTION_WORDS.has(lc) && !roleTokens.has(lc);
    });
    if (remaining.length > 0) kept.push(remaining.join(" "));
  }
  const base = (kept.length > 0 ? kept : segments).join(" ").trim();
  return base || gaName;
}

function findRoomHint(gaName: string, knownRooms: { raw: string; lc: string }[]): string | null {
  const lc = gaName.toLowerCase();
  for (const r of knownRooms) if (lc.includes(r.lc)) return r.raw;
  return null;
}

/** When there's no comm-object Text to lean on, derive a role text from the GA name's
 * OWN trailing words that are recognized function words — not the whole last segment,
 * since a segment can mix device identity with its function word with no separator
 * between them ("Utility Switch" = device "Utility" + function "Switch", one segment).
 * Falls back to the whole last segment only when no trailing function word is found. */
function trailingFunctionWords(lastSegment: string): string {
  const words = lastSegment.split(/\s+/).filter(Boolean);
  let i = words.length;
  while (i > 0 && FUNCTION_WORDS.has(words[i - 1]!.toLowerCase())) i--;
  const trailing = words.slice(i);
  return trailing.length > 0 ? trailing.join(" ") : lastSegment;
}

function buildSignals(model: KnxProjectModel): GaSignal[] {
  const signals: GaSignal[] = [];
  // A GA can be referenced by >1 comm object (shared status address, rare); the FIRST is
  // used as the role/flags source — later ones don't change clustering.
  const comObjectByGa = new Map<string, string>();
  for (const co of model.communicationObjects.values()) {
    for (const gaId of co.groupAddressIds) if (!comObjectByGa.has(gaId)) comObjectByGa.set(gaId, co.id);
  }
  const functionByGa = new Map<string, string>();
  for (const fn of model.functions.values()) {
    for (const gaId of fn.groupAddressIds) if (!functionByGa.has(gaId)) functionByGa.set(gaId, fn.id);
  }

  for (const ga of model.groupAddresses.values()) {
    const dptClass = classifyDpt(ga.dpt);
    const coId = comObjectByGa.get(ga.id) ?? null;
    const co = coId ? model.communicationObjects.get(coId) ?? null : null;
    const fnId = functionByGa.get(ga.id) ?? null;
    const fn = fnId ? model.functions.get(fnId) ?? null : null;

    // Deliberately NOT `fn?.name` here: a Function's name is the DEVICE's own identity
    // ("Ceiling Light"), not a function/role word like a comm-object's Text ("Switch") —
    // using it as roleText would strip the wrong tokens out of every sibling GA's name in
    // deviceBaseName() below and defeat clustering. Function grouping is instead used
    // directly as an authoritative cluster key in clusterSignals().
    const roleText = co?.text || trailingFunctionWords(splitNameSegments(ga.name).at(-1) ?? ga.name);
    const role = classifyRole(dptClass.category, roleText, ga.mainGroup ?? "", ga.name);
    signals.push({
      ga,
      category: dptClass.category,
      role,
      roleText,
      flags: co?.flags ?? null,
      deviceInstanceId: co?.deviceInstanceId ?? null,
      functionId: fnId,
      functionName: fn?.name ?? null,
    });
  }
  return signals;
}

function clusterSignals(signals: GaSignal[], knownRoomNames: string[]): Map<string, GaSignal[]> {
  const rooms = knownRoomNames.map((r) => ({ raw: r, lc: r.toLowerCase() }));
  const clusters = new Map<string, GaSignal[]>();
  for (const sig of signals) {
    // A `<Function>` is ETS's OWN authoritative opinion about device boundaries (unlike
    // a DeviceInstance, one Function is always exactly one logical device) — used
    // directly as the cluster key rather than re-derived from names.
    let key: string;
    if (sig.functionId) {
      key = `fn:${sig.functionId}`;
    } else {
      const base = deviceBaseName(sig.ga.name, sig.roleText);
      const room = findRoomHint(sig.ga.name, rooms);
      key = `name:${room ?? ""}::${base.toLowerCase()}`;
    }
    const list = clusters.get(key);
    if (list) list.push(sig);
    else clusters.set(key, [sig]);
  }
  return clusters;
}

// ── Device type classification ────────────────────────────────────────────────────

/** Classify a cluster's device type from the SET of roles present, following the
 * documented priority: comm-object/DPT-derived roles first, then Main Group, then
 * product, then the raw name — each tier only breaks ties the previous tier left open. */
function classifyDeviceType(roles: Set<string>, mainGroups: Set<string>, product: string | null, baseName: string): KnxDeviceType {
  const mg = [...mainGroups].join(" ").toLowerCase();
  const name = baseName.toLowerCase();
  const prod = (product ?? "").toLowerCase();
  const context = `${mg} ${name} ${prod}`;

  // Lighting
  if (roles.has("rgbw") || (roles.has("red_channel") && roles.has("white_channel"))) return "light_rgbww";
  if (roles.has("rgb") || (roles.has("red_channel") && roles.has("green_channel") && roles.has("blue_channel"))) return "light_rgb";
  if (roles.has("color_temperature") && roles.has("brightness")) return "light_tunable_white";
  if (roles.has("color_temperature")) return "light_color_temp";
  if (roles.has("brightness") || roles.has("brightness_status")) return "light_dimmable";

  // Covers
  if (roles.has("position") || roles.has("updown") || roles.has("stop") || roles.has("position_status")) {
    if (/garage/.test(context)) return "garage_door";
    if (/gate/.test(context)) return "gate";
    if (/shutter|roller/.test(context)) return "roller_shutter";
    if (/blind/.test(context)) return "blind";
    return "curtain";
  }

  // HVAC
  if (roles.has("temperature_setpoint") || roles.has("temperature_ambient") || roles.has("hvac_mode") || roles.has("hvac_fan_speed") || roles.has("hvac_swing")) {
    if (/vrf/.test(context)) return "hvac_vrf";
    if (/cassette/.test(context)) return "hvac_cassette_ac";
    if (/duct/.test(context)) return "hvac_duct_ac";
    if (/fan.?coil/.test(context)) return "fan_coil";
    if (/split|\bac\b|air.?con/.test(context)) return "hvac_split_ac";
    return "thermostat";
  }
  if (roles.has("fan_speed_percentage") || /\bfan\b/.test(context)) return "fan";

  // Access / outdoor
  if (roles.has("lock") || roles.has("lock_status")) return "door_lock";
  if (/irrigation|sprinkler|valve/.test(context)) return "irrigation";
  if (/pool|spa|jacuzzi/.test(context)) return "pool";
  if (/ventilat|extract|mvhr/.test(context)) return "ventilation";
  if (/audio|speaker|amplifier|zone.?player/.test(context)) return "audio";

  // Sensors
  if (roles.has("presence")) return "sensor_presence";
  if (roles.has("window_door")) return "sensor_window";
  if (roles.has("leak")) return "sensor_leak";
  if (roles.has("smoke")) return "sensor_smoke";
  if (roles.has("sensor_co2")) return "sensor_co2";
  if (roles.has("sensor_lux")) return "sensor_lux";
  if (roles.has("sensor_pressure")) return "sensor_pressure";
  if (roles.has("sensor_humidity")) return "sensor_humidity";
  if (roles.has("sensor_power") || roles.has("sensor_voltage") || roles.has("sensor_current")) return "energy_meter";
  if (roles.has("temperature_generic") && roles.size === 1) return "sensor_temperature";

  // Scenes
  if (roles.has("scene")) return "scene";

  // Plain lighting fallback (switch-only) — checked after covers/HVAC/locks so a plain
  // "Switch" role on a cover/lock/irrigation circuit isn't mis-typed as a light.
  if (roles.has("switch") || roles.has("switch_status")) {
    if (/irrigation|sprinkler|valve/.test(context)) return "irrigation";
    if (/pool|spa/.test(context)) return "pool";
    if (/ventilat|extract/.test(context)) return "ventilation";
    return "light_switch";
  }

  return "custom_device";
}

/** The small cross-protocol `SupremeDeviceType` a fine-grained {@link KnxDeviceType} maps
 * down to for commissioning — see packages/domain-model's `SupremeDeviceType` enum. */
const SUPREME_TYPE_BY_KNX_TYPE: Record<KnxDeviceType, string> = {
  light_switch: "switch",
  light_dimmable: "dimmer",
  light_tunable_white: "color_light",
  light_rgb: "color_light",
  light_rgbw: "color_light",
  light_rgbww: "color_light",
  light_color_temp: "color_light",
  curtain: "cover",
  blind: "cover",
  roller_shutter: "cover",
  garage_door: "cover",
  thermostat: "thermostat",
  hvac_vrf: "thermostat",
  hvac_split_ac: "thermostat",
  hvac_cassette_ac: "thermostat",
  hvac_duct_ac: "thermostat",
  fan_coil: "thermostat",
  fan: "fan",
  sensor_temperature: "sensor",
  sensor_humidity: "sensor",
  sensor_motion: "sensor",
  sensor_presence: "sensor",
  sensor_lux: "sensor",
  sensor_pressure: "sensor",
  sensor_co2: "sensor",
  sensor_pm25: "sensor",
  sensor_leak: "sensor",
  sensor_smoke: "sensor",
  sensor_door: "sensor",
  sensor_window: "sensor",
  energy_meter: "sensor",
  scene: "switch",
  audio: "media_player",
  gate: "cover",
  door_lock: "lock",
  irrigation: "switch",
  pool: "switch",
  ventilation: "fan",
  custom_device: "switch",
};

// ── Public entry point ──────────────────────────────────────────────────────────

export interface RecognitionResult {
  devices: RecognizedDevice[];
  warnings: ImportWarning[];
}

export function recognizeDevices(model: KnxProjectModel, knownRoomNames: string[] = []): RecognitionResult {
  const warnings: ImportWarning[] = [];
  const signals = buildSignals(model);
  const clusters = clusterSignals(signals, knownRoomNames);
  const devices: RecognizedDevice[] = [];

  // Duplicate addresses: the same physical address string parsed under >1 GA id.
  const seenAddresses = new Map<string, string>();
  for (const ga of model.groupAddresses.values()) {
    const prior = seenAddresses.get(ga.address);
    if (prior && prior !== ga.id) {
      warnings.push({
        code: "duplicate_address",
        message: `Group address ${ga.address} appears more than once ("${ga.name}").`,
        context: { address: ga.address },
      });
    } else {
      seenAddresses.set(ga.address, ga.id);
    }
  }
  for (const ga of model.groupAddresses.values()) {
    if (!ga.dpt) {
      warnings.push({ code: "missing_dpt", message: `${ga.name} (${ga.address}) has no datapoint type.`, context: { address: ga.address } });
    } else if (classifyDpt(ga.dpt).category === "unknown") {
      warnings.push({ code: "unknown_dpt", message: `${ga.name} (${ga.address}) has an unrecognized DPT "${ga.dpt}".`, context: { address: ga.address, dpt: ga.dpt } });
    }
  }
  for (const co of model.communicationObjects.values()) {
    if (co.groupAddressIds.length === 0) {
      warnings.push({ code: "broken_comm_object", message: `Communication object "${co.text || co.id}" has no Send/Receive group address.`, context: { comObjectId: co.id } });
    }
  }

  for (const sigs of clusters.values()) {
    const roles = new Set(sigs.map((s) => s.role));
    const mainGroups = new Set(sigs.map((s) => s.ga.mainGroup).filter((v): v is string => !!v));
    const deviceInstanceIds = new Set(sigs.map((s) => s.deviceInstanceId).filter((v): v is string => !!v));
    const soleDeviceInstance = deviceInstanceIds.size === 1 ? model.deviceInstances.get([...deviceInstanceIds][0]!) ?? null : null;
    const product = soleDeviceInstance?.product ?? null;
    const manufacturer = soleDeviceInstance?.manufacturer ?? null;
    // A Function-backed cluster uses ETS's own device name directly; a name-clustered
    // one recomputes the same base name every member converged on (deterministic, since
    // that's how they ended up in the same cluster in the first place).
    const rawBaseName = sigs.find((s) => s.functionName)?.functionName ?? deviceBaseName(sigs[0]!.ga.name, sigs[0]!.roleText);
    const humanBaseName = humanizeName(rawBaseName);

    const deviceType = classifyDeviceType(roles, mainGroups, product, rawBaseName);
    const sourceDeviceInstanceId = deviceInstanceIds.size === 1 ? [...deviceInstanceIds][0]! : null;
    const confidence = sourceDeviceInstanceId ? 1 : deviceInstanceIds.size > 0 ? 0.8 : 0.6;

    // "sensor" is the one capability a device can hold at most one of that regularly
    // co-occurs with several independent real measurements on the same cluster (an
    // energy meter's Power/Voltage/Current) — every measurement past the first becomes
    // its own device (see SENSOR_ROLES doc) instead of silently dropping real data.
    const sensorSigs = sigs.filter((s) => SENSOR_ROLES.has(s.role) && !!BINDABLE_CAPABILITY_BY_ROLE[s.role]);
    const primarySigs = sigs.filter((s) => !sensorSigs.includes(s));

    const { bindings, excluded } = collapseToOneBindingPerCapability(primarySigs);

    const extraSensorSigs = [...sensorSigs];
    if (extraSensorSigs.length > 0 && bindings.length > 0) {
      // A primary (non-sensor) device exists — it can absorb exactly one sensor reading
      // as an additional real capability (e.g. a switch actuator with a built-in temp
      // sensor); the rest split off below.
      const first = extraSensorSigs.shift()!;
      bindings.push(toBinding(first));
    }

    if (bindings.length === 0 && extraSensorSigs.length === 0) {
      if (excluded.length > 0) emitUnboundWarning(warnings, humanBaseName, excluded, "orphan_address");
      continue; // nothing left to commission
    }
    if (bindings.length > 0) {
      emitUnboundWarning(warnings, humanBaseName, excluded, "unused_object");
      devices.push(
        buildRecognizedDevice(humanBaseName, rawBaseName, deviceType, bindings, sigs, sourceDeviceInstanceId, confidence, manufacturer, product),
      );
    } else if (excluded.length > 0) {
      // No primary device formed (e.g. a pure HVAC mode/fan cluster with no setpoint) —
      // still report what wasn't bound.
      emitUnboundWarning(warnings, humanBaseName, excluded, "orphan_address");
    }

    // Split-off devices: one per remaining independent sensor measurement.
    for (const sig of extraSensorSigs) {
      const label = SENSOR_ROLE_LABEL[sig.role] ?? sig.roleText;
      devices.push(
        buildRecognizedDevice(
          `${humanBaseName} — ${label}`,
          `${rawBaseName} ${label}`,
          deviceType,
          [toBinding(sig)],
          [sig],
          sourceDeviceInstanceId,
          confidence,
          manufacturer,
          product,
        ),
      );
    }
  }

  return { devices, warnings };
}

/** Roles that should be threaded through as a binding's `statusAddress` (a separate live
 * feedback telegram) rather than discarded once a same-capability winner is chosen —
 * either an explicit "_status"/"_feedback" role, or "temperature_ambient" specifically:
 * pairing it as the STATUS side of a "temperature_setpoint" WRITE winner means reads
 * reflect the real ambient temperature while commands still write the real setpoint. */
function isStatusRole(role: string): boolean {
  return role.endsWith("_status") || role === "temperature_ambient";
}

function toBinding(sig: GaSignal, statusAddress: string | null = null): RecognizedBinding {
  const capability = BINDABLE_CAPABILITY_BY_ROLE[sig.role]!;
  return {
    capability: capability as RecognizedBinding["capability"],
    address: sig.ga.address,
    statusAddress: statusAddress && statusAddress !== sig.ga.address ? statusAddress : null,
    role: sig.role,
    dpt: sig.ga.dpt,
  };
}

/** One binding per capability: when two+ signals collide on the same capability,
 * {@link ROLE_PRIORITY} deterministically picks the write/primary winner; a status-role
 * signal among the rest becomes that binding's `statusAddress` rather than being
 * discarded. Any further collisions beyond one write + one status are reported excluded. */
function collapseToOneBindingPerCapability(sigs: GaSignal[]): { bindings: RecognizedBinding[]; excluded: GaSignal[] } {
  const bindings: RecognizedBinding[] = [];
  const excluded: GaSignal[] = [];
  const byCapability = new Map<string, GaSignal[]>();

  for (const sig of sigs) {
    const capability = BINDABLE_CAPABILITY_BY_ROLE[sig.role];
    if (!capability) {
      excluded.push(sig);
      continue;
    }
    const list = byCapability.get(capability);
    if (list) list.push(sig);
    else byCapability.set(capability, [sig]);
  }

  for (const list of byCapability.values()) {
    const sorted = [...list].sort((a, b) => (ROLE_PRIORITY[a.role] ?? 0) - (ROLE_PRIORITY[b.role] ?? 0));
    const winner = sorted[0]!;
    const statusCandidate = sorted.find((s) => s !== winner && isStatusRole(s.role)) ?? null;
    bindings.push(toBinding(winner, statusCandidate?.ga.address ?? null));
    for (const s of sorted) if (s !== winner && s !== statusCandidate) excluded.push(s);
  }
  return { bindings, excluded };
}

function emitUnboundWarning(warnings: ImportWarning[], deviceName: string, excluded: GaSignal[], code: "unused_object" | "orphan_address"): void {
  if (excluded.length === 0) return;
  const addresses = excluded.map((s) => `${s.ga.address} (${s.roleText || s.ga.name})`);
  warnings.push({
    code,
    message: `"${deviceName}": ${excluded.length} address${excluded.length === 1 ? "" : "es"} not auto-bound — ${addresses.join(", ")}. Bind these individually in Bus Binding.`,
    context: { device: deviceName, addresses: excluded.map((s) => s.ga.address) },
  });
}

function buildRecognizedDevice(
  name: string,
  sourceName: string,
  deviceType: KnxDeviceType,
  bindings: RecognizedBinding[],
  sigs: GaSignal[],
  sourceDeviceInstanceId: string | null,
  confidence: number,
  manufacturer: string | null,
  product: string | null,
): RecognizedDevice {
  return {
    fingerprint: sourceDeviceInstanceId
      ? `di:${sourceDeviceInstanceId}:${bindings.map((b) => b.role).sort().join(",")}`
      : `ga:${sigs.map((s) => s.ga.id).sort().join(",")}`,
    name,
    sourceName,
    deviceType,
    supremeType: (SUPREME_TYPE_BY_KNX_TYPE[deviceType] ?? "switch") as RecognizedDevice["supremeType"],
    room: null,
    floor: null,
    building: null,
    manufacturer,
    product,
    bindings,
    sourceGroupAddressIds: sigs.map((s) => s.ga.id),
    sourceDeviceInstanceId,
    confidence,
  };
}
