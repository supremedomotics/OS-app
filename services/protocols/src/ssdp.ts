import dgram from "node:dgram";

/**
 * SSDP / UPnP discovery (§3). Sends an M-SEARCH to the SSDP multicast group
 * (239.255.255.250:1900) and collects the unicast responses — the standard way UPnP
 * devices (Sonos ZonePlayers, WiiM/LinkPlay & other MediaRenderers) announce on the
 * LAN. Pure Node `dgram`, no dependency. The socket is injectable so the M-SEARCH +
 * response parsing are unit-tested without real multicast.
 */
export interface SsdpResponse {
  /** Device IP (the responder's source address). */
  address: string;
  location?: string;
  server?: string;
  st?: string;
  usn?: string;
}

/** Minimal UDP socket surface (so tests can inject a fake). */
export interface SsdpSocket {
  on(event: "message", cb: (msg: Buffer, rinfo: { address: string }) => void): void;
  bind(cb: () => void): void;
  send(msg: Buffer, port: number, host: string): void;
  close(): void;
}
export type SsdpSocketFactory = () => SsdpSocket;

const SSDP_HOST = "239.255.255.250";
const SSDP_PORT = 1900;

/** Parse a raw SSDP/HTTP response into headered fields (case-insensitive). */
export function parseSsdpResponse(raw: string, address: string): SsdpResponse {
  const out: SsdpResponse = { address };
  for (const line of raw.split(/\r\n|\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "location") out.location = value;
    else if (key === "server") out.server = value;
    else if (key === "st") out.st = value;
    else if (key === "usn") out.usn = value;
  }
  return out;
}

export interface SsdpSearchOptions {
  /** Search target, e.g. "ssdp:all" or "urn:schemas-upnp-org:device:ZonePlayer:1". */
  st?: string;
  timeoutMs?: number;
  createSocket?: SsdpSocketFactory;
}

/** Run an M-SEARCH and collect responses until the timeout. Deduped by address+usn. */
export function ssdpSearch(opts: SsdpSearchOptions = {}): Promise<SsdpResponse[]> {
  const st = opts.st ?? "ssdp:all";
  const timeoutMs = opts.timeoutMs ?? 2500;
  const socket = (opts.createSocket ?? defaultSocket)();
  const found = new Map<string, SsdpResponse>();

  const message = Buffer.from(
    [
      "M-SEARCH * HTTP/1.1",
      `HOST: ${SSDP_HOST}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      "MX: 2",
      `ST: ${st}`,
      "",
      "",
    ].join("\r\n"),
  );

  return new Promise<SsdpResponse[]>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve([...found.values()]);
    };
    socket.on("message", (msg, rinfo) => {
      const r = parseSsdpResponse(msg.toString(), rinfo.address);
      found.set(`${r.address}|${r.usn ?? r.st ?? ""}`, r);
    });
    socket.bind(() => {
      socket.send(message, SSDP_PORT, SSDP_HOST);
    });
    const t = setTimeout(finish, timeoutMs);
    (t as { unref?: () => void }).unref?.();
  });
}

function defaultSocket(): SsdpSocket {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  return {
    on: (event, cb) => sock.on(event, cb),
    bind: (cb) => sock.bind(cb),
    send: (msg, port, host) => sock.send(msg, port, host),
    close: () => sock.close(),
  };
}
