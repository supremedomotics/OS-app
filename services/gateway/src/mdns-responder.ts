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
 * loop.
 */

const MDNS_HOST = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE_TYPE = "_supremeos._tcp.local";
const RECORD_TTL_SECONDS = 120;

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;

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

/** This host's real, non-internal, non-virtual IPv4 addresses — the same "never
 * fabricate a network identity" posture the rest of this codebase's LAN discovery
 * already follows (see `knx-discovery.ts`'s `listKnxNetworkInterfaces`). Excludes
 * loopback/link-local; a Hyper-V/WSL/Docker-only host simply advertises nothing,
 * which is honest (no real LAN interface to be found on). */
function localIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

/** Starts the responder. Best-effort: a sandboxed/CI network with no
 * multicast-capable interface simply never answers anything (matches this
 * codebase's existing `mdnsBrowse`/`knxSearch` posture) — never a boot-blocking
 * failure. */
export function startMdnsResponder(opts: MdnsResponderOptions): MdnsResponderHandle {
  const hostname = `${opts.hubId}.local`;
  const instanceName = `${opts.hubId}.${SERVICE_TYPE}`;
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("message", (msg, rinfo) => {
    try {
      if (!decodeQuestionNames(msg).some((n) => n === SERVICE_TYPE)) return;
      const addresses = localIPv4Addresses();
      if (addresses.length === 0) return;
      const txt: Record<string, string> = { hubId: opts.hubId, version: opts.protocolVersion };
      if (opts.projectId) txt.projectId = opts.projectId;
      const answers = [
        encodePtrAnswer(SERVICE_TYPE, instanceName),
        encodeSrvAnswer(instanceName, hostname, opts.port),
        encodeTxtAnswer(instanceName, txt),
        ...addresses.map((a) => encodeAAnswer(hostname, a)),
      ];
      socket.send(encodeResponse(answers), MDNS_PORT, MDNS_HOST);
    } catch (err) {
      opts.onLog?.(`mdns-responder: failed to answer query from ${rinfo.address} — ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  socket.on("error", (err) => opts.onLog?.(`mdns-responder: socket error — ${err.message}`));
  socket.bind(MDNS_PORT, () => {
    try {
      socket.addMembership(MDNS_HOST);
      opts.onLog?.(`mdns-responder: advertising ${SERVICE_TYPE} as ${instanceName} on port ${opts.port}`);
    } catch (err) {
      // No usable multicast-capable interface — never a boot-blocking failure.
      opts.onLog?.(`mdns-responder: no multicast-capable interface — ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return {
    stop: () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}
