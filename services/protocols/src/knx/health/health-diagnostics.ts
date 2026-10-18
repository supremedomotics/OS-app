/**
 * Diagnostics document for KNX device health (§ Supreme KNX Health). PURE: turns a monitor snapshot + events + connection facts into a JSON-safe
 * structure following the existing diagnostics conventions (ISO-8601 timestamps, `null` when unknown — never a fabricated placeholder, counters that
 * are real counters). Contains NO credentials, key material or KNX Secure session data by construction: the inputs have none, and
 * health-service tests scan the output for secret-like keys.
 */
import type { DriverDiagnosticsSnapshot } from "@supreme/integration-layer";
import { formatGroupAddress, formatIndividualAddress } from "../native/address.js";
import type { ConnectionManagerMetrics } from "../connection-manager.js";
import type { HealthEvent, HealthSnapshot } from "./health-monitor.js";
import type { EtsRegistrationMeta, ReconcileReport } from "./ets-registry.js";

/** How certain a check outcome is — the diagnostics must never present "unknown" as a confirmed result. */
export type OutcomeCertainty = "confirmed_response" | "confirmed_no_response" | "unknown";

export const HUMAN_REASON: Readonly<Record<string, string>> = Object.freeze({
  not_monitored: "The device is not monitored.",
  path_down: "The KNX/IP gateway or the tunnel to it is not available, so nothing can be concluded about this device.",
  path_unknown: "The state of the gateway connection is not known yet, so nothing can be concluded about this device.",
  bus_degraded: "Recent frames sent to the KNX line were reported as failed; active checks are paused and nothing is blamed on this device.",
  active_checks_failed: "The device answered status reads before but has now repeatedly not answered, and has been silent for a long time.",
  unproven_silent: "The device has been silent, but it has never answered a status read, so silence does not show that it is offline (its object may not answer reads).",
  no_evidence: "Nothing has been seen from this device yet.",
  intermittent: "The device answers some status reads and not others.",
  slow_response: "The device answers status reads, but slowly.",
  active_response: "The device answered a status read recently.",
  passive_telegram: "The device sent a telegram recently.",
  stale_evidence: "The device was last heard from a while ago; that evidence is too old to call it online, but it does not show that the device is offline.",
});

const HUMAN_STATE_CHANGE_PREFIX = "state changed to ";

export interface HealthConnectionFacts {
  status: "connected" | "connecting" | "disconnected";
  supervisor: ConnectionManagerMetrics;
  gateway: { host: string; port: number };
  tunnelsCreated: number;
  /** Exactly 0 or 1: more than one would mean a duplicate attachment. */
  attachedTunnels: number;
  monitorRunning: boolean;
  driver: DriverDiagnosticsSnapshot | null;
}

export interface KnxHealthDiagnostics {
  schema: "knx.health.diagnostics.v1";
  generatedAt: string;
  evidenceLevel: "simulator-tested";
  assumptions: string[];
  connection: Omit<HealthConnectionFacts, "driver"> & { driver: DriverDiagnosticsSnapshot | null };
  path: { gateway: string; interface: string; bus: string; summary: string };
  devices: Array<{
    deviceId: string;
    name: string | null;
    physicalAddress: string | null;
    state: string;
    confidence: string;
    reason: string;
    humanReason: string;
    evidence: {
      method: "passive_only" | "group_read";
      lastEvidenceKind: string | null;
      lastSeenAt: string | null;
      lastSuccessfulResponseAt: string | null;
      lastResponseLatencyMs: number | null;
      consecutiveConclusiveFailures: number;
      stale: boolean;
      evidenceAgeMs: number | null;
      activeCheck: string;
      statusGroups: string[];
      lastCheck: { at: string; outcome: string; certainty: OutcomeCertainty } | null;
      nextCheckAt: string | null;
    };
    lastTransition: { at: string; from: string; to: string; summary: string } | null;
    configuration: Pick<EtsRegistrationMeta, "objects"> | null;
  }>;
  events: Array<{ at: string; kind: string; deviceId: string | null; from: string | null; to: string | null; reason: string }>;
  registration: { lastReconciledAt: string | null; added: number; updated: number; unchanged: number; removed: number; renamed: number; skipped: number; issues: ReconcileReport["issues"] } | null;
  load: HealthSnapshot["load"];
}

const ASSUMPTIONS = Object.freeze([
  "Attributing group telegrams to a device by their source address is an implementation assumption: the cEMI chapter that defines the field was not available. Individual/broadcast services are covered by the Network Layer text.",
  "A device may legitimately not answer a group read (Application Layer §3.1.2); a missing answer is therefore never proof of failure.",
  "All thresholds are configurable implementation decisions, not KNX specification values.",
  "Validated against a simulator only; no real KNX/IP gateway or device has been tested.",
]);

function certainty(outcome: string): OutcomeCertainty {
  return outcome === "success" ? "confirmed_response" : outcome === "failure" ? "confirmed_no_response" : "unknown";
}

export function buildHealthDiagnostics(a: {
  snapshot: HealthSnapshot; events: readonly HealthEvent[]; connection: HealthConnectionFacts;
  reconcile: { at: number; report: ReconcileReport } | null; toIso?: (ms: number) => string;
}): KnxHealthDiagnostics {
  const iso = a.toIso ?? ((ms: number) => new Date(ms).toISOString());
  const p = a.snapshot.path;
  const summary = p.gateway === "unreachable" || p.interface === "down" ? "The tunnel to the KNX/IP gateway is down; devices cannot be assessed."
    : p.gateway === "unknown" || p.interface === "unknown" ? "The gateway connection has not been established yet."
    : p.bus === "degraded" ? "The gateway is connected but frames to the KNX line are failing; active checks are paused."
    : p.bus === "ok" ? "Gateway connected and the KNX line is carrying traffic." : "Gateway connected; no recent evidence about the KNX line itself.";
  const { driver, ...conn } = a.connection;
  return {
    schema: "knx.health.diagnostics.v1",
    generatedAt: iso(a.snapshot.at),
    evidenceLevel: "simulator-tested",
    assumptions: [...ASSUMPTIONS],
    connection: { ...conn, driver },
    path: { gateway: p.gateway, interface: p.interface, bus: p.bus, summary },
    devices: a.snapshot.devices.map((d) => {
      const meta = d.meta as EtsRegistrationMeta | null;
      const isEts = meta !== null && typeof meta === "object" && meta.source === "ets";
      return {
        deviceId: d.deviceId,
        name: isEts ? meta.name : null,
        physicalAddress: d.individualAddress === null ? null : formatIndividualAddress(d.individualAddress),
        state: d.state, confidence: d.confidence, reason: d.reason, humanReason: HUMAN_REASON[d.reason] ?? d.reason,
        evidence: {
          method: d.checkMethod,
          lastEvidenceKind: d.lastSeenKind,
          lastSeenAt: d.lastSeenAt === null ? null : iso(d.lastSeenAt),
          lastSuccessfulResponseAt: d.lastResponseAt === null ? null : iso(d.lastResponseAt),
          lastResponseLatencyMs: d.lastResponseLatencyMs,
          consecutiveConclusiveFailures: d.consecutiveFailures,
          stale: d.stale, evidenceAgeMs: d.evidenceAgeMs,
          activeCheck: d.activeCheck,
          statusGroups: d.statusGroups.map(formatGroupAddress),
          lastCheck: d.lastCheck ? { at: iso(d.lastCheck.at), outcome: d.lastCheck.outcome, certainty: certainty(d.lastCheck.outcome) } : null,
          nextCheckAt: d.nextCheckAt === null ? null : iso(d.nextCheckAt),
        },
        lastTransition: d.lastTransition ? { at: iso(d.lastTransition.at), from: d.lastTransition.from, to: d.lastTransition.to, summary: HUMAN_STATE_CHANGE_PREFIX + d.lastTransition.to.split("/")[0] + ": " + (HUMAN_REASON[d.lastTransition.to.split("/")[1] ?? ""] ?? d.lastTransition.to) } : null,
        configuration: isEts ? { objects: meta.objects } : null,
      };
    }),
    events: a.events.map((e) => ({ at: iso(e.at), kind: e.kind, deviceId: e.deviceId, from: e.from ?? null, to: e.to ?? null, reason: e.reason })),
    registration: a.reconcile ? {
      lastReconciledAt: iso(a.reconcile.at), added: a.reconcile.report.added.length, updated: a.reconcile.report.updated.length, unchanged: a.reconcile.report.unchanged.length,
      removed: a.reconcile.report.removed.length, renamed: a.reconcile.report.renamed.length, skipped: a.reconcile.report.skipped.length, issues: a.reconcile.report.issues,
    } : null,
    load: a.snapshot.load,
  };
}
