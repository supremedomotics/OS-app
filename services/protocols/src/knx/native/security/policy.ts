/**
 * Fail-closed security policy (§ KNX Secure — no silent downgrade).
 *
 * KNX IP Secure and KNX Data Secure are NOT implemented in this stack (normative
 * specifications unavailable to the project at time of writing; see
 * docs/architecture/knx-secure-requirements-matrix.md). Until they are, any endpoint or
 * binding that is declared secure must fail with an explicit error — never be carried over
 * plain KNXnet/IP and never have its telegrams decoded as ordinary values.
 */
export type TransportSecurity = "none" | "ip_secure_required";
export type DataSecurity = "none" | "data_secure_required";

export interface SecurityPolicy {
  transport: TransportSecurity;
  data: DataSecurity;
}

export const PLAIN_POLICY: SecurityPolicy = { transport: "none", data: "none" };

export class KnxSecurityNotImplementedError extends Error {
  readonly code = "secure_not_implemented" as const;
  constructor(readonly feature: "ip_secure" | "data_secure") {
    super(`${feature === "ip_secure" ? "KNX IP Secure" : "KNX Data Secure"} is required for this endpoint but is not implemented; refusing to fall back to an insecure connection`);
    this.name = "KnxSecurityNotImplementedError";
  }
}

/** Throws unless the policy can be satisfied by the implemented (plain) stack. */
export function assertPolicySatisfiable(p: SecurityPolicy): void {
  if (p.transport === "ip_secure_required") throw new KnxSecurityNotImplementedError("ip_secure");
  if (p.data === "data_secure_required") throw new KnxSecurityNotImplementedError("data_secure");
}
