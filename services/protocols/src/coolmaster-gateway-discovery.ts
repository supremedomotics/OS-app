import net from "node:net";
import os from "node:os";
import { CoolMasterAsciiTransport } from "./coolmaster-ascii-protocol.js";
import { cmdInfo } from "./coolmaster-commands.js";
import { DEFAULT_ASCII_PORT } from "./coolmaster-constants.js";
import { parseGatewayInfo } from "./coolmaster-parser.js";

/**
 * CoolMaster GATEWAY discovery (§ REQUIREMENT 2 — True CoolMaster Gateway Auto-Discovery).
 * Deliberately a separate module from coolmaster-discovery.ts: that file discovers what's
 * BEHIND an already-connected gateway (lines/units/props/…); this file finds the gateway
 * itself on the LAN, before any host is known, so the driver can be installed without the
 * installer ever typing an IP address.
 *
 * MECHANISM — why this ships a LAN TCP probe and not an SDDP client:
 * docs/coolmaster/CoolMaster_Core_Reference_Part3_v1.0.txt §5 documents an `sddp` command,
 * but only as a gateway-side CONFIGURATION verb ("Control4 discovery. Functions: Enable -
 * Disable - Identify - Offline - Alive") — it tells an installer how to turn SDDP on/off
 * on the gateway, not what a CoolMaster SDDP reply actually contains on the wire (no
 * packet format, no port, no field names anywhere in this driver's reference set). SDDP
 * itself (Control4's multicast discovery protocol, 239.255.255.250:1902) is publicly
 * documented in the abstract, but CoolMaster's specific reply payload is not — implementing
 * a client against a GUESSED reply shape would be exactly the kind of fabricated protocol
 * behavior this codebase's rules forbid ("never fabricate capabilities... verify by
 * inspecting the actual code/docs first"). Rather than ship an unverifiable SDDP client,
 * this module implements the one mechanism that can be verified from what IS fully
 * documented and already validated by this driver: connecting to a candidate host's
 * ASCII_IF port and confirming the REAL CoolMaster prompt handshake
 * (CoolMasterAsciiTransport.connect(), the exact same handshake coolmaster-connection.ts
 * uses for every normal connection) completes, then reading `info` for gateway identity.
 * A device that isn't a CoolMaster gateway either refuses the TCP connection outright or
 * never produces the ">" prompt within the timeout — both are rejected as "not a match",
 * never guessed at. If CoolMaster firmware documentation for its actual SDDP reply payload
 * becomes available, an SDDP prober can be added here as a first, faster stage ahead of
 * the TCP probe without changing this module's public shape (see `DiscoveredCoolMasterGateway`
 * below, already a stage-agnostic result type) — tracked as a documented limitation, not a
 * silent gap; see docs/coolmaster/README.md.
 */

export interface DiscoveredCoolMasterGateway {
  /** Stable identity (§ Gateway Identity) — prefer this over `host`, which is only ever
   * current configuration/state and can change on a DHCP lease renewal. */
  gatewayId: string;
  serial: string;
  host: string;
  asciiPort: number;
  firmwareVersion: string;
  application: string | null;
}

export interface CoolMasterGatewayDiscoveryOptions {
  /** Explicit hosts to probe instead of scanning the local IPv4 subnets. Tests always set
   * this (deterministic, no real network access); production installer discovery omits it
   * to scan every non-internal IPv4 /24 subnet this host is directly attached to. */
  candidateHosts?: string[];
  asciiPort?: number;
  /** Per-host probe timeout in ms. Short by design — a real CoolMaster gateway answers its
   * prompt near-instantly; a long timeout here would make a full-subnet scan (up to 254
   * hosts) impractically slow. Default 800. */
  timeoutMs?: number;
  /** How many hosts to probe in parallel. Default 32 — bounded so a full /24 scan doesn't
   * open 254 sockets at once. */
  concurrency?: number;
  createSocket?: (host: string, port: number) => net.Socket;
}

const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_CONCURRENCY = 32;

/** Every private, non-internal IPv4 /24 subnet prefix (e.g. "192.168.1.") this host has an
 * interface on — the actual scan universe for a LAN sweep. Excludes loopback/internal
 * interfaces (docker/VPN/link-local handled the same way `discover-supremeos-url`'s own
 * adapter filtering does: `internal === false` is the one reliable signal). */
export function localIPv4SubnetPrefixes(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const prefixes = new Set<string>();
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== "IPv4") continue;
      const parts = info.address.split(".");
      if (parts.length === 4) prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}.`);
    }
  }
  return [...prefixes];
}

/** Expands subnet prefixes into every host address in each /24 (.1-.254, skipping .0/.255). */
export function candidateHostsForSubnets(prefixes: string[]): string[] {
  const hosts: string[] = [];
  for (const prefix of prefixes) {
    for (let i = 1; i <= 254; i++) hosts.push(`${prefix}${i}`);
  }
  return hosts;
}

async function probeHost(
  host: string,
  opts: { asciiPort: number; timeoutMs: number; createSocket?: (host: string, port: number) => net.Socket },
): Promise<DiscoveredCoolMasterGateway | null> {
  const transport = new CoolMasterAsciiTransport({
    host,
    port: opts.asciiPort,
    timeoutMs: opts.timeoutMs,
    createSocket: opts.createSocket,
  });
  try {
    // Identification IS this handshake succeeding — a non-CoolMaster device either
    // refuses the connection or never produces the real ">" prompt within timeoutMs,
    // both of which reject below rather than being treated as a match. Raced against an
    // explicit timer (not just CoolMasterAsciiTransport's own post-TCP-connect greeting
    // timer) because a silently-dropping firewalled host never even reaches "connect" —
    // without this, that host would hang on the OS's own TCP connect timeout (commonly
    // ~2 minutes) instead of honoring opts.timeoutMs.
    await Promise.race([
      transport.connect(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("coolmaster: gateway probe timed out")), opts.timeoutMs)),
    ]);
    const lines = await transport.execute(cmdInfo());
    // § Discovery Safety — live-confirmed fix: a REAL CoolMasterNet's `info` response does
    // NOT report a serial number at all — it reports DIP-switch settings and per-line DC
    // voltage/status, e.g.:
    //   DIP P: | X |ON | X | X |
    //   ...
    //   L1 DC- OFF 16V
    //   OK
    // (live-captured from a real gateway; no "Serial:"/"SN:"/"ID:" field anywhere). An
    // earlier revision of this module rejected exactly this shape as "inconclusive",
    // silently excluding every real gateway from discovery — confirmed and reverted. The
    // real, hardware-verified identification signal is simply: the ASCII_IF prompt
    // handshake completed AND `info` produced a non-empty response — nothing more specific
    // about `info`'s content is safely assertable today (a stricter check, e.g. requiring a
    // trailing "OK" exit code, would risk the exact same false-negative this fix corrects
    // if some other real gateway/firmware formats it differently — unconfirmed, so not
    // assumed). `parseGatewayInfo`'s host-as-serial fallback is therefore the CORRECT
    // behavior here too, not a lenient special case for post-connect callers only.
    if (lines.length === 0) return null;
    const info = parseGatewayInfo(lines, host);
    return { gatewayId: `coolmaster:${info.serial}`, serial: info.serial, host, asciiPort: opts.asciiPort, firmwareVersion: info.firmwareVersion, application: info.application };
  } catch {
    return null;
  } finally {
    // ponytail: if the timeout race loses to a connect() that finishes moments later, that
    // socket is orphaned (disconnect() runs before `transport.socket` is assigned) rather
    // than actively hunted down and destroyed — a single short-lived leaked probe socket
    // per rare slow-responder host, self-resolving when the process/OS reaps it. Upgrade
    // path if this ever matters: give CoolMasterAsciiTransport an AbortSignal instead of
    // racing a second promise around it.
    transport.disconnect();
  }
}

/**
 * Probes for CoolMaster gateways on the LAN and returns one entry per distinct SERIAL
 * (§ Gateway Identity — duplicate replies for the same physical unit, e.g. from two NICs
 * answering, collapse to one result; "first responder wins" for which host/port is kept).
 * Never throws for "found nothing" — an empty array is the honest, expected result when no
 * gateway answers; only a caller-supplied bad option (e.g. a negative timeout) would throw.
 */
export async function discoverCoolMasterGateways(opts: CoolMasterGatewayDiscoveryOptions = {}): Promise<DiscoveredCoolMasterGateway[]> {
  const asciiPort = opts.asciiPort ?? DEFAULT_ASCII_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const hosts = opts.candidateHosts ?? candidateHostsForSubnets(localIPv4SubnetPrefixes());

  const found: DiscoveredCoolMasterGateway[] = [];
  const seenSerials = new Set<string>();
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= hosts.length) return;
      const host = hosts[index]!;
      const result = await probeHost(host, { asciiPort, timeoutMs, createSocket: opts.createSocket });
      if (result && !seenSerials.has(result.serial)) {
        seenSerials.add(result.serial);
        found.push(result);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found;
}
