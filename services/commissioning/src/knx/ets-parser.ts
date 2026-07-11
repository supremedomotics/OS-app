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
function parseTopology(xml: string, model: KnxProjectModel, catalog: ReturnType<typeof parseCatalogNames>): void {
  const tagRe = /<(\/?)(DeviceInstance|ComObjectInstanceRef|Connectors|Send|Receive)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let device: KnxDeviceInstance | null = null;
  let comObject: KnxCommunicationObject | null = null;
  let inConnectors = false;

  while ((m = tagRe.exec(xml))) {
    const close = m[1] === "/";
    const tag = m[2]!;
    const a = m[3] ?? "";
    const selfClose = m[4] === "/";

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
      device = {
        id,
        name: attr(a, "Name") ?? "Device",
        individualAddress: attr(a, "Address"),
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
      const id = attr(a, "RefId") ?? attr(a, "Id");
      if (!id) continue;
      comObject = {
        id,
        deviceInstanceId: device.id,
        number: attr(a, "Number") !== null ? Number(attr(a, "Number")) : null,
        text: attr(a, "Text") ?? "",
        dpt: normalizeDpt(attr(a, "DatapointType")),
        flags: parseFlags(a),
        groupAddressIds: [],
      };
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
      const gaRef = attr(a, "GroupAddressRefId");
      if (gaRef) {
        comObject.groupAddressIds.push(gaRef);
        const ga = model.groupAddresses.get(gaRef);
        if (ga && !ga.comObjectIds.includes(comObject.id)) ga.comObjectIds.push(comObject.id);
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
  parseGroupAddresses(xml, model);
  parseTopology(xml, model, catalog);
  parseLocations(xml, model);
  return model;
}
