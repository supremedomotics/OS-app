/**
 * Transactional, format-agnostic activation of an imported secret set (§ KNX Secure —
 * keyring import safety). This module deliberately knows NOTHING about the ETS keyring file
 * format (BLOCKED-SPEC): a future parser produces a candidate `Map<name, Secret>` and a
 * list of validators; this code guarantees the safe procedure around it.
 *
 *   1. every validator runs; ANY error-severity issue rejects the import — store untouched
 *   2. the diff (added / removed / changed NAMES) is computed and must be explicitly
 *      confirmed by the caller before anything changes
 *   3. activation is one atomic write (`replaceAll`); failure leaves the previous set intact
 *   4. outcome is audited with counts and issue codes only — never names of secrets' values
 */
import { isValidSecretName, KeyStore, secretsEqual } from "./keystore.js";
import type { Secret } from "./secret.js";

export interface ImportIssue {
  severity: "error" | "warning";
  /** Stable machine-readable code (what is logged/audited). */
  code: string;
  message: string;
}

export type ImportValidator = (candidate: ReadonlyMap<string, Secret>) => ImportIssue[];

export interface ImportDiff { added: string[]; removed: string[]; changed: string[]; unchanged: string[] }

export interface ImportOutcome {
  activated: boolean;
  reason: "activated" | "validation_failed" | "not_confirmed" | "no_changes" | "write_failed" | "empty_candidate";
  issues: ImportIssue[];
  diff: ImportDiff;
}

export function diffSecretSets(store: KeyStore, candidate: ReadonlyMap<string, Secret>): ImportDiff {
  const current = store.names();
  const d: ImportDiff = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [name, s] of candidate) {
    if (!current.includes(name)) { d.added.push(name); continue; }
    const existing = store.get(name);
    (secretsEqual(existing, s) ? d.unchanged : d.changed).push(name);
    existing.wipe();
  }
  d.removed = current.filter((n) => !candidate.has(n));
  for (const k of ["added", "removed", "changed", "unchanged"] as const) d[k].sort();
  return d;
}

export function activateImport(
  store: KeyStore,
  candidate: ReadonlyMap<string, Secret>,
  validators: ReadonlyArray<ImportValidator>,
  confirm: (diff: ImportDiff) => boolean,
): ImportOutcome {
  const diff = diffSecretSets(store, candidate);
  const issues: ImportIssue[] = [];
  if (candidate.size === 0) issues.push({ severity: "error", code: "empty_candidate", message: "import contains no secrets" });
  for (const [name, s] of candidate) {
    if (!isValidSecretName(name)) issues.push({ severity: "error", code: "invalid_name", message: "candidate contains an invalid secret name" });
    if (s.wiped || s.length === 0 || s.length > 4096) issues.push({ severity: "error", code: "invalid_size", message: "candidate contains a secret of invalid size" });
  }
  for (const v of validators) {
    try { issues.push(...v(candidate)); } catch {
      issues.push({ severity: "error", code: "validator_crashed", message: "a validator failed unexpectedly; import rejected" });
    }
  }
  const codes = issues.map((i) => i.code).join(",");
  if (issues.some((i) => i.severity === "error")) {
    store.recordAudit("import_rejected", "denied", `validation_failed:${codes}`);
    return { activated: false, reason: candidate.size === 0 ? "empty_candidate" : "validation_failed", issues, diff };
  }
  if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
    return { activated: false, reason: "no_changes", issues, diff };
  }
  if (!confirm(diff)) {
    store.recordAudit("import_rejected", "denied", "not_confirmed");
    return { activated: false, reason: "not_confirmed", issues, diff };
  }
  try { store.replaceAll(candidate); } catch {
    store.recordAudit("import_rejected", "error", "write_failed");
    return { activated: false, reason: "write_failed", issues, diff };
  }
  store.recordAudit("import_activated", "ok", `added=${diff.added.length},removed=${diff.removed.length},changed=${diff.changed.length}`);
  return { activated: true, reason: "activated", issues, diff };
}
