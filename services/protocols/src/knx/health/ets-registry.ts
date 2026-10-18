/**
 * ETS → health-monitor registration (§ Supreme KNX Health, vertical slice). Turns the parsed ETS project (`@supreme/commissioning` KnxProjectModel) into
 * monitored-device registrations and RECONCILES them against what the monitor already holds, so a re-import never duplicates a device and never
 * discards still-valid evidence. ETS-derived CONFIGURATION (flags, object texts, group addresses, decisions) lives in the registration `meta`; live
 * EVIDENCE lives only in the monitor — the two never mix.
 *
 * Eligibility of a communication object as an active-check target is deliberately narrow (nothing is invented from a bare group address):
 *   READ flag set  ∧  COMMUNICATION flag set  ∧  exactly one SEND group address  ∧  that address parses.
 * ETS exposes no separate "absent" state for a flag, so an object whose Read flag is not explicitly enabled is simply not eligible. A device with no
 * eligible object is still registered for passive observation. Devices with a missing/invalid/reserved/duplicate individual address are NOT registered
 * (telegrams could not be attributed to them) and the reason is reported.
 */
import type { KnxProjectModel } from "@supreme/commissioning";
import { formatGroupAddress, parseGroupAddress, parseIndividualAddress } from "../native/address.js";
import type { KnxHealthMonitor, MonitoredDeviceInput } from "./health-monitor.js";

export interface EtsFlags { read: boolean; write: boolean; communicate: boolean; transmit: boolean; update: boolean; readOnInit: boolean }
export interface EtsObjectInfo {
  id: string;
  number: number | null;
  text: string;
  dpt: string | null;
  flags: EtsFlags;
  sendGroupAddresses: string[];
  receiveGroupAddresses: string[];
}
export interface EtsDeviceInfo { id: string; name: string; individualAddress: string | null; objects: EtsObjectInfo[] }

export type IssueCode =
  | "missing_individual_address" | "invalid_individual_address" | "reserved_individual_address" | "duplicate_individual_address" | "id_conflict"
  | "read_object_without_send_group" | "read_object_communication_disabled" | "ambiguous_send_group" | "invalid_group_address"
  | "no_readable_status_object" | "extra_status_objects_unused" | "shared_status_group" | "secure_device_not_probed";
export interface RegistrationIssue { deviceId: string | null; code: IssueCode; severity: "info" | "warning"; detail: string }

export interface ObjectDecision extends EtsObjectInfo { eligible: boolean; reason: string }
export interface EtsRegistrationMeta {
  source: "ets";
  name: string;
  individualAddress: string | null;
  objects: ObjectDecision[];
}

export interface ReconcileReport {
  added: string[]; updated: string[]; unchanged: string[]; removed: string[];
  renamed: Array<{ from: string; to: string }>;
  /** Registered with their previous evidence reset (the physical address changed). */
  evidenceReset: string[];
  /** Not registered at all, with the reason. */
  skipped: Array<{ deviceId: string; code: IssueCode }>;
  issues: RegistrationIssue[];
}

export interface ReconcileOptions {
  /** Device ids whose group communication is Data Secure: never probed. */
  secureDeviceIds?: ReadonlySet<string>;
  /** Cap on status groups kept per device (retries rotate over them). */
  maxStatusGroups?: number;
}

/** Flattens the parsed ETS model into plain device descriptions (resolving group-address ids to addresses; unresolved ids are kept verbatim so they fail validation visibly). */
export function etsDevicesFromModel(model: KnxProjectModel): EtsDeviceInfo[] {
  const ga = (id: string): string => model.groupAddresses.get(id)?.address ?? `unresolved:${id}`;
  return [...model.deviceInstances.values()].map((d) => ({
    id: d.id, name: d.name, individualAddress: d.individualAddress,
    objects: d.comObjectIds.flatMap((cid) => {
      const o = model.communicationObjects.get(cid);
      if (!o) return [];
      return [{
        id: o.id, number: o.number, text: o.text, dpt: o.dpt, flags: { ...o.flags },
        sendGroupAddresses: o.sendGroupAddressIds.map(ga), receiveGroupAddresses: o.receiveGroupAddressIds.map(ga),
      }];
    }),
  }));
}

interface Desired { input: MonitoredDeviceInput; ia: number }

function decide(dev: EtsDeviceInfo, issues: RegistrationIssue[], maxGroups: number): { groups: number[]; decisions: ObjectDecision[] } {
  const decisions: ObjectDecision[] = [];
  const candidates: Array<{ ga: number; o: EtsObjectInfo }> = [];
  const warn = (code: IssueCode, detail: string, severity: "info" | "warning" = "warning"): void => { issues.push({ deviceId: dev.id, code, severity, detail }); };
  for (const o of dev.objects) {
    const base = { ...o, flags: { ...o.flags }, sendGroupAddresses: [...o.sendGroupAddresses], receiveGroupAddresses: [...o.receiveGroupAddresses] };
    if (!o.flags.read) { decisions.push({ ...base, eligible: false, reason: "read_flag_not_enabled" }); continue; }
    if (!o.flags.communicate) { warn("read_object_communication_disabled", `object ${o.id} has Read but not Communication enabled`); decisions.push({ ...base, eligible: false, reason: "communication_flag_disabled" }); continue; }
    if (o.sendGroupAddresses.length === 0) { warn("read_object_without_send_group", `object ${o.id} has the Read flag but no sending group address, so the address it answers on is unknown`); decisions.push({ ...base, eligible: false, reason: "no_send_group" }); continue; }
    if (o.sendGroupAddresses.length > 1) { warn("ambiguous_send_group", `object ${o.id} sends on ${o.sendGroupAddresses.length} group addresses; which one answers a read is not determinable`); decisions.push({ ...base, eligible: false, reason: "ambiguous_send_group" }); continue; }
    let ga: number;
    try { ga = parseGroupAddress(o.sendGroupAddresses[0]!); } catch { warn("invalid_group_address", `object ${o.id}: "${o.sendGroupAddresses[0]}" is not a valid group address`); decisions.push({ ...base, eligible: false, reason: "invalid_group_address" }); continue; }
    decisions.push({ ...base, eligible: true, reason: "read_enabled_single_send_group" });
    candidates.push({ ga, o });
  }
  // status-like objects first (Transmit flag), then object number, then id — deterministic
  candidates.sort((a, b) => Number(b.o.flags.transmit) - Number(a.o.flags.transmit) || (a.o.number ?? 1e9) - (b.o.number ?? 1e9) || (a.o.id < b.o.id ? -1 : 1));
  const groups: number[] = [];
  for (const c of candidates) { if (!groups.includes(c.ga)) groups.push(c.ga); }
  if (groups.length > maxGroups) warn("extra_status_objects_unused", `${groups.length} eligible status groups, only the first ${maxGroups} are used`, "info");
  return { groups: groups.slice(0, maxGroups), decisions };
}

/** Builds the desired registrations (and the explanatory issues) from ETS devices. Pure. */
export function planRegistrations(devices: readonly EtsDeviceInfo[], opts: ReconcileOptions = {}): { desired: Map<string, Desired>; skipped: ReconcileReport["skipped"]; issues: RegistrationIssue[] } {
  const issues: RegistrationIssue[] = [];
  const skipped: ReconcileReport["skipped"] = [];
  const maxGroups = opts.maxStatusGroups ?? 2;
  const byIa = new Map<number, string[]>();
  const parsed = new Map<string, number>();
  for (const d of devices) {
    const skip = (code: IssueCode, detail: string): void => { skipped.push({ deviceId: d.id, code }); issues.push({ deviceId: d.id, code, severity: "warning", detail }); };
    if (d.individualAddress === null || d.individualAddress.trim() === "") { skip("missing_individual_address", "device has no individual address in the project"); continue; }
    let ia: number;
    try { ia = parseIndividualAddress(d.individualAddress); } catch { skip("invalid_individual_address", `"${d.individualAddress}" is not a valid individual address`); continue; }
    if (ia === 0) { skip("reserved_individual_address", "individual address 0.0.0 is reserved"); continue; }
    parsed.set(d.id, ia);
    byIa.set(ia, [...(byIa.get(ia) ?? []), d.id]);
  }
  const desired = new Map<string, Desired>();
  for (const d of devices) {
    const ia = parsed.get(d.id);
    if (ia === undefined) continue;
    const owners = byIa.get(ia)!;
    if (owners.length > 1) {
      skipped.push({ deviceId: d.id, code: "duplicate_individual_address" });
      issues.push({ deviceId: d.id, code: "duplicate_individual_address", severity: "warning", detail: `individual address ${d.individualAddress} is used by ${owners.join(", ")}; telegrams cannot be attributed, so none is registered` });
      continue;
    }
    const { groups, decisions } = decide(d, issues, maxGroups);
    const secure = opts.secureDeviceIds?.has(d.id) === true;
    if (secure) issues.push({ deviceId: d.id, code: "secure_device_not_probed", severity: "info", detail: "Data Secure device: only passive observation" });
    else if (groups.length === 0) issues.push({ deviceId: d.id, code: "no_readable_status_object", severity: "info", detail: "no eligible readable status object; passive observation only" });
    const meta: EtsRegistrationMeta = { source: "ets", name: d.name, individualAddress: d.individualAddress, objects: decisions };
    desired.set(d.id, { ia, input: { deviceId: d.id, individualAddress: ia, statusGroups: secure ? [] : groups, activeCheck: secure ? "disabled" : "allowed", meta } });
  }
  // informational: one group address used as status group by several devices (a read may be answered by more than one of them)
  const owners = new Map<number, string[]>();
  for (const [id, d] of desired) for (const g of d.input.statusGroups ?? []) owners.set(g, [...(owners.get(g) ?? []), id]);
  for (const [g, ids] of owners) if (ids.length > 1) for (const id of ids) issues.push({ deviceId: id, code: "shared_status_group", severity: "info", detail: `group address ${formatGroupAddress(g)} is a status group of ${ids.join(", ")}` });
  return { desired, skipped, issues };
}

const sameConfig = (a: ReturnType<KnxHealthMonitor["registeredDevices"]>[number], b: MonitoredDeviceInput): boolean =>
  a.individualAddress === b.individualAddress && a.activeCheck === (b.activeCheck ?? "allowed") &&
  a.statusGroups.join() === (b.statusGroups ?? []).join() && JSON.stringify(a.meta) === JSON.stringify(b.meta ?? null);

/**
 * Makes the monitor's ETS-managed registrations equal to the project. Idempotent. Registrations not created from ETS (`meta.source !== "ets"`) are never
 * touched. Evidence policy lives in {@link KnxHealthMonitor.reconfigureDevice}.
 */
export function reconcileEtsDevices(monitor: KnxHealthMonitor, devices: readonly EtsDeviceInfo[], opts: ReconcileOptions = {}): ReconcileReport {
  const { desired, skipped, issues } = planRegistrations(devices, opts);
  const report: ReconcileReport = { added: [], updated: [], unchanged: [], removed: [], renamed: [], evidenceReset: [], skipped: [...skipped], issues };
  const existing = new Map(monitor.registeredDevices().map((r) => [r.deviceId, r]));
  const isEts = (m: unknown): boolean => typeof m === "object" && m !== null && (m as { source?: unknown }).source === "ets";
  const managed = new Set([...existing.values()].filter((r) => isEts(r.meta)).map((r) => r.deviceId));

  // 1. same id: reconfigure or leave alone
  for (const [id, d] of desired) {
    const cur = existing.get(id);
    if (!cur) continue;
    if (!managed.has(id)) { report.issues.push({ deviceId: id, code: "id_conflict", severity: "warning", detail: "a non-ETS registration already uses this id" }); report.skipped.push({ deviceId: id, code: "id_conflict" }); desired.delete(id); continue; }
    if (sameConfig(cur, d.input)) { report.unchanged.push(id); continue; }
    const r = monitor.reconfigureDevice(d.input);
    report.updated.push(id);
    if (!r.evidenceKept) report.evidenceReset.push(id);
  }
  // 2. ids that vanished but whose physical address reappears under a new id: keep the evidence (rekey), then reconfigure
  const vanished = [...managed].filter((id) => !desired.has(id));
  for (const [id, d] of desired) {
    if (existing.has(id)) continue;
    const old = vanished.find((v) => existing.get(v)!.individualAddress === d.ia);
    if (old !== undefined) {
      vanished.splice(vanished.indexOf(old), 1);
      monitor.rekeyDevice(old, id);
      monitor.reconfigureDevice(d.input);
      report.renamed.push({ from: old, to: id });
    } else {
      monitor.registerDevice(d.input);
      report.added.push(id);
    }
  }
  // 3. whatever is left over was removed from the project
  for (const id of vanished) { monitor.unregisterDevice(id); report.removed.push(id); }
  return report;
}
