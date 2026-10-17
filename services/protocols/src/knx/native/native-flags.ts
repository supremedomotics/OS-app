/**
 * Feature-flag parsing for the native KNX stack (§ production integration). Fail-closed:
 * an unrecognised value is a configuration error, never silently treated as on or off, and
 * secure mode can be requested only if it is actually implemented.
 *
 *   SUPREME_KNX_NATIVE         off (default) | on     — use the native stack instead of knxultimate
 *   SUPREME_KNX_NATIVE_SECURE  off (default) | on     — require KNX Secure (NOT IMPLEMENTED: "on" throws)
 *
 * Nothing consumes these flags yet; the production driver is unchanged.
 */
import { assertPolicySatisfiable } from "./security/policy.js";

export class NativeFlagError extends Error {
  constructor(message: string) { super(message); this.name = "NativeFlagError"; }
}

export interface NativeFlags { native: boolean; secure: boolean }

function parse(name: string, raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "off" || v === "0" || v === "false") return false;
  if (v === "on" || v === "1" || v === "true") return true;
  throw new NativeFlagError(`${name}="${raw}" is not recognised; use "on" or "off"`);
}

export function readNativeFlags(env: Record<string, string | undefined>): NativeFlags {
  const native = parse("SUPREME_KNX_NATIVE", env.SUPREME_KNX_NATIVE);
  const secure = parse("SUPREME_KNX_NATIVE_SECURE", env.SUPREME_KNX_NATIVE_SECURE);
  if (secure && !native) throw new NativeFlagError("SUPREME_KNX_NATIVE_SECURE requires SUPREME_KNX_NATIVE=on");
  if (secure) assertPolicySatisfiable({ transport: "ip_secure_required", data: "data_secure_required" }); // throws: not implemented
  return { native, secure };
}
