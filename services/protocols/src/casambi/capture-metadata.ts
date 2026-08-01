/**
 * § Real Hardware Certification — the Casambi-specific shape of `PacketCapture.metadata`
 * (`@supreme/lan`'s `metadata` field is an untyped `Record<string, unknown>` bag, deliberately,
 * since the transport layer has no business knowing what "Net ID" means). This type documents
 * the fields the certification workflow actually reads/writes — every field is nullable because
 * "not known" must stay an honest `null`, never a guessed value.
 */
export interface CasambiCaptureMetadata {
  /** Lithernet Gateway firmware version string, e.g. "6.25". */
  firmwareVersion: string | null;
  /** Gateway hardware/model version, when known. */
  gatewayVersion: string | null;
  dataFormat: "hex-dot" | "dec-hash" | null;
  /** This bridge's Net ID (0-254) at capture time. */
  netId: number | null;
  /** ISO date (YYYY-MM-DD) the capture was taken, when known. */
  date: string | null;
  /** Free-text — what this capture demonstrates, real vs. synthetic, anything else worth knowing. */
  notes: string | null;
}
