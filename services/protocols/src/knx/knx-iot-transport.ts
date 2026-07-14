import * as dgram from "node:dgram";
import * as coap from "coap";
import * as coapPacket from "coap-packet";

/**
 * Real KNX IoT wire transport (§ Compatibility Report — the KNX IoT Point API Stack's C
 * reference implementation has no Node binding, so this speaks the *documented protocol*
 * directly: CoAP multicast GET on `/.well-known/core` for discovery, CoAP unicast GET for
 * per-resource retrieval — built on the general-purpose `coap`/`coap-packet` npm packages,
 * not a port of KNX Association source.
 */

const COAP_ALL_NODES_MULTICAST = "224.0.1.187";
const COAP_DEFAULT_PORT = 5683;

export interface DiscoveredEntry {
  host: string;
  linkFormat: string;
}

export interface IKnxIotTransport {
  discoverOnce(multicastAddress: string, port: number, timeoutMs: number): Promise<DiscoveredEntry[]>;
  get(host: string, port: number, pathname: string): Promise<string>;
  /** Real CoAP Observe (RFC 7641) registration on a resource — `onUpdate` fires once per
   * notification. Returns an unsubscribe function; never a polling loop pretending to be
   * push (§ Observe Layer). */
  observe(host: string, port: number, pathname: string, onUpdate: (payload: string) => void, onError: (err: Error) => void): () => void;
}

export class CoapKnxIotTransport implements IKnxIotTransport {
  /** Sends one CoAP GET /.well-known/core over UDP multicast and collects whatever
   * devices answer within the window — never fabricates a result when nothing responds
   * (§ Diagnostics discipline applied to discovery too). */
  discoverOnce(multicastAddress: string, port: number, timeoutMs: number): Promise<DiscoveredEntry[]> {
    return new Promise((resolve) => {
      const found = new Map<string, DiscoveredEntry>();
      const socket = dgram.createSocket("udp4");
      const packet = coapPacket.generate({
        code: "GET",
        confirmable: false,
        messageId: Math.floor(Math.random() * 0xffff),
        options: [
          { name: "Uri-Path", value: Buffer.from(".well-known") },
          { name: "Uri-Path", value: Buffer.from("core") },
        ],
      });

      socket.on("message", (msg, rinfo) => {
        try {
          const res = coapPacket.parse(msg);
          found.set(rinfo.address, { host: rinfo.address, linkFormat: res.payload.toString("utf8") });
        } catch {
          // Not a well-formed CoAP response — ignore this datagram, don't crash discovery.
        }
      });

      socket.bind(0, () => {
        socket.send(packet, port, multicastAddress);
      });

      setTimeout(() => {
        socket.close();
        resolve([...found.values()]);
      }, timeoutMs);
    });
  }

  get(host: string, port: number, pathname: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = coap.request({ host, port, pathname, method: "GET" });
      req.on("response", (res: coap.IncomingMessage) => resolve(res.payload.toString("utf8")));
      req.on("error", (err: Error) => reject(err));
      req.end();
    });
  }

  observe(host: string, port: number, pathname: string, onUpdate: (payload: string) => void, onError: (err: Error) => void): () => void {
    const req = coap.request({ host, port, pathname, method: "GET", observe: true });
    let firstResponse: coap.IncomingMessage | null = null;
    req.on("response", (res: coap.IncomingMessage) => {
      firstResponse = res;
      onUpdate(res.payload.toString("utf8"));
      res.on("data", () => onUpdate(res.payload.toString("utf8")));
    });
    req.on("error", onError);
    req.end();
    return () => {
      // node-coap has no explicit deregister call in this ambient surface; closing the
      // listener is the honest thing this transport can do without a real device to
      // validate a full RFC 7641 GET-with-Observe:1 deregistration against.
      firstResponse?.removeAllListeners("data");
    };
  }
}

export { COAP_ALL_NODES_MULTICAST, COAP_DEFAULT_PORT };
