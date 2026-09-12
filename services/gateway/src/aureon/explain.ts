import type { AureonTransaction } from "@supreme/domain-model";

/**
 * Turns a transaction's REAL verification results into a plain-language summary
 * (§ AUREON-ARCHITECTURE.md §4 step 9, brief's "47 verified OFF, 2 unavailable"
 * example). Never invents a rosier outcome than `entries[].status` supports.
 */
export function explainTransaction(tx: AureonTransaction): string {
  if (tx.entries.length === 0) return "Nothing to do — I couldn't find a device to act on.";

  const counts = new Map<string, number>();
  for (const e of tx.entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);

  const parts: string[] = [];
  const success = counts.get("verified_success") ?? 0;
  if (success > 0) parts.push(`${success} device${success === 1 ? "" : "s"} confirmed`);
  const failed = counts.get("verified_failure") ?? 0;
  if (failed > 0) parts.push(`${failed} device${failed === 1 ? "" : "s"} did not reach the requested state`);
  const unverified = counts.get("unverified") ?? 0;
  if (unverified > 0) parts.push(`${unverified} device${unverified === 1 ? "" : "s"} sent the command but couldn't be verified`);
  const timeout = counts.get("timeout") ?? 0;
  if (timeout > 0) parts.push(`${timeout} device${timeout === 1 ? "" : "s"} unreachable`);
  const notSupported = counts.get("not_supported") ?? 0;
  if (notSupported > 0) parts.push(`${notSupported} device${notSupported === 1 ? "" : "s"} don't support this`);
  const denied = counts.get("denied") ?? 0;
  if (denied > 0) parts.push(`${denied} device${denied === 1 ? "" : "s"} skipped (not permitted)`);

  return parts.join("; ") + ".";
}
