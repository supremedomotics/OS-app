/**
 * supreme-lan wire protocol (§ Production Architecture Refactor — SupremeOS LAN Transport
 * Service). Every payload that crosses the NATS boundary between a Gateway-side transport client
 * and the `supreme-lan` server. Deliberately carries ONLY transport-shaped data (bytes, addresses,
 * ports) — never a Supreme domain concept (`DeviceId`, `CapabilityKind`, etc.) and never a
 * protocol-specific field (no Casambi opcode, no DNS-SD record, no SSDP header). That split is the
 * whole point of this service: `supreme-lan` must stay reusable by every current and future LAN
 * protocol, not just the one that motivated it.
 *
 * Datagram bytes travel as base64 in the JSON payload — both `@supreme/messaging` event bus
 * implementations round-trip every message through `JSON.stringify`/`JSON.parse` (see
 * `InProcessEventBus.publish`, `NatsEventBus.publish`), so a raw `Buffer`/`Uint8Array` cannot
 * survive the trip. This is a disclosed encoding choice, not an oversight.
 */

/** Every session (one open UDP socket) gets a unique id so multiple drivers — Casambi UDP, KNX
 * discovery, mDNS, SSDP, and any future LAN protocol — can multiplex independent "sockets" over
 * the SAME NATS connection without cross-talk. */
export type LanSessionId = string;

export interface LanUdpBindOptions {
  /** 0 or omitted = let the OS pick an ephemeral port (matches `dgram.Socket.bind()` semantics). */
  localPort?: number;
  /** Omitted = bind all interfaces (0.0.0.0), matching every existing `defaultSocket()` in this
   * codebase today. */
  localAddress?: string;
  reuseAddr?: boolean;
  /** Enables sending to/receiving broadcast addresses (`dgram.Socket.setBroadcast(true)`) —
   * required only for SENDING broadcast; receiving it needs no special socket option on any
   * mainstream OS (see `docs/architecture/Casambi-UDP-Receive-Pipeline-Audit.md` §2). */
  broadcast?: boolean;
  /** Join this multicast group after binding (e.g. "224.0.0.251" for mDNS, "239.255.255.250" for
   * SSDP, "224.0.23.12" for KNX routing/discovery). */
  multicastGroup?: string;
  /** Outgoing-interface hint for the multicast join — required on a multi-homed host, exactly
   * the same real-world gap `knx-discovery.ts`'s `setMulticast(interfaceAddress)` already
   * documents and fixes for the in-process case. */
  multicastInterface?: string;
}

export interface LanBindRequest {
  replySubject: string;
  opts: LanUdpBindOptions;
}
export type LanBindResponse =
  | { ok: true; sessionId: LanSessionId; localAddress: string; localPort: number }
  | { ok: false; error: string };

export interface LanSendRequest {
  replySubject: string;
  sessionId: LanSessionId;
  host: string;
  port: number;
  dataBase64: string;
}
/** § ENETUNREACH investigation — a failed send carries a real routing diagnosis (see
 * `server/routing-diagnosis.ts`), so the Gateway side can tell an installer WHICH layer failed
 * (deployment / routing / gateway) instead of surfacing a bare errno. Typed loosely here (the
 * wire layer stays free of the diagnosis module's internals); `RoutingDiagnosis` is the real
 * shape. Absent on older servers and on non-routing failures — never fabricated. */
export type LanSendResponse = { ok: true } | { ok: false; error: string; diagnosis?: unknown };

export interface LanCloseRequest {
  replySubject: string;
  sessionId: LanSessionId;
}
export type LanCloseResponse = { ok: true };

export interface LanJoinMulticastRequest {
  replySubject: string;
  sessionId: LanSessionId;
  group: string;
  iface?: string;
}
export type LanJoinMulticastResponse = { ok: true } | { ok: false; error: string };

export interface LanRxEvent {
  sessionId: LanSessionId;
  dataBase64: string;
  rinfo: { address: string; port: number };
  receivedAt: string;
}
export interface LanErrorEvent {
  sessionId: LanSessionId;
  message: string;
  at: string;
}
export interface LanListeningEvent {
  sessionId: LanSessionId;
  localAddress: string;
  localPort: number;
}
export interface LanClosedEvent {
  sessionId: LanSessionId;
}

/** One open session's real, non-fabricated counters — the per-session slice of
 * {@link LanDiagnosticsSnapshot}. Mirrors the vocabulary `services/protocols/src/core/
 * driver-health-engine.ts` and `driver-metrics-engine.ts` already use (counters + latency, no
 * invented "score" beyond what those modules define), scoped to a transport session instead of a
 * driver. */
export interface LanSessionDiagnostics {
  sessionId: LanSessionId;
  localAddress: string | null;
  localPort: number | null;
  multicastGroup: string | null;
  packetsSent: number;
  packetsReceived: number;
  lastError: string | null;
  /** § LAN receive-path investigation — ISO timestamp of a SUCCESSFUL multicast join, or `null`.
   * Deliberately separate from {@link joinedMulticastButNeverReceived}: a join succeeding proves
   * nothing about delivery (on Docker bridge it succeeds and nothing ever arrives). */
  joinedMulticastAt?: string | null;
  /** True when a group was joined but this socket has NEVER received anything — the exact,
   * otherwise-silent Docker-bridge multicast failure. Callers report this as WAITING/FAIL. */
  joinedMulticastButNeverReceived?: boolean;
}

/** Service-wide diagnostics. `deployment` is read from this service's OWN configuration (see
 * `server/deployment.ts`), never inferred from OS network interfaces — a process cannot reliably
 * determine from inside its own network namespace whether it shares the host's, and this
 * codebase's standing rule is to never fabricate a fact it cannot verify. */
export interface LanDiagnosticsSnapshot {
  /** § Production Architecture Direction — the configured deployment id. Deliberately an open
   * string on the wire rather than a Docker-shaped union: the shipping target is a native
   * SupremeOS system service, and adding a future deployment must not require a wire-protocol
   * change. Authoritative values live in `server/deployment.ts`. */
  deployment: string;
  deploymentLabel: string;
  /** The deployment-NEUTRAL fact consumers should branch on: can this process reach the physical
   * LAN directly? True/false regardless of Docker, systemd, VM, or bare metal. */
  lanAccess: "direct" | "isolated" | "unknown";
  natsConnected: boolean;
  uptimeSec: number;
  interfaces: { name: string; address: string; internal: boolean }[];
  sessions: LanSessionDiagnostics[];
}
export interface LanHealthRequest {
  replySubject: string;
}
export type LanHealthResponse = LanDiagnosticsSnapshot;

/**
 * § Runtime Data Path Verification — the deep forensics request. Separate from
 * {@link LanHealthRequest} on purpose: health is a cheap, frequently-polled liveness view, while
 * this reads `/proc` and walks every session, so it is requested deliberately when someone is
 * actually diagnosing a receive-path failure.
 *
 * Both payloads are typed loosely on the wire (`unknown`) so the transport's wire protocol does
 * not have to restate the forensics module's internals; `NetworkForensics`, `SocketForensics`, and
 * `UdpProbeSnapshot` in `server/network-forensics.ts` / `server/udp-probe.ts` are the real shapes.
 * Keeping them out of this file is the same rule that keeps deployment vocabulary out of it.
 */
export interface LanForensicsRequest {
  replySubject: string;
}
export interface LanForensicsResponse {
  /** Live network namespace facts read from the running kernel. */
  network: unknown;
  /** Per-session socket forensics, one entry per open transport session. */
  sockets: { sessionId: LanSessionId; forensics: unknown }[];
  /** The independent UDP probe's snapshot, or `null` when no probe is configured — never a
   * fabricated zeroed snapshot, which would be indistinguishable from "a probe ran and saw
   * nothing", the single most important distinction in this whole diagnosis. */
  probe: unknown | null;
  /** Why the probe is absent, when it is. `null` when a probe IS running. */
  probeDisabledReason: string | null;
}

/** NATS-style subject names (`.`-delimited, matching `@supreme/messaging`'s `subjectMatches`
 * token semantics). Commands are request/reply (see `../shared/rpc.ts`); session events are
 * fire-and-forget publishes scoped per session so a subscriber only ever needs to listen to the
 * one subject tree for the session it opened. */
export const lanSubjects = {
  bind: "supreme.lan.udp.bind",
  send: "supreme.lan.udp.send",
  close: "supreme.lan.udp.close",
  joinMulticast: "supreme.lan.udp.joinMulticast",
  health: "supreme.lan.health",
  forensics: "supreme.lan.forensics",
  sessionRx: (sessionId: LanSessionId): string => `supreme.lan.session.${sessionId}.rx`,
  sessionError: (sessionId: LanSessionId): string => `supreme.lan.session.${sessionId}.error`,
  sessionListening: (sessionId: LanSessionId): string => `supreme.lan.session.${sessionId}.listening`,
  sessionClosed: (sessionId: LanSessionId): string => `supreme.lan.session.${sessionId}.closed`,
} as const;
