import dgram from "node:dgram";

/**
 * mDNS / DNS-SD discovery (§3). Devialet (and Shelly, AirPlay, Chromecast, HomeKit…)
 * announce over Bonjour — multicast DNS on 224.0.0.251:5353 — NOT SSDP. This is a
 * hand-rolled DNS-SD browser on pure Node `dgram` (no dependency): it sends a PTR query
 * for a service type and correlates the PTR/SRV/A/TXT records in the responses into
 * resolved service instances. The DNS wire codec (incl. name compression) is the real,
 * unit-tested IP; the socket is injectable so it's testable without real multicast.
 */
export interface MdnsService {
  /** Instance name, e.g. "Phantom-1234._devialet-http._tcp.local". */
  name: string;
  host: string;
  port: number;
  addresses: string[];
  txt: Record<string, string>;
}

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;

// ── Encode ──────────────────────────────────────────────────────────────────────
function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".");
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, "utf8");
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

/** A DNS PTR query for a service type (QU bit set → responders unicast back to us). */
export function encodeQuery(serviceType: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID (0 for mDNS)
  header.writeUInt16BE(0, 2); // flags: standard query
  header.writeUInt16BE(1, 4); // QDCOUNT
  const q = Buffer.concat([
    encodeName(serviceType),
    Buffer.from([(TYPE.PTR >> 8) & 0xff, TYPE.PTR & 0xff]),
    Buffer.from([0x80, 0x01]), // CLASS IN + unicast-response (QU) bit
  ]);
  return Buffer.concat([header, q]);
}

// ── Decode ──────────────────────────────────────────────────────────────────────
/** Read a (possibly compressed) DNS name. Returns [name, offsetAfterTheNameField]. */
export function readName(buf: Buffer, offset: number): [string, number] {
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

interface RawRecord {
  name: string;
  type: number;
  rdata: { ptr?: string; srvTarget?: string; srvPort?: number; a?: string; txt?: Record<string, string> };
}

export interface DnsMessage {
  records: RawRecord[];
}

/** Decode a DNS message, returning all answer/authority/additional records we care about. */
export function decodeMessage(buf: Buffer): DnsMessage {
  const qd = buf.readUInt16BE(4);
  const counts = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) {
    const [, next] = readName(buf, off);
    off = next + 4; // type + class
  }
  const records: RawRecord[] = [];
  for (let i = 0; i < counts; i++) {
    const [name, afterName] = readName(buf, off);
    const type = buf.readUInt16BE(afterName);
    const rdlength = buf.readUInt16BE(afterName + 8);
    const rdStart = afterName + 10;
    const rec: RawRecord = { name, type, rdata: {} };
    if (type === TYPE.PTR) {
      rec.rdata.ptr = readName(buf, rdStart)[0];
    } else if (type === TYPE.SRV) {
      rec.rdata.srvPort = buf.readUInt16BE(rdStart + 4);
      rec.rdata.srvTarget = readName(buf, rdStart + 6)[0];
    } else if (type === TYPE.A) {
      rec.rdata.a = `${buf[rdStart]}.${buf[rdStart + 1]}.${buf[rdStart + 2]}.${buf[rdStart + 3]}`;
    } else if (type === TYPE.TXT) {
      rec.rdata.txt = parseTxt(buf, rdStart, rdlength);
    }
    records.push(rec);
    off = rdStart + rdlength;
  }
  return { records };
}

function parseTxt(buf: Buffer, start: number, length: number): Record<string, string> {
  const out: Record<string, string> = {};
  let p = start;
  const end = start + length;
  while (p < end) {
    const len = buf[p]!;
    const s = buf.toString("utf8", p + 1, p + 1 + len);
    const eq = s.indexOf("=");
    if (eq > 0) out[s.slice(0, eq)] = s.slice(eq + 1);
    else if (s) out[s] = "";
    p += 1 + len;
  }
  return out;
}

/** Correlate a set of DNS records into resolved service instances for a service type. */
export function resolveServices(records: RawRecord[], serviceType: string): MdnsService[] {
  const ptrs = records.filter((r) => r.type === TYPE.PTR && r.name.endsWith(serviceType)).map((r) => r.rdata.ptr!);
  const srvByName = new Map(records.filter((r) => r.type === TYPE.SRV).map((r) => [r.name, r]));
  const txtByName = new Map(records.filter((r) => r.type === TYPE.TXT).map((r) => [r.name, r.rdata.txt ?? {}]));
  const aByHost = new Map<string, string[]>();
  for (const r of records.filter((r) => r.type === TYPE.A)) {
    aByHost.set(r.name, [...(aByHost.get(r.name) ?? []), r.rdata.a!]);
  }
  const out: MdnsService[] = [];
  for (const name of new Set(ptrs)) {
    const srv = srvByName.get(name);
    if (!srv?.rdata.srvTarget) continue;
    out.push({
      name,
      host: srv.rdata.srvTarget,
      port: srv.rdata.srvPort ?? 0,
      addresses: aByHost.get(srv.rdata.srvTarget) ?? [],
      txt: txtByName.get(name) ?? {},
    });
  }
  return out;
}

// ── Browse ──────────────────────────────────────────────────────────────────────
export interface MdnsSocket {
  on(event: "message", cb: (msg: Buffer, rinfo: { address: string }) => void): void;
  bind(cb: () => void): void;
  send(msg: Buffer, port: number, host: string): void;
  close(): void;
}
export type MdnsSocketFactory = () => MdnsSocket;

export interface MdnsBrowseOptions {
  timeoutMs?: number;
  createSocket?: MdnsSocketFactory;
}

const MDNS_HOST = "224.0.0.251";
const MDNS_PORT = 5353;

/** Browse a DNS-SD service type (e.g. "_devialet-http._tcp.local") over mDNS. */
export function mdnsBrowse(serviceType: string, opts: MdnsBrowseOptions = {}): Promise<MdnsService[]> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const socket = (opts.createSocket ?? defaultSocket)();
  const records: RawRecord[] = [];
  return new Promise<MdnsService[]>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(resolveServices(records, serviceType));
    };
    socket.on("message", (msg) => {
      try {
        records.push(...decodeMessage(msg).records);
      } catch {
        /* ignore malformed */
      }
    });
    socket.bind(() => socket.send(encodeQuery(serviceType), MDNS_PORT, MDNS_HOST));
    const t = setTimeout(finish, timeoutMs);
    (t as { unref?: () => void }).unref?.();
  });
}

function defaultSocket(): MdnsSocket {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  return {
    on: (e, cb) => sock.on(e, cb),
    bind: (cb) => sock.bind(cb),
    send: (msg, port, host) => sock.send(msg, port, host),
    close: () => sock.close(),
  };
}
