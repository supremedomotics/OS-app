import type { CapabilityKind } from "@supreme/domain-model";

/**
 * ETS import + automatic device generator (§3, §7). ETS (the KNX commissioning tool) exports a
 * project's group addresses — the real interchange installers hand over. Two documented shapes are
 * supported: the ETS "Group Addresses" CSV export and the `GroupAddress-Export` XML. Both list, per
 * address, a name, the group address, and its DPT.
 *
 * `parseEtsGroupAddresses` turns either into a flat model; `generateKnxDevices` folds those addresses
 * into Supreme devices with ready-to-bind KNX bindings — grouping a fixture's Switch/Dimming/Status
 * addresses together and deriving each capability from the DPT + name. The result maps 1:1 onto
 * {@link KnxProtocolDriver} bindings, so commissioning an ETS file yields working devices with no
 * hand-mapping. Pure functions — no I/O, fully unit-tested.
 */

export interface EtsGroupAddress {
  /** Human name from ETS, e.g. "Living Room Ceiling – Switch". */
  name: string;
  /** 3-level group address, e.g. "1/1/3". */
  address: string;
  /** Normalized DPT, e.g. "DPT1.001", or null when ETS left it unset. */
  dpt: string | null;
}

/** A binding the generator produced for a device capability (shape matches ProtocolBinding). */
export interface GeneratedKnxBinding {
  capability: CapabilityKind;
  /** Group address commands are written to. */
  address: string;
  config: { dpt: string; statusAddress?: string; measure?: string; unit?: string };
}

export interface GeneratedKnxDevice {
  /** Fixture name (the shared prefix of its group addresses). */
  name: string;
  capabilities: CapabilityKind[];
  bindings: GeneratedKnxBinding[];
}

/** Auto-detect CSV vs XML and parse an ETS group-address export into a flat address list. */
export function parseEtsGroupAddresses(content: string): EtsGroupAddress[] {
  return content.trimStart().startsWith("<") ? parseEtsXml(content) : parseEtsCsv(content);
}

// --- XML (`GroupAddress-Export`) ------------------------------------------------

function parseEtsXml(xml: string): EtsGroupAddress[] {
  const out: EtsGroupAddress[] = [];
  const elementRe = /<GroupAddress\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = elementRe.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    const name = attr(attrs, "Name");
    const rawAddress = attr(attrs, "Address");
    if (!rawAddress) continue;
    // The XML export carries the address as its integer value; CSV uses the slash form.
    const address = /^\d+$/.test(rawAddress) ? groupIntToTriplet(Number(rawAddress)) : rawAddress;
    out.push({ name: name ?? address, address, dpt: normalizeDpt(attr(attrs, "DPTs") ?? attr(attrs, "DatapointType")) });
  }
  return out;
}

function attr(attrs: string, key: string): string | undefined {
  const m = new RegExp(`${key}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m && m[1] !== undefined ? decodeXmlEntities(m[1]) : undefined;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// --- CSV ("Group Addresses" export) ---------------------------------------------

function parseEtsCsv(csv: string): EtsGroupAddress[] {
  const rows = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const first = rows[0];
  if (!first) return [];
  const sep = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const header = splitCsv(first, sep).map((h) => h.trim().toLowerCase());
  const hasHeader = header.some((h) => h.includes("address") || h.includes("group name"));
  const nameIdx = header.findIndex((h) => h.includes("name"));
  const addrIdx = header.findIndex((h) => h === "address" || h.includes("address"));
  const dptIdx = header.findIndex((h) => h.includes("datapoint") || h === "dpt" || h.includes("dpts"));

  const out: EtsGroupAddress[] = [];
  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    const cols = splitCsv(row, sep).map((c) => c.trim());
    const address = pick(cols, addrIdx) ?? cols.find((c) => /^\d+\/\d+\/\d+$/.test(c));
    // Skip main/middle range rows (no leaf 3-part address).
    if (!address || !/^\d+\/\d+\/\d+$/.test(address)) continue;
    out.push({
      name: pick(cols, nameIdx) ?? address,
      address,
      dpt: normalizeDpt(pick(cols, dptIdx)),
    });
  }
  return out;
}

function splitCsv(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function pick(cols: string[], idx: number): string | undefined {
  return idx >= 0 && idx < cols.length && cols[idx] !== "" ? cols[idx] : undefined;
}

// --- DPT normalization ----------------------------------------------------------

/** Normalize the many DPT spellings ETS emits into "DPT{main}.{sub}" (e.g. DPST-1-1 → DPT1.001). */
export function normalizeDpt(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // "DPST-1-1", "DPT-1", "DPST-9-1", "1.001", "1", "DPT1.001"
  let m = /DPS?T-(\d+)(?:-(\d+))?/i.exec(s);
  if (!m) m = /^DPT\s*(\d+)(?:\.(\d+))?$/i.exec(s);
  if (!m) m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const main = Number(m[1]);
  const sub = m[2] !== undefined ? Number(m[2]) : 0;
  return `DPT${main}.${String(sub).padStart(3, "0")}`;
}

/** Integer group-address value → 3-level "main/middle/sub". */
export function groupIntToTriplet(value: number): string {
  return `${(value >> 11) & 0x1f}/${(value >> 8) & 0x07}/${value & 0xff}`;
}

// --- device generation ----------------------------------------------------------

/** ETS function suffixes stripped to find a fixture's base name (many languages of the common set). */
const FUNCTION_SUFFIX =
  /[\s_-]*(status|state|switch|on\/?off|onoff|dimming|dim|brightness|value|position|pos|setpoint|temperature|temp|feedback|fb|rm)\b.*$/i;

const POSITION_HINT = /\b(blind|shade|shutter|cover|curtain|roller|jalousie|position)\b/i;
const STATUS_HINT = /\b(status|state|feedback|fb|rm)\b/i;

/** Fold ETS group addresses into Supreme devices with ready-to-bind KNX bindings. */
export function generateKnxDevices(addresses: EtsGroupAddress[]): GeneratedKnxDevice[] {
  const groups = new Map<string, EtsGroupAddress[]>();
  for (const ga of addresses) {
    const base = baseName(ga.name);
    const list = groups.get(base) ?? [];
    list.push(ga);
    groups.set(base, list);
  }

  const devices: GeneratedKnxDevice[] = [];
  for (const [base, gas] of groups) {
    const bindings = buildBindings(base, gas);
    if (bindings.length === 0) continue;
    devices.push({
      name: base,
      capabilities: [...new Set(bindings.map((b) => b.capability))],
      bindings,
    });
  }
  return devices;
}

function baseName(name: string): string {
  const stripped = name.replace(FUNCTION_SUFFIX, "").trim();
  return stripped.length > 0 ? stripped : name.trim();
}

function buildBindings(base: string, gas: EtsGroupAddress[]): GeneratedKnxBinding[] {
  // Split control vs status addresses so a capability's status GA feeds `statusAddress`.
  const status = gas.filter((g) => STATUS_HINT.test(g.name));
  const controls = gas.filter((g) => !STATUS_HINT.test(g.name));
  const byCap = new Map<CapabilityKind, GeneratedKnxBinding>();

  for (const ga of controls) {
    const cap = capabilityFor(ga, base);
    if (!cap || byCap.has(cap)) continue;
    const dpt = ga.dpt ?? defaultDptFor(cap);
    const binding: GeneratedKnxBinding = { capability: cap, address: ga.address, config: { dpt } };
    if (cap === "sensor") {
      binding.config.measure = "temperature";
      binding.config.unit = "°C";
    }
    const statusGa = status.find((s) => capabilityFor(s, base) === cap);
    if (statusGa) binding.config.statusAddress = statusGa.address;
    byCap.set(cap, binding);
  }
  return [...byCap.values()];
}

function capabilityFor(ga: EtsGroupAddress, base: string): CapabilityKind | null {
  const dptMain = ga.dpt ? Number(/DPT(\d+)/.exec(ga.dpt)?.[1]) : null;
  const positional = POSITION_HINT.test(ga.name) || POSITION_HINT.test(base);
  switch (dptMain) {
    case 1: // boolean: switch, or up/down for a shade
      return positional ? "position" : "onoff";
    case 3: // 4-bit dimming/blinds control step — not a bindable value
      return null;
    case 5: // 8-bit scaling 0..100 %: dimming value or shade position
      return positional ? "position" : "brightness";
    case 9: // 2-byte float: temperature / physical value
      return "sensor";
    default:
      // No DPT — fall back to the name.
      if (positional) return "position";
      if (/\bdim|bright/i.test(ga.name)) return "brightness";
      if (/\btemp/i.test(ga.name)) return "sensor";
      return "onoff";
  }
}

function defaultDptFor(cap: CapabilityKind): string {
  switch (cap) {
    case "brightness":
    case "position":
      return "DPT5.001";
    case "sensor":
      return "DPT9.001";
    default:
      return "DPT1.001";
  }
}
