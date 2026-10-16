/**
 * Real UDP implementation of {@link SocketFactory} on `node:dgram` (§ Clean-room KNX
 * stack — transport). The only file in the native stack that opens a socket.
 */
import { createSocket } from "node:dgram";
import type { KnxDatagramSocket, SocketFactory } from "./transport.js";

export interface UdpSocketOptions {
  /** Bind to this local interface address (multi-homed hosts); default = OS choice. */
  localAddress?: string;
}

export function createUdpSocketFactory(opts: UdpSocketOptions = {}): SocketFactory {
  return (handlers) =>
    new Promise<KnxDatagramSocket>((resolve, reject) => {
      const sock = createSocket({ type: "udp4", reuseAddr: false });
      let closed = false;
      let bound = false;
      const onBindError = (err: Error): void => {
        if (bound) return;
        sock.close();
        reject(err);
      };
      sock.once("error", onBindError);
      sock.on("message", (msg, rinfo) => {
        if (!closed) handlers.onMessage(msg, { address: rinfo.address, port: rinfo.port });
      });
      sock.bind(0, opts.localAddress, () => {
        bound = true;
        sock.off("error", onBindError);
        sock.on("error", (err) => { if (!closed) handlers.onError(err); });
        resolve({
          localPort: sock.address().port,
          send(data, port, address) {
            if (closed) return;
            sock.send(data, port, address, (err) => { if (err && !closed) handlers.onError(err); });
          },
          close() {
            if (closed) return;
            closed = true;
            try { sock.close(); } catch { /* already closed */ }
          },
        });
      });
    });
}
