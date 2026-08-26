import { normalizeDpt } from "./dpt-analyzer.js";
import { addressFromInt } from "./zip-reader.js";
import {
  emptyProjectModel,
  type KnxComFlags,
  type KnxCommunicationObject,
  type KnxDeviceInstance,
  type KnxFunctionGroup,
  type KnxGroupAddressRecord,
  type KnxProjectModel,
  type KnxSpace,
  type KnxSpaceType,
} from "./types.js";

/**
 * ETS Project Parser (§ Supported Import Formats, § Group Address Parsing). Reads the
 * unzipped `.knxproj` XML into a full {@link KnxProjectModel} — building tree, device
 * instances, communication objects (with flags), and every group-address field (DPT,
 * Main/Middle Group, description, comment). This is the ONLY stage that touches raw XML;
 * every later stage (recognition, room assignment, entity/card generation) reads the model.
 *
 * A real ETS export mixes two levels of fidelity:
 *   - Rich exports carry `<Topology>` (Area/Line/DeviceInstance/ComObjectInstanceRef with
 *     Send/Receive connectors and R/W/T/U/C flags) — the strongest recognition signal.
 *   - Lighter exports carry only `<Locations>` `<Function>` elements grouping group-address
 *     refs under a named function, with no per-object flags/DPT detail.
 * Both are parsed and kept side by side (`communicationObjects` vs. `functions`); the
 * device recognition engine prefers the richer one when both exist for the same addresses.
 *
 * Parsing is a small, fixed number of single-pass regex scans over the same XML string
 * (not a DOM tree) — O(n) in document size regardless of group-address count, so a
 * 20,000+ GA / 5,000+ device project parses in well under a second of pure parse time.
 */

function attr(s: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(s);
  return m ? (m[1] ?? null) : null;
}

function boolAttr(s: string, name: string, defaultValue: boolean): boolean {
  const v = attr(s, name);
  if (v === null) return defaultValue;
  return /^(enabled|true|1)$/i.test(v);
}

function normalizeAddress(raw: string): string {
  return /^\d+\/\d+\/\d+$/.test(raw) ? raw : addressFromInt(Number(raw));
}

function spaceType(raw: string | null): KnxSpaceType {
  const t = (raw ?? "").toLowerCase();
  if (t === "building") return "building";
  if (t === "buildingpart" || t === "distributionboard") return "buildingpart";
  if (t === "floor") return "floor";
  if (t === "room" || t === "flat") return "room";
  if (t === "corridor") return "corridor";
  if (t === "stairway") return "stairway";
  return "other";
}

/** Concatenate every `.xml` member of the unzipped project (there's usually exactly one
 * `P-xxxx/0.xml` installation file plus a `project.xml`; some exports split further). */
function concatXml(files: Map<string, Buffer>): string {
  let xml = "";
  for (const [name, buf] of files) {
    if (name.toLowerCase().endsWith(".xml")) xml += `${buf.toString("utf8")}\n`;
  }
  return xml;
}

/** Project display name, from `<ProjectInformation Name="…">` when present. */
function parseProjectName(xml: string): string | null {
  const m = /<ProjectInformation\b([^>]*?)\/?>/.exec(xml);
  return m ? attr(m[1] ?? "", "Name") : null;
}

/** Best-effort manufacturer/product id → friendly-name lookup, from whatever catalog data
 * the export happens to bundle (`<Manufacturer Id="M-xxxx" Name="…">`, `<Hardware Id="…"
 * Name="…">`). Absent when the export doesn't include catalog files — callers fall back to
 * the raw id, never a fabricated name. */
function parseCatalogNames(xml: string): { manufacturers: Map<string, string>; products: Map<string, string> } {
  const manufacturers = new Map<string, string>();
  const products = new Map<string, string>();
  const mfRe = /<Manufacturer\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = mfRe.exec(xml))) {
    const a = m[1] ?? "";
    const id = attr(a, "Id");
    const name = attr(a, "Name") ?? attr(a, "ShortName");
    if (id && name) manufacturers.set(id, name);
  }
  const prodRe = /<(?:Hardware|Product)\b([^>]*?)\/?>/g;
  while ((m = prodRe.exec(xml))) {
    const a = m[1] ?? "";
    const id = attr(a, "Id");
    const name = attr(a, "Name") ?? attr(a, "Text");
    if (id && name) products.set(id, name);
  }
  return { manufacturers, products };
}

/** Resolve a `ProductRefId` like "M-0083_H-1234-1-1_P-5678" to its manufacturer id
 * ("M-0083") for a catalog lookup. */
function manufacturerIdFromProductRef(productRefId: string | null): string | null {
  if (!productRefId) return null;
  const m = /^(M-[0-9A-Za-z]+)/.exec(productRefId);
  return m ? m[1]! : null;
}

interface CatalogComObjectDef {
  number: number | null;
  text: string;
  dpt: string | null;
  flags: KnxComFlags;
}

/** § Real ETS5 export compatibility — application-program catalog cross-reference. In
 * this real ETS5 export shape, `<DeviceInstance><ComObjectInstanceRef RefId="O-0_R-1"
 * Links="…"/>` carries NO per-object Number/FunctionText/DatapointType/flags at all —
 * that metadata lives ONLY in the manufacturer's application-program catalog file
 * (`M-xxxx/M-xxxx_A-....xml`, `<ComObject Id="{program}_O-0" Number="0"
 * FunctionText="…" DatapointType="…" ReadFlag="…" WriteFlag="…" TransmitFlag="…" …/>`),
 * reached via `DeviceInstance.Hardware2ProgramRefId` → `Hardware.xml`'s
 * `<Hardware2Program Id="…"><ApplicationProgramRef RefId="{program}"/></Hardware2Program>`
 * → that program's own `ComObject` table. Confirmed against a real project: without this
 * cross-reference, every real signal's DPT/text/flags were null/empty, and — critically —
 * the multi-channel dimmer example this whole architecture is validated against
 * (§ "Physical Device + Functional Channel") had no `FunctionText` to extract a channel
 * number from at all, so its 3 independent outputs would have silently collapsed into
 * ONE logical device instead of three. This resolves that gap using only real, present
 * ETS metadata — never fabricated when a device's application program isn't bundled in
 * the export (falls through to whatever the instance-level attributes already gave, same
 * as before this cross-reference existed). */
function parseApplicationProgramCatalog(xml: string): {
  hardware2Program: Map<string, string>;
  comObjectDefs: Map<string, CatalogComObjectDef>;
} {
  const hardware2Program = new Map<string, string>();
  const h2pRe = /<Hardware2Program\b([^>]*?)>([\s\S]*?)<\/Hardware2Program>/g;
  let m: RegExpExecArray | null;
  while ((m = h2pRe.exec(xml))) {
    const id = attr(m[1] ?? "", "Id");
    const refMatch = /<ApplicationProgramRef\b([^>]*?)\/?>/.exec(m[2] ?? "");
    const programRef = refMatch ? attr(refMatch[1] ?? "", "RefId") : null;
    if (id && programRef) hardware2Program.set(id, programRef);
  }

  const comObjectDefs = new Map<string, CatalogComObjectDef>();
  const coDefRe = /<ComObject\b([^>]*?)\/?>/g;
  while ((m = coDefRe.exec(xml))) {
    const a = m[1] ?? "";
    const id = attr(a, "Id");
    if (!id) continue;
    // `Name` (e.g. "<Output 1> Relay Command") carries the channel/output marker;
    // `FunctionText` (e.g. "Off/On") is the generic function description. Both are kept
    // — channel extraction and capability/role text-heuristics each need a different one.
    const name = attr(a, "Name") ?? "";
    const functionText = attr(a, "FunctionText") ?? "";
    comObjectDefs.set(id, {
      number: attr(a, "Number") !== null ? Number(attr(a, "Number")) : null,
      text: [name, functionText].filter(Boolean).join(" ") || (attr(a, "Text") ?? ""),
      dpt: normalizeDpt(attr(a, "DatapointType")),
      flags: parseFlags(a),
    });
  }
  return { hardware2Program, comObjectDefs };
}

/** 1. Group addresses — tracks the enclosing `<GroupRange>` stack (Main/Middle Group). */
function parseGroupAddresses(xml: string, model: KnxProjectModel): void {
  const groupRangeStack: string[] = [];
  const re = /<(\/?)(GroupRange|GroupAddress)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const close = m[1] === "/";
    const tag = m[2]!;
    const a = m[3] ?? "";
    const selfClose = m[4] === "/";

    if (tag === "GroupRange") {
      if (close) {
        if (groupRangeStack.length) groupRangeStack.pop();
      } else {
        groupRangeStack.push(attr(a, "Name") ?? "");
        if (selfClose) groupRangeStack.pop();
      }
      continue;
    }

    const id = attr(a, "Id");
    const addrRaw = attr(a, "Address");
    if (!id || !addrRaw) continue;
    model.groupAddresses.set(id, {
      id,
      address: normalizeAddress(addrRaw),
      name: attr(a, "Name") ?? addrRaw,
      description: attr(a, "Description"),
      comment: attr(a, "Comment"),
      dpt: normalizeDpt(attr(a, "DatapointType") ?? attr(a, "DPTs")),
      mainGroup: groupRangeStack[0] || null,
      middleGroup: groupRangeStack[1] || null,
      comObjectIds: [],
    });
  }
}

/** 2. Topology — Area/Line/DeviceInstance/ComObjectInstanceRef/Connectors, the richest
 * recognition signal when present. */
function parseTopology(
  xml: string,
  model: KnxProjectModel,
  catalog: ReturnType<typeof parseCatalogNames>,
  appProgramCatalog: ReturnType<typeof parseApplicationProgramCatalog>,
): void {
  // § Real ETS5 export compatibility — `<GroupAddress>` elements are declared with a
  // fully installation-scoped Id ("P-08C0-0_GA-302"), but a `<ComObjectInstanceRef
  // Links="GA-302 …">` reference uses the bare local suffix ("GA-302") — confirmed
  // against two real ETS5 projects, where every Links= reference otherwise resolved to
  // nothing (0 of 1,718 / 0 of 438 group addresses got a comm-object backlink). Resolve
  // by exact id first, falling back to a suffix index built once here — never guessed
  // beyond an exact trailing-token match.
  const gaIdBySuffix = new Map<string, string>();
  for (const id of model.groupAddresses.keys()) {
    const suffix = /(GA-\d+)$/.exec(id)?.[1];
    if (suffix && !gaIdBySuffix.has(suffix)) gaIdBySuffix.set(suffix, id);
  }
  const resolveGaId = (rawRef: string): string | null =>
    (model.groupAddresses.has(rawRef) ? rawRef : gaIdBySuffix.get(rawRef)) ?? null;

  // § Physical Device Identity — a `<DeviceInstance Address="N">`'s `Address` is only
  // the device's position WITHIN its enclosing `<Line>`, itself positioned within an
  // `<Area>` (standard KNX "area.line.device" individual-address structure) — never a
  // complete individual address on its own. Confirmed against a real multi-area/
  // multi-line ETS5 project: reading `DeviceInstance`'s `Address` in isolation produced
  // bare digits ("1") that collide across every line's first device, corrupting the one
  // identity this entire architecture is anchored on. Area/Line form a simple stack —
  // Line always nests inside Area, never itself nested — tracked the same way
  // `parseGroupAddresses` already tracks its `GroupRange` stack.
  const tagRe = /<(\/?)(Area|Line|DeviceInstance|ComObjectInstanceRef|Connectors|Send|Receive)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let device: KnxDeviceInstance | null = null;
  let comObject: KnxCommunicationObject | null = null;
  let inConnectors = false;
  let currentArea: string | null = null;
  let currentLine: string | null = null;

  while ((m = tagRe.exec(xml))) {
    const close = m[1] === "/";
    const tag = m[2]!;
    const a = m[3] ?? "";
    const selfClose = m[4] === "/";

    if (tag === "Area") {
      if (close) currentArea = null;
      else if (selfClose) currentArea = null; // empty Area (no Line/DeviceInstance children) — nothing to inherit it
      else currentArea = attr(a, "Address");
      continue;
    }
    if (tag === "Line") {
      if (close) currentLine = null;
      else if (selfClose) currentLine = null; // empty Line (no DeviceInstance children)
      else currentLine = attr(a, "Address");
      continue;
    }

    if (tag === "DeviceInstance") {
      if (close) {
        if (device) model.deviceInstances.set(device.id, device);
        device = null;
        continue;
      }
      const id = attr(a, "Id");
      if (!id) continue;
      const productRefId = attr(a, "ProductRefId");
      const manufacturerId = manufacturerIdFromProductRef(productRefId);
      const deviceAddr = attr(a, "Address");
      const individualAddress = deviceAddr && /^\d+\.\d+\.\d+$/.test(deviceAddr)
        ? deviceAddr // already a complete "area.line.device" address — some exports write it this way directly
        : currentArea !== null && currentLine !== null && deviceAddr !== null
          ? `${currentArea}.${currentLine}.${deviceAddr}`
          : deviceAddr; // no enclosing Area/Line context (e.g. a partial fixture) — best-effort, never fabricated beyond what's known
      device = {
        id,
        name: attr(a, "Name") ?? "Device",
        individualAddress,
        manufacturer: (manufacturerId && catalog.manufacturers.get(manufacturerId)) || manufacturerId,
        product: (productRefId && catalog.products.get(productRefId)) || attr(a, "Name"),
        hardwareName: attr(a, "Hardware2ProgramRefId"),
        spaceId: null,
        comObjectIds: [],
      };
      if (selfClose) {
        model.deviceInstances.set(device.id, device);
        device = null;
      }
      continue;
    }

    if (tag === "ComObjectInstanceRef") {
      if (close) {
        if (comObject && device) {
          model.communicationObjects.set(comObject.id, comObject);
          device.comObjectIds.push(comObject.id);
        }
        comObject = null;
        continue;
      }
      if (!device) continue; // a comObject outside any DeviceInstance is malformed — skip it
      const refId = attr(a, "RefId") ?? attr(a, "Id");
      if (!refId) continue;
      // § Real ETS5 export compatibility — `RefId` (e.g. "O-0_R-1") identifies a slot in
      // the DEVICE'S APPLICATION PROGRAM, not the physical device instance: every device
      // using the same catalog application (common for a project with many identical
      // actuators) reuses the exact same RefId string. Keying the model by bare RefId
      // silently collapsed every such device's distinct comm objects onto one Map entry
      // (confirmed against a real 217-device ETS5 project: 2,954 ComObjectInstanceRef
      // occurrences collided down to 391 surviving map entries). Namespacing by the
      // owning device instance restores one real comm object per device, per RefId.
      const id = `${device.id}::${refId}`;
      // § Real ETS5 export compatibility — this instance carries no Number/Text/DPT/
      // flags of its own (confirmed empty on a real project); resolve the application-
      // program catalog definition via Hardware2ProgramRefId → ApplicationProgramRef →
      // ComObject table (see `parseApplicationProgramCatalog`'s doc comment). Instance-
      // level attributes still win when an export DOES carry them directly (a richer
      // export variant, or this module's own existing test fixtures) — the catalog is
      // strictly a fallback for what the instance itself doesn't say.
      const programId = device.hardwareName ? appProgramCatalog.hardware2Program.get(device.hardwareName) : null;
      const catalogRef = /^(O-\d+)/.exec(refId)?.[1];
      const catalogDef = programId && catalogRef ? appProgramCatalog.comObjectDefs.get(`${programId}_${catalogRef}`) : undefined;
      comObject = {
        id,
        deviceInstanceId: device.id,
        number: attr(a, "Number") !== null ? Number(attr(a, "Number")) : catalogDef?.number ?? null,
        text: attr(a, "Text") || catalogDef?.text || "",
        dpt: normalizeDpt(attr(a, "DatapointType")) ?? catalogDef?.dpt ?? null,
        flags: attr(a, "WriteFlag") !== null || attr(a, "ReadFlag") !== null ? parseFlags(a) : catalogDef?.flags ?? parseFlags(a),
        groupAddressIds: [],
        sendGroupAddressIds: [],
        receiveGroupAddressIds: [],
        channelId: attr(a, "ChannelId"),
      };
      // § Real ETS5 export compatibility — some exports link group addresses via a flat
      // `Links="GA-x GA-y"` attribute directly on `<ComObjectInstanceRef>` rather than
      // nested `<Connectors><Send/><Receive/></Connectors>` children (confirmed against
      // two real ETS5 projects — neither contains a single `<Connectors>` element).
      // This establishes the GA↔device/comm-object association (identity, room/channel
      // grouping) but carries no per-GA Send/Receive distinction; downstream role
      // resolution (`roleOfEtsSignal`) already falls back to name/DPT heuristics when
      // `links[]` is empty — an honest degradation, not a fabricated relationship.
      const flatLinks = attr(a, "Links");
      if (flatLinks) {
        for (const rawRef of flatLinks.split(/\s+/).filter(Boolean)) {
          const gaId = resolveGaId(rawRef);
          if (!gaId) continue; // reference to a GA this export didn't declare — skip, never fabricated
          comObject.groupAddressIds.push(gaId);
          const ga = model.groupAddresses.get(gaId)!;
          if (!ga.comObjectIds.includes(comObject.id)) ga.comObjectIds.push(comObject.id);
        }
      }
      if (selfClose) {
        model.communicationObjects.set(comObject.id, comObject);
        device.comObjectIds.push(comObject.id);
        comObject = null;
      }
      continue;
    }

    if (tag === "Connectors") {
      inConnectors = !close;
      continue;
    }

    if ((tag === "Send" || tag === "Receive") && inConnectors && comObject) {
      const rawRef = attr(a, "GroupAddressRefId");
      const gaId = rawRef ? resolveGaId(rawRef) : null;
      if (gaId) {
        comObject.groupAddressIds.push(gaId);
        (tag === "Send" ? comObject.sendGroupAddressIds : comObject.receiveGroupAddressIds).push(gaId);
        const ga = model.groupAddresses.get(gaId)!;
        if (!ga.comObjectIds.includes(comObject.id)) ga.comObjectIds.push(comObject.id);
      }
    }
  }
}

function parseFlags(a: string): KnxComFlags {
  return {
    read: boolAttr(a, "ReadFlag", false),
    write: boolAttr(a, "WriteFlag", true),
    communicate: boolAttr(a, "CommunicationFlag", true),
    transmit: boolAttr(a, "TransmitFlag", false),
    update: boolAttr(a, "UpdateFlag", true),
    readOnInit: boolAttr(a, "ReadOnInitFlag", false),
  };
}

/** 3. Locations — the Buildings/Locations Space tree (Building → Floor → Room → …),
 * `<Function>` fallback grouping, and `<DeviceInstanceRef>` room placement. */
function parseLocations(xml: string, model: KnxProjectModel): void {
  const spaceStack: string[] = [];
  const tagRe = /<(\/?)(Space|BuildingPart|Function|GroupAddressRef|DeviceInstanceRef)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let fn: KnxFunctionGroup | null = null;

  while ((m = tagRe.exec(xml))) {
    const close = m[1] === "/";
    const tag = m[2]!;
    const a = m[3] ?? "";
    const selfClose = m[4] === "/";

    if (tag === "Space" || tag === "BuildingPart") {
      if (close) {
        if (spaceStack.length) spaceStack.pop();
        continue;
      }
      const id = attr(a, "Id") ?? `space-${model.spaces.size}`;
      const parentId = spaceStack[spaceStack.length - 1] ?? null;
      const space: KnxSpace = {
        id,
        type: spaceType(attr(a, "Type")),
        name: attr(a, "Name") ?? "",
        parentId,
        childIds: [],
        deviceInstanceIds: [],
      };
      model.spaces.set(id, space);
      if (parentId) model.spaces.get(parentId)?.childIds.push(id);
      else model.rootSpaceIds.push(id);
      spaceStack.push(id);
      if (selfClose) spaceStack.pop();
      continue;
    }

    if (tag === "Function") {
      if (close) {
        if (fn && fn.groupAddressIds.length > 0) model.functions.set(fn.id, fn);
        fn = null;
        continue;
      }
      const currentSpaceId = spaceStack[spaceStack.length - 1] ?? null;
      fn = {
        id: attr(a, "Id") ?? `fn-${model.functions.size}`,
        name: attr(a, "Name") ?? "Device",
        spaceId: currentSpaceId,
        groupAddressIds: [],
      };
      if (selfClose) {
        fn = null;
      }
      continue;
    }

    if (tag === "GroupAddressRef" && fn) {
      const ref = attr(a, "RefId");
      if (ref) fn.groupAddressIds.push(ref);
      continue;
    }

    if (tag === "DeviceInstanceRef") {
      const ref = attr(a, "RefId");
      const currentSpaceId = spaceStack[spaceStack.length - 1] ?? null;
      if (ref && currentSpaceId) {
        const device = model.deviceInstances.get(ref);
        if (device) device.spaceId = currentSpaceId;
        model.spaces.get(currentSpaceId)?.deviceInstanceIds.push(ref);
      }
    }
  }
}

/** Parse the unzipped `.knxproj` files into a complete {@link KnxProjectModel}. */
export function parseEtsProject(files: Map<string, Buffer>): KnxProjectModel {
  const xml = concatXml(files);
  const model = emptyProjectModel(parseProjectName(xml));
  const catalog = parseCatalogNames(xml);
  const appProgramCatalog = parseApplicationProgramCatalog(xml);
  parseGroupAddresses(xml, model);
  parseTopology(xml, model, catalog, appProgramCatalog);
  parseLocations(xml, model);
  return model;
}
