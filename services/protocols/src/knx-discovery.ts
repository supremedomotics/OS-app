import dgram from "node:dgram";
import os from "node:os";

/**
 * KNXnet/IP discovery (§3, §7) — the standard way to find KNX IP interfaces/routers on a LAN.
 * A SEARCH_REQUEST is multicast to the KNX system-setup group (224.0.23.12:3671); every KNXnet/IP
 * server answers with a SEARCH_RESPONSE carrying its control endpoint (IP:port), KNX individual
 * address and friendly name. That is exactly what the installer needs to configure the tunnelling
 * driver ({@link KnxProtocolDriver} `host`/`port`). Pure Node `dgram`; the socket is injectable so
 * frame encode + response parsing are unit-tested without real multicast.
 *
 * Frame layout follows the KNXnet/IP Core spec: a 6-byte header (0x06 0x10, service type, total
 * length) + an 8-byte HPAI. SEARCH_RESPONSE adds a control HPAI and a 54-byte Device Information DIB.
 */

const KNX_MULTICAST = "224.0.23.12";
const KNX_PORT = 3671;
const HEADER_LEN = 0x06;
const PROTOCOL_V10 = 0x10;
const SEARCH_REQUEST = 0x0201;
const SEARCH_RESPONSE = 0x0202;
const HPAI_IPV4_UDP = 0x01;
const DIB_DEVICE_INFO = 0x01;

export interface KnxGateway {
  /** Control-endpoint IP (use as the driver `host`). */
  address: string;
  /** Control-endpoint UDP port (KNXnet/IP is 3671). */
  port: number;
  /** KNX individual address of the interface, e.g. "1.1.0". */
  individualAddress: string;
  /** Friendly device name advertised by the interface. */
  name: string;
  /** KNX routing multicast address the device is configured for. */
  multicastAddress?: string;
  macAddress?: string;
  /** Parsed from the SUPP_SVC_FAMILIES DIB when the response includes one — null (never
   * guessed) when the response doesn't carry that DIB at all. Manufacturer name and KNX
   * Secure capability are NOT reported: the SEARCH_RESPONSE carries no manufacturer name
   * (only a numeric KNX manufacturer ID this codebase has no lookup table for), and this
   * codebase has not verified the exact IP-Secure service-family byte value against the
   * KNX Association spec — reporting either would be a guess this project's "never
   * fabricate" rule forbids. */
  tunnellingCapable: boolean | null;
  routingCapable: boolean | null;
}

/** Minimal UDP socket surface (so tests can inject a fake). `bind`'s address/
 * `setMulticast`'s interface param are optional so an existing fake that only ever
 * implements the no-arg forms keeps working unchanged — real interface binding is
 * additive, never required. */
export interface KnxDiscoverySocket {
  on(event: "message", cb: (msg: Buffer, rinfo: { address: string }) => void): void;
  bind(cb: () => void, address?: string): void;
  setMulticast?(interfaceAddress?: string): void;
  send(msg: Buffer, port: number, host: string): void;
  close(): void;
}
export type KnxDiscoverySocketFactory = () => KnxDiscoverySocket;

/** A real, non-virtual IPv4 network adapter — a SEARCH_REQUEST candidate outgoing
 * interface. */
export interface KnxNetworkInterface {
  name: string;
  address: string;
}

/** Adapter-name patterns that are never a real LAN path to a KNX/IP gateway — Docker
 * bridges/veth pairs, WSL's vEthernet, Hyper-V's Default Switch, VMware/VirtualBox
 * host-only adapters, and common VPN/tunnel adapter names. Excluded by default, never
 * hidden from an installer who explicitly wants to pick one (§ "Ignore ... unless
 * explicitly selected" — {@link listKnxNetworkInterfaces}'s `includeVirtual` opts back
 * in to the unfiltered list, it never becomes impossible to choose). */
const VIRTUAL_ADAPTER_NAME_RE = /docker|veth|br-|vethernet|virtualbox|vboxnet|vmware|vmnet|hyper-v|wsl|tap|tun|zerotier|tailscale|ppp/i;

/** Enumerates real network adapters this host could reach a KNX/IP gateway's LAN
 * through — every non-internal IPv4 adapter, minus the virtual/container/VPN ones by
 * default (§ Gateway Discovery: "enumerate all active network adapters ... ignore
 * loopback/Docker/WSL/Hyper-V/VMware/Tailscale unless selected"). Never guesses which
 * one is "correct" — that choice is the installer's; this only removes adapters that
 * are never a real path to a physical KNX bus. */
export function listKnxNetworkInterfaces(opts: { includeVirtual?: boolean } = {}): KnxNetworkInterface[] {
  const out: KnxNetworkInterface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!opts.includeVirtual && VIRTUAL_ADAPTER_NAME_RE.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) out.push({ name, address: addr.address });
    }
  }
  return out;
}

/** Build a KNXnet/IP SEARCH_REQUEST. `localIp`/`localPort` tell servers where to reply. */
export function encodeSearchRequest(localIp = "0.0.0.0", localPort = 0): Buffer {
  const frame = Buffer.alloc(14);
  // KNXnet/IP header.
  frame.writeUInt8(HEADER_LEN, 0);
  frame.writeUInt8(PROTOCOL_V10, 1);
  frame.writeUInt16BE(SEARCH_REQUEST, 2);
  frame.writeUInt16BE(14, 4);
  // Discovery-endpoint HPAI.
  frame.writeUInt8(0x08, 6);
  frame.writeUInt8(HPAI_IPV4_UDP, 7);
  for (const [i, octet] of localIp.split(".").map(Number).entries()) {
    frame.writeUInt8(Number.isFinite(octet) ? octet & 0xff : 0, 8 + i);
  }
  frame.writeUInt16BE(localPort & 0xffff, 12);
  return frame;
}

/** Parse a KNXnet/IP SEARCH_RESPONSE. Returns null if the frame isn't a valid response. */
export function parseSearchResponse(buf: Buffer, sourceAddress: string): KnxGateway | null {
  if (buf.length < 6 + 8 + 54) return null;
  if (buf.readUInt8(0) !== HEADER_LEN || buf.readUInt8(1) !== PROTOCOL_V10) return null;
  if (buf.readUInt16BE(2) !== SEARCH_RESPONSE) return null;

  // Control-endpoint HPAI at offset 6 (len, code, IP[4], port[2]).
  const hpai = 6;
  const ip = `${buf.readUInt8(hpai + 2)}.${buf.readUInt8(hpai + 3)}.${buf.readUInt8(hpai + 4)}.${buf.readUInt8(hpai + 5)}`;
  const port = buf.readUInt16BE(hpai + 6);
  const address = ip === "0.0.0.0" ? sourceAddress : ip;

  // Device Information DIB at offset 14 (len, type, medium, status, IA[2], projId[2], serial[6],
  // multicast[4], mac[6], name[30]).
  const dib = 14;
  if (buf.readUInt8(dib + 1) !== DIB_DEVICE_INFO) return null;
  const individualAddress = formatIndividualAddress(buf.readUInt16BE(dib + 4));
  const multicastAddress = `${buf.readUInt8(dib + 18)}.${buf.readUInt8(dib + 19)}.${buf.readUInt8(dib + 20)}.${buf.readUInt8(dib + 21)}`;
  const mac = Array.from({ length: 6 }, (_, i) => buf.readUInt8(dib + 22 + i).toString(16).padStart(2, "0")).join(":");
  const name = buf.subarray(dib + 28, dib + 28 + 30).toString("latin1").replace(/\0.*$/, "").trim();

  // SUPP_SVC_FAMILIES DIB (optional, immediately follows the 54-byte Device Info DIB) —
  // pairs of (service_family_id, version) bytes. Family IDs are the stable, widely-used
  // KNXnet/IP Core values (the same ones calimero/xknx/knxd parse): CORE=0x02,
  // DEVICE_MANAGEMENT=0x03, TUNNELLING=0x04, ROUTING=0x05, REMOTE_LOGGING=0x06,
  // REMOTE_CONFIG_DIAGNOSIS=0x07, OBJECT_SERVER=0x08.
  const svcDibOffset = dib + 54;
  let tunnellingCapable: boolean | null = null;
  let routingCapable: boolean | null = null;
  if (buf.length >= svcDibOffset + 2) {
    const svcLen = buf.readUInt8(svcDibOffset);
    const svcType = buf.readUInt8(svcDibOffset + 1);
    if (svcType === 0x02 && svcLen >= 2 && buf.length >= svcDibOffset + svcLen) {
      tunnellingCapable = false;
      routingCapable = false;
      for (let i = svcDibOffset + 2; i + 1 < svcDibOffset + svcLen; i += 2) {
        const familyId = buf.readUInt8(i);
        if (familyId === 0x04) tunnellingCapable = true;
        if (familyId === 0x05) routingCapable = true;
      }
    }
  }

  return {
    address,
    port: port || KNX_PORT,
    individualAddress,
    name: name || `KNX ${individualAddress}`,
    multicastAddress,
    macAddress: mac,
    tunnellingCapable,
    routingCapable,
  };
}

export interface KnxSearchOptions {
  timeoutMs?: number;
  localIp?: string;
  localPort?: number;
  createSocket?: KnxDiscoverySocketFactory;
  /** The local NIC to bind the discovery socket to and send the multicast SEARCH_REQUEST
   * through — an address from {@link listKnxNetworkInterfaces}. Omitted means "let the OS
   * default route decide" (the pre-existing behavior), which is exactly what silently
   * fails on a multi-homed host whose default route doesn't reach the KNX gateway's LAN
   * segment (§ production defect: "No KNX/IP gateways found on this network" with a real
   * gateway present, on a host with Docker/other virtual adapters also installed). */
  interfaceAddress?: string;
}

/** Multicast a SEARCH_REQUEST and collect KNXnet/IP interfaces until the timeout. Deduped by IA. */
export function knxSearch(opts: KnxSearchOptions = {}): Promise<KnxGateway[]> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const socket = (opts.createSocket ?? defaultSocket)();
  const found = new Map<string, KnxGateway>();
  const request = encodeSearchRequest(opts.localIp ?? opts.interfaceAddress, opts.localPort);

  return new Promise<KnxGateway[]>((resolve) => {
    let done = false;
    const finish = (): void => {
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
      const gw = parseSearchResponse(msg, rinfo.address);
      if (gw) found.set(`${gw.individualAddress}|${gw.address}`, gw);
    });
    socket.bind(() => {
      socket.setMulticast?.(opts.interfaceAddress);
      socket.send(request, KNX_PORT, KNX_MULTICAST);
    }, opts.interfaceAddress);
    const t = setTimeout(finish, timeoutMs);
    (t as { unref?: () => void }).unref?.();
  });
}

/** KNX individual (physical) address: area(4b).line(4b).device(8b). */
export function formatIndividualAddress(raw: number): string {
  return `${(raw >> 12) & 0x0f}.${(raw >> 8) & 0x0f}.${raw & 0xff}`;
}

function defaultSocket(): KnxDiscoverySocket {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  return {
    on: (event, cb) => sock.on(event, cb),
    // No address → 0.0.0.0 (every interface), exactly the prior behavior. An explicit
    // address binds to that one NIC only, so the SEARCH_REQUEST actually leaves through
    // it rather than whatever the OS's default route happens to pick.
    bind: (cb, address) => (address ? sock.bind(0, address, cb) : sock.bind(cb)),
    setMulticast: (interfaceAddress) => {
      try {
        sock.setMulticastTTL(64);
        // A membership/outgoing-interface hint is required on a multi-homed host —
        // without it, the OS chooses which NIC actually carries the multicast join AND
        // the outgoing SEARCH_REQUEST, independently of which address the socket bound
        // to, which is exactly what let a real gateway go undiscovered.
        if (interfaceAddress) sock.setMulticastInterface(interfaceAddress);
        sock.addMembership(KNX_MULTICAST, interfaceAddress);
      } catch {
        // membership best-effort; unicast replies still arrive on the bound port
      }
    },
    send: (msg, port, host) => sock.send(msg, port, host),
    close: () => sock.close(),
  };
}
