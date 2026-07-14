/**
 * Minimal ambient types for `coap` and `coap-packet` (§ KnxIotProvider) — neither npm
 * package ships its own TypeScript definitions. This declares only the real, documented
 * surface this driver actually calls (verified against the packages' published READMEs),
 * not a fabricated API.
 */
declare module "coap-packet" {
  export interface CoapOption {
    name: string;
    value: Buffer;
  }
  export interface CoapPacket {
    code: string;
    messageId?: number;
    token?: Buffer;
    confirmable?: boolean;
    ack?: boolean;
    reset?: boolean;
    options?: CoapOption[];
    payload?: Buffer;
  }
  export function generate(packet: CoapPacket): Buffer;
  export function parse(buffer: Buffer): CoapPacket & { payload: Buffer };
}

declare module "coap" {
  import type { EventEmitter } from "node:events";

  export interface IncomingMessage extends EventEmitter {
    payload: Buffer;
    code: string;
  }
  export interface OutgoingMessage extends EventEmitter {
    end(payload?: string | Buffer): void;
  }
  export interface RequestParams {
    host: string;
    port?: number;
    pathname?: string;
    method?: "GET" | "POST" | "PUT" | "DELETE";
  }
  export function request(params: RequestParams): OutgoingMessage;
}
