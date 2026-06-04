import {
  DriverBundle,
  DriverManifest,
  SignedDriverBundle,
} from "@supreme/domain-model";
import { sha256Hex, signPayload, verifyPayload } from "@supreme/crypto";

/**
 * @supreme/driver-sdk — author, lint, package, and sign Supreme drivers (§9).
 *
 * A driver declares a Supreme capability manifest; the SDK packages it with a
 * content hash and an Ed25519 signature so the hub can verify authenticity and
 * integrity offline before installing. The certification pipeline (lint → sandbox
 * → security scan → sign) runs `lintManifest` + `signBundle` here.
 */

export { DriverManifest, DriverBundle, SignedDriverBundle } from "@supreme/domain-model";

/** Define and validate a driver manifest at authoring time. */
export function defineManifest(manifest: unknown): DriverManifest {
  return DriverManifest.parse(manifest);
}

export interface LintIssue {
  level: "error" | "warning";
  message: string;
}

/**
 * Lint a manifest beyond schema validity — the first gate of the certification
 * pipeline. Schema-invalid manifests throw; this surfaces policy concerns.
 */
export function lintManifest(manifest: DriverManifest): LintIssue[] {
  const issues: LintIssue[] = [];
  if (manifest.channel === "official" && manifest.publisher !== "Supreme Domotics") {
    issues.push({ level: "error", message: "official channel is reserved for Supreme Domotics" });
  }
  if (manifest.protocols.includes("matter") && !manifest.shipsDisabled) {
    issues.push({
      level: "warning",
      message: "Matter drivers should ship disabled (opt-in) per §9",
    });
  }
  if (manifest.capabilities.length === 0) {
    issues.push({ level: "error", message: "a driver must declare at least one capability" });
  }
  return issues;
}

/** Build an unsigned bundle, computing the content hash of the adapter payload. */
export function createBundle(input: {
  manifest: DriverManifest;
  /** The adapter payload bytes (code/assets). For Phase 2 this may be a stub. */
  payload: string | Buffer;
  bundleUrl: string;
  changelog?: string;
}): DriverBundle {
  return DriverBundle.parse({
    manifest: input.manifest,
    contentHash: sha256Hex(input.payload),
    bundleUrl: input.bundleUrl,
    status: "published",
    changelog: input.changelog ?? "",
  });
}

/** Sign a bundle with a publisher signing key (final certification step). */
export function signBundle(
  bundle: DriverBundle,
  privateKeyPem: string,
  signingKeyId: string,
): SignedDriverBundle {
  return {
    bundle,
    signature: signPayload(bundle, privateKeyPem),
    signingKeyId,
  };
}

/**
 * Verify a signed bundle against a trusted publisher public key. Checks both the
 * signature and that the declared content hash matches the provided payload (when
 * the hub has downloaded it).
 */
export function verifyBundle(
  signed: SignedDriverBundle,
  publicKeyPem: string,
  payload?: string | Buffer,
): boolean {
  if (!verifyPayload(signed.bundle, signed.signature, publicKeyPem)) return false;
  if (payload !== undefined && sha256Hex(payload) !== signed.bundle.contentHash) return false;
  return true;
}
