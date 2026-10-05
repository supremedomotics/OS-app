import dgram from "node:dgram";
import os from "node:os";

/**
 * Hub-side mDNS/DNS-SD responder (§ apps/new direct client discovery). Advertises
 * `_supremeos._tcp.local` on the LAN so `MdnsHubDiscovery` (apps/new/shared/lib/src/
 * connection/mdns_hub_discovery.dart) can find this hub without a hardcoded IP —
 * the client half of this feature was already real and complete; this is the
 * missing Hub-side half (§Phase9-2).
 *
 * Self-contained hand-rolled DNS-SD on pure Node `dgram` (no dependency), mirroring
 * the existing browse-side pattern in `@supreme/protocols`' `mdns.ts` — but that
 * module's wire codec isn't re-exported through the protocols package's public
 * barrel (`services/protocols/src/index.ts`), so this responder owns its own
 * minimal encoder rather than reaching past the package boundary.
 *
 * Query-triggered only (replies when asked, like every real mDNS responder should);
 * no periodic unsolicited announcements — `MdnsHubDiscovery` always sends its own
 * PTR query first, so nothing needs the extra complexity of a proactive announce
 * loop. Idempotent by construction (no state beyond the socket itself), so a
 * restart never risks a "duplicate" advertisement — the next query after restart
 * gets the exact same answer as before, from a fresh, single responder.
 *
 * § Security model (§ LAN discovery must never equal authorization) — this reply
 * is UNAUTHENTICATED, unencrypted UDP anyone on the LAN can see, by the nature of
 * mDNS itself. It carries ONLY `hubId`/`version`/`txtvers`/optional `projectId`
 * (see `MDNS_TXT_SCHEMA_VERSION`'s doc for the full contract and what is
 * deliberately excluded) — never a credential, token, or anything that grants
 * access on its own. The actual API on the advertised port goes through the
 * SAME Fastify instance (and therefore the SAME auth middleware/route guards) as
 * the existing 8080/Caddy-443 path — discovering the hub's address is not, by
 * itself, a way to control it. That connection itself is still plain HTTP (not
 * TLS) on this port, matching the existing internal 8080 listener Caddy already
 * fronts for browser clients — a LAN-local tradeoff accepted for this client
 * architecture, not a gap introduced here; upgrading it to TLS (mirroring
 * Caddy's on-demand internal-CA policy) is future work if that posture changes.
 */

const MDNS_HOST = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE_TYPE = "_supremeos._tcp.local";
const RECORD_TTL_SECONDS = 120;

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;

/** § TXT record contract (locked, versioned) — every key a client may rely on,
 * exactly mirroring `HubMdnsTxtKeys` in apps/new/shared/lib/src/connection/
 * mdns_hub_discovery.dart. Bump `SCHEMA_VERSION` only for a BREAKING change to
 * this set (a key removed, or an existing key's meaning changed) — adding a new
 * optional key is not breaking and doesn't need a bump. A client must ignore
 * unknown TXT keys and tolerate any of the optional ones being absent.
 *
 * - `hubId` (required) — stable identity, survives reinstall/IP change. The ONLY
 *   safe way to recognize "the same hub" across sessions; never key off `host`.
 * - `version` (required) — this hub's software version (`config.hubVersion`),
 *   for a client that wants to gate a feature on a minimum hub version.
 * - `txtvers` (required) — THIS contract's schema version (see above), separate
 *   from `version` (which is the hub's own release, unrelated to the TXT shape).
 * - `projectId` (optional) — the commissioned home's id; absent before Setup
 *   Wizard commissioning (discovery must work pre-setup).
 *
 * Deliberately NOT included, and never to be added casually (§ "don't add
 * fields just because they're possible"): any credential/token/secret (auth
 * happens over the connection itself, never via a broadcast, unencrypted
 * UDP packet anyone on the LAN can see — see mdns-responder's module doc);
 * a display name (installer-set, home-scoped, lives behind the authenticated
 * API, not broadcast pre-auth); device/model/capabilities (same reasoning —
 * a client asks the authenticated API once connected, it doesn't need to know
 * before it even connects). If a future client genuinely needs an unauthenticated
 * hint (e.g. "setup required: yes/no" so a fresh app can distinguish a
 * ready-to-pair hub from an already-commissioned one before connecting), add it
 * as its own reviewed key — don't default to more surface than asked for. */
export const MDNS_TXT_SCHEMA_VERSION = "1";

export interface MdnsResponderOptions {
  /** This hub's stable identity (survives reinstall/rename) — advertised as the
   * `hubId` TXT key, and used to build the DNS-SD instance name. */
  hubId: string;
  /** The commissioned home's id, once one exists — omitted before Setup Wizard
   * commissioning (discovery must still work pre-setup, that's exactly when a
   * fresh client needs to find the hub). */
  projectId?: string;
  protocolVersion: string;
  /** The port this hub's direct client-control API listens on (§7272 convention,
   * `SupremeOSHubDefaults.defaultPort` on the Dart side). */
  port: number;
  onLog?: (message: string) => void;
}

export interface MdnsResponderHandle {
  stop(): void;
}

// ── Encode ──────────────────────────────────────────────────────────────────────
export function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".");
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, "utf8");
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function encodeRdata(rdata: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(rdata.length, 0);
  return Buffer.concat([len, rdata]);
}

function encodeRecordHeader(name: string, type: number, ttlSeconds: number): Buffer {
  const rest = Buffer.alloc(8);
  rest.writeUInt16BE(type, 0);
  rest.writeUInt16BE(0x8001, 2); // CLASS IN + cache-flush bit (standard for mDNS responses)
  rest.writeUInt32BE(ttlSeconds, 4);
  return Buffer.concat([encodeName(name), rest]);
}

export function encodePtrAnswer(serviceType: string, instanceName: string): Buffer {
  return Buffer.concat([encodeRecordHeader(serviceType, TYPE.PTR, RECORD_TTL_SECONDS), encodeRdata(encodeName(instanceName))]);
}

export function encodeSrvAnswer(instanceName: string, target: string, port: number): Buffer {
  const rdata = Buffer.alloc(6);
  rdata.writeUInt16BE(0, 0); // priority
  rdata.writeUInt16BE(0, 2); // weight
  rdata.writeUInt16BE(port, 4);
  return Buffer.concat([
    encodeRecordHeader(instanceName, TYPE.SRV, RECORD_TTL_SECONDS),
    encodeRdata(Buffer.concat([rdata, encodeName(target)])),
  ]);
}

export function encodeTxtAnswer(instanceName: string, txt: Record<string, string>): Buffer {
  const entries = Object.entries(txt).map(([k, v]) => Buffer.from(`${k}=${v}`, "utf8"));
  const rdata = entries.length > 0
    ? Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from([e.length]), e])))
    : Buffer.from([0]); // an empty TXT record is one zero-length string, never zero bytes
  return Buffer.concat([encodeRecordHeader(instanceName, TYPE.TXT, RECORD_TTL_SECONDS), encodeRdata(rdata)]);
}

export function encodeAAnswer(target: string, address: string): Buffer {
  const octets = address.split(".").map((n) => Number(n) & 0xff);
  return Buffer.concat([encodeRecordHeader(target, TYPE.A, RECORD_TTL_SECONDS), encodeRdata(Buffer.from(octets))]);
}

export function encodeResponse(answers: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID
  header.writeUInt16BE(0x8400, 2); // flags: QR=1 (response), AA=1 (authoritative)
  header.writeUInt16BE(0, 4); // QDCOUNT
  header.writeUInt16BE(answers.length, 6); // ANCOUNT
  return Buffer.concat([header, ...answers]);
}

// ── Decode (just enough to find "is this asking about us?") ─────────────────────
/** Read a (possibly compressed) DNS name. Returns [name, offsetAfterTheNameField]. */
function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let pos = offset;
  let jumped = false;
  let next = offset;
  let guard = 0;
  while (guard++ < 128) {
    const len = buf[pos]!;
    if (len === 0) {
      if (!jumped) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (!jumped) next = pos + 2;
      jumped = true;
      pos = ptr;
      continue;
    }
    labels.push(buf.toString("utf8", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return [labels.join("."), next];
}

/** The names asked about in a QUERY message's question section. */
export function decodeQuestionNames(buf: Buffer): string[] {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const names: string[] = [];
  let off = 12;
  for (let i = 0; i < qd; i++) {
    if (off >= buf.length) break;
    const [name, next] = readName(buf, off);
    names.push(name);
    off = next + 4; // type + class
  }
  return names;
}

/** This host's real, non-internal, non-virtual IPv4 interfaces — the same "never
 * fabricate a network identity" posture the rest of this codebase's LAN discovery
 * already follows (see `knx-discovery.ts`'s `listKnxNetworkInterfaces`). Excludes
 * loopback/link-local; a Hyper-V/WSL/Docker-only host simply advertises nothing,
 * which is honest (no real LAN interface to be found on). Returns per-interface
 * name too — a multi-NIC hub (Ethernet + Wi-Fi both up) needs to JOIN the
 * multicast group on each one individually (an unqualified `addMembership` only
 * joins on the OS's single default-route interface, so a query arriving on the
 * OTHER interface would never be seen at all). */
function localIPv4Interfaces(): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal && isLanAdvertisable(name, addr.address)) {
        out.push({ name, address: addr.address });
      }
    }
  }
  return out;
}

/** A phone resolves the SRV host's A records and keeps the first one it gets, so every address
 * advertised here must be reachable from the LAN. A VPN/overlay or container-bridge address
 * (Tailscale's 100.64.0.0/10, `docker0`, `veth*`…) is not — advertising it made pairing fail with
 * no Hub-side trace whenever the phone happened to pick it. Matched by interface name and by the
 * CGNAT range, since neither signal alone covers every overlay. */
const VIRTUAL_INTERFACE = /^(tailscale|ts|wg|zt|tun|tap|utun|docker|br-|veth|virbr)/;
export function isLanAdvertisable(name: string, address: string): boolean {
  if (VIRTUAL_INTERFACE.test(name)) return false;
  const [a, b] = address.split(".").map(Number);
  return !(a === 100 && b !== undefined && b >= 64 && b <= 127);
}

/** Starts the responder. Best-effort: a sandboxed/CI network with no
 * multicast-capable interface simply never answers anything (matches this
 * codebase's existing `mdnsBrowse`/`knxSearch` posture) — never a boot-blocking
 * failure. Interface membership is re-resolved on every incoming query (not
 * cached at start), so a hub that gains/loses a NIC after boot (Wi-Fi
 * reconnects, a USB Ethernet dongle is plugged in, DHCP renews to a new
 * address) is always answered with its CURRENT real addresses, never a stale
 * snapshot from startup. */
export function startMdnsResponder(opts: MdnsResponderOptions): MdnsResponderHandle {
  const hostname = `${opts.hubId}.local`;
  const instanceName = `${opts.hubId}.${SERVICE_TYPE}`;
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const joinedInterfaces = new Set<string>();

  /** Join every currently-known interface's multicast membership that we haven't
   * already joined — safe to call repeatedly (already-joined addresses are
   * simply skipped), so a NIC that appears after boot still gets picked up the
   * next time a query arrives, without needing a separate poll/watch loop. */
  function ensureMembershipsCurrent(interfaces: { name: string; address: string }[]): void {
    for (const iface of interfaces) {
      if (joinedInterfaces.has(iface.address)) continue;
      try {
        socket.addMembership(MDNS_HOST, iface.address);
        joinedInterfaces.add(iface.address);
        opts.onLog?.(`mdns-responder: joined multicast group on interface ${iface.name} (${iface.address})`);
      } catch (err) {
        // Not multicast-capable, or already a member via another path — never fatal.
        opts.onLog?.(`mdns-responder: could not join multicast on ${iface.name} (${iface.address}) — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  socket.on("message", (msg, rinfo) => {
    let questionNames: string[];
    try {
      questionNames = decodeQuestionNames(msg);
    } catch (err) {
      // A malformed/truncated packet on port 5353 (this port sees ALL mDNS traffic
      // on the LAN, not just ours) — reject it quietly, never crash the responder.
      opts.onLog?.(`mdns-responder: rejected malformed packet from ${rinfo.address} — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!questionNames.some((n) => n === SERVICE_TYPE)) return;
    try {
      const interfaces = localIPv4Interfaces();
      if (interfaces.length === 0) return;
      ensureMembershipsCurrent(interfaces);
      const txt: Record<string, string> = { hubId: opts.hubId, version: opts.protocolVersion, txtvers: MDNS_TXT_SCHEMA_VERSION };
      if (opts.projectId) txt.projectId = opts.projectId;
      const answers = [
        encodePtrAnswer(SERVICE_TYPE, instanceName),
        encodeSrvAnswer(instanceName, hostname, opts.port),
        encodeTxtAnswer(instanceName, txt),
        ...interfaces.map((iface) => encodeAAnswer(hostname, iface.address)),
      ];
      opts.onLog?.(`mdns-responder: discovery request from ${rinfo.address} — answering with ${interfaces.length} address(es)`);
      socket.send(encodeResponse(answers), MDNS_PORT, MDNS_HOST);
    } catch (err) {
      opts.onLog?.(`mdns-responder: failed to answer query from ${rinfo.address} — ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  socket.on("error", (err) => opts.onLog?.(`mdns-responder: socket error — ${err.message}`));
  socket.bind(MDNS_PORT, () => {
    const interfaces = localIPv4Interfaces();
    ensureMembershipsCurrent(interfaces);
    opts.onLog?.(`mdns-responder: started — advertising ${SERVICE_TYPE} as ${instanceName} on port ${opts.port} (${interfaces.length} interface(s) known at startup)`);
  });

  return {
    stop: () => {
      try {
        socket.close();
        opts.onLog?.("mdns-responder: stopped");
      } catch {
        /* already closed */
      }
    },
  };
}
