/**
 * Universal Device Grouping (§ Supreme KNX Driver — "flagship SupremeOS feature").
 *
 * A protocol-agnostic circuit-name clustering engine: given a flat list of discovered
 * signals (a group address, a Matter endpoint, a Modbus register, an MQTT topic, a
 * Casambi fixture — anything with a human-readable name), groups the ones that are
 * really ONE physical device's different operations into a single cluster, by
 * stripping the trailing "what does this signal DO" word and comparing what's left.
 *
 * "Kitchen Light SW", "Kitchen Light STATUS", "Kitchen Light DIM", "Kitchen Light RGB",
 * "Kitchen Light CCT" → one cluster keyed on "kitchen light".
 *
 * This is deliberately name-only and protocol-agnostic — it knows nothing about group
 * addresses, ETS Functions, Matter clusters, or Modbus register maps. Any driver whose
 * discovery layer already has richer protocol-native structure (KNX's ETS Function/
 * Main-Group/Middle-Group hierarchy, for instance — see
 * `services/commissioning/src/knx/device-recognition-engine.ts`) should prefer that
 * richer signal first and use this engine as the generic fallback/baseline every
 * protocol gets for free, not a replacement for protocol-specific precision.
 */

/** Operation/role words that identify WHAT a signal does, not WHICH device it belongs
 * to — stripped from the end of a name before comparing. Matched whole-word, case-
 * insensitive. Extend this list; never hardcode a new protocol's own vocabulary here —
 * that belongs in the calling driver's own alias table (see {@link GroupingOptions}). */
export const DEFAULT_OPERATION_WORDS = [
  // on/off + generic control
  "sw", "switch", "onoff", "on", "off", "toggle", "trigger",
  // dimming / brightness
  "dim", "dimmer", "dimming", "brightness", "level",
  // color
  "rgb", "rgbw", "rgbww", "cct", "colour", "color", "hue", "saturation", "kelvin", "temp", "tw", "tunablewhite",
  // status/feedback
  "status", "stat", "feedback", "fb", "fdbk", "state", "readback", "rb",
  // position / covers
  "position", "pos", "updown", "up", "down", "stop", "move", "shutter", "blind", "curtain",
  // climate
  "setpoint", "sp", "ambient", "mode", "fanspeed", "fan", "swing", "heat", "cool",
  // sensors / metering
  "sensor", "value", "measure", "power", "energy", "voltage", "current", "counter",
  // misc
  "lock", "alarm", "presence", "occupancy", "button", "scene", "input", "output",
] as const;

export interface GroupingSignal {
  /** Stable id for this signal (a group address, endpoint id, register, topic, …). */
  id: string;
  /** Human-readable name as the protocol/discovery layer reports it. */
  name: string;
}

export interface GroupingOptions {
  /** Extra operation words specific to a protocol's own vocabulary (e.g. Modbus register
   * role names), merged with {@link DEFAULT_OPERATION_WORDS}. */
  extraOperationWords?: string[];
  /** Abbreviation → canonical word, applied to every token before operation-word
   * stripping (so "Sw" and "Switch" collapse to the same operation word, and a name-only
   * token like "Mstr" reads as "Master" when comparing circuit identity). */
  abbreviations?: Record<string, string>;
}

export interface DeviceCluster {
  /** The circuit/device identity every signal in this cluster shares (lowercase, the
   * grouping key — never shown to a user; re-derive a display name from the signals). */
  key: string;
  signals: GroupingSignal[];
}

function normalizeToken(token: string, abbreviations: Record<string, string>): string {
  const lower = token.toLowerCase();
  return (abbreviations[lower] ?? lower).toLowerCase();
}

/** Strip a trailing run of operation words from a tokenized name, leaving the circuit
 * identity. Operates from the END so "Kitchen Light Dim Status" (an operation word
 * followed by another) still reduces to "kitchen light", not just the last token. */
function stripTrailingOperationWords(tokens: string[], operationWords: Set<string>): string[] {
  const out = [...tokens];
  while (out.length > 1 && operationWords.has(out[out.length - 1]!)) out.pop();
  return out;
}

/**
 * Cluster a flat list of discovered signals into devices by circuit name, ignoring
 * operation suffixes. Case-insensitive, whitespace-insensitive (tokens are split on any
 * run of whitespace and rejoined with a single space), abbreviation-aware, operation-
 * aware. A single-token name with nothing left after stripping keeps at least one token,
 * so "Switch" alone (no circuit name at all) becomes its own single-signal cluster
 * rather than an empty key colliding with every other bare "Switch" in the project.
 */
export function groupByCircuitName(signals: GroupingSignal[], options: GroupingOptions = {}): DeviceCluster[] {
  const operationWords = new Set(
    [...DEFAULT_OPERATION_WORDS, ...(options.extraOperationWords ?? [])].map((w) => w.toLowerCase()),
  );
  const abbreviations = options.abbreviations ?? {};

  const byKey = new Map<string, GroupingSignal[]>();
  for (const signal of signals) {
    const tokens = signal.name
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !/^[-–—/|]+$/.test(t))
      .map((t) => normalizeToken(t, abbreviations));
    const circuitTokens = stripTrailingOperationWords(tokens, operationWords);
    const key = circuitTokens.length > 0 ? circuitTokens.join(" ") : signal.name.trim().toLowerCase();
    const list = byKey.get(key);
    if (list) list.push(signal);
    else byKey.set(key, [signal]);
  }

  return [...byKey.entries()].map(([key, sigs]) => ({ key, signals: sigs }));
}
