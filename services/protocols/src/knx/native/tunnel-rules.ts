/**
 * Rules for tunnelling carried inside a KNX IP Secure session (stream mode) — fail-closed registry (§ KNX Secure — tunnelling architecture, T2).
 * Each rule is either VERIFIED (a value plus the exact supplied clause it comes from) or UNVERIFIED (a blocker id from
 * docs/architecture/knx-secure-blocker-matrix.md). A tunnel client over a stream link refuses to be constructed on a REAL transport while
 * any rule is unverified, so a blocker cannot be bypassed by forgetting it. Only an in-memory (simulated) transport may run unverified rules,
 * and then only with the placeholder behaviour documented per rule.
 */
export interface VerifiedRule<T> { readonly value: T; readonly source: string }
export interface BlockedRule { readonly unverified: string; readonly simulatorPlaceholder: string }
export type Rule<T> = VerifiedRule<T> | BlockedRule;

export interface StreamTunnelRules {
  /** TUN v01.07.01 §2.6.2: "For TCP communication, no TUNNELLING_ACK shall be sent." */
  readonly sendTunnellingAck: VerifiedRule<false>;
  /** TUN §2.6.2: "Received TUNNELLING_ACK Frames shall be ignored." */
  readonly processReceivedAck: VerifiedRule<false>;
  /** TUN §2.6.2: "the sequence counter shall not be evaluated by the receiver." */
  readonly evaluateReceiveSequence: VerifiedRule<false>;
  /** TUN §2.6.2: "The sender may set the sequence counter to zero." (permission, not obligation; zero is the simplest permitted choice) */
  readonly sendSequence: VerifiedRule<0>;
  readonly hpaiInConnectionFrames: BlockedRule;      // B3: HPAI/addressing of CONNECT/CONNECTIONSTATE/DISCONNECT inside TCP (Core v2)
  readonly connectionLiveness: BlockedRule;          // B4: whether/how CONNECTIONSTATE heartbeats apply on TCP (Core v2)
  readonly disconnectAndSlotCleanup: BlockedRule;    // B5: DISCONNECT_REQUEST requirement/response on TCP, slot release (Core v2, Overview)
  readonly statusCodes: BlockedRule;                 // B1: numeric connection/status codes (Overview)
  readonly partialFrameTimeout: BlockedRule;         // B8: receive timeout for an incomplete frame (Core v2)
}

const N262 = "TUN v01.07.01 §2.6.2 (N)";
export const STREAM_RULES: StreamTunnelRules = {
  sendTunnellingAck: { value: false, source: N262 },
  processReceivedAck: { value: false, source: N262 },
  evaluateReceiveSequence: { value: false, source: N262 },
  sendSequence: { value: 0, source: N262 },
  hpaiInConnectionFrames: { unverified: "B3", simulatorPlaceholder: "the UDP route-back HPAI encoding is reused; the simulated server ignores it" },
  connectionLiveness: { unverified: "B4", simulatorPlaceholder: "no KNX-level heartbeat is sent (the secure session's own KEEPALIVE is the only liveness, IPS §2.2.3.5.2)" },
  disconnectAndSlotCleanup: { unverified: "B5", simulatorPlaceholder: "no DISCONNECT_REQUEST is sent; ending the secure session closes contained connections implicitly (IPS §2.4.2, N); a received DISCONNECT_REQUEST closes the tunnel without a response" },
  statusCodes: { unverified: "B1", simulatorPlaceholder: "the existing (unverified) status table is used for messages only; no behaviour depends on a numeric code" },
  partialFrameTimeout: { unverified: "B8", simulatorPlaceholder: "none" },
};

/** Blocker ids of every rule that is not verified. */
export function unverifiedBlockers(r: StreamTunnelRules): string[] {
  return Object.values(r).flatMap((x) => ("unverified" in x ? [x.unverified] : []));
}
