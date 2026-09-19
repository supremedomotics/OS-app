import * as tls from "node:tls";
import type { Duplex } from "node:stream";
import { TvAuthenticationError, TvConnectionError, TvPairingRequiredError, TvUnsupportedCommandError } from "../../tv-errors.js";
import type { TvDeviceConfig, TvRemoteKey, TvTransport, TvTransportEvent } from "../../tv-types.js";
import { FramedSocket } from "./framed-socket.js";
import { decodePoloMessage, encodeConfiguration, encodeOptions, encodePairingRequest, encodeSecret, STATUS_OK } from "./polo-messages.js";
import { decodeRemoteMessage, encodeRemoteConfigure, encodeRemoteKeyInject, encodeRemotePingResponse } from "./remote-messages.js";
import { REMOTE_KEY_CODES } from "./remote-key-codes.js";
import { derivePairingSecret, rsaPublicKeyParts, type RsaPublicKeyParts } from "./pairing-secret.js";

const DEFAULT_CONTROL_PORT = 6466;
const DEFAULT_PAIRING_PORT = 6467;
/** Protocol constant, not a display name. Source: tronikos/androidtvremote2 pairing.py
 * `async_start_pairing()` (`msg.pairing_request.service_name = "atvremote"`). Verified
 * 2026-09-12. */
const PAIRING_SERVICE_NAME = "atvremote";

export interface AndroidTvClientCertificate {
  /** PEM-encoded client certificate/private key used for this protocol's required
   * mutual-TLS — see this class's doc comment for why generating one is currently an
   * explicit, undelivered gap rather than a fabricated implementation. */
  certPem: string;
  keyPem: string;
}

export interface AndroidTvRemoteV2TransportConfig extends TvDeviceConfig {
  controlPort?: number;
  pairingPort?: number;
  /** Resolves the paired client certificate for this device, or rejects/returns null if
   * this device has never completed pairing — the transport surfaces that as
   * `TvPairingRequiredError` rather than attempting a doomed TLS handshake. */
  getClientCertificate: () => Promise<AndroidTvClientCertificate | null>;
  /** Injectable low-level connector — production wiring opens a real `tls.TLSSocket`;
   * tests inject an in-memory `Duplex` pair (§34 Test Doubles), matching this fleet's
   * convention of an injectable socket factory (see coolmaster-connection.ts). */
  createSocket?: (opts: { host: string; port: number; cert: string; key: string; rejectUnauthorized: boolean }) => Duplex;
}

/**
 * (§2/§7 Phase 2) Android TV / Google TV "Remote v2" control-channel transport —
 * implements the `TvTransport` contract Phase 1's `TvDeviceSession` expects, so the
 * session/queue/reconnect/state-cache/diagnostics machinery above it is entirely
 * unaware this is Android TV specifically (§3 "the session must not know about
 * protobuf, TLS details, ... protocol internals").
 *
 * ⚠ KNOWN, EXPLICIT GAP (per the "do not fabricate — expose the gap" instruction): this
 * protocol requires a client-presented, TLS mutual-auth X.509 certificate for BOTH
 * pairing and every subsequent control connection. Node's built-in `crypto` module can
 * generate an RSA key pair but cannot itself produce a self-signed X.509 certificate
 * (no ASN.1/DER certificate encoder in Node core) — that needs either a small hand-built
 * X.509 encoder or an approved new dependency, and this phase does not add one without
 * that being a deliberate decision. `getClientCertificate` is therefore an injected
 * dependency, not something this transport manufactures: production wiring supplies a
 * real generator once that decision is made; until then, a device with no certificate
 * on file correctly and honestly surfaces `PairingRequired` rather than pretending to
 * connect.
 */
export class AndroidTvRemoteV2Transport implements TvTransport {
  readonly kind = "android_tv_remote_v2";
  private controlSocket: FramedSocket | null = null;
  private rawSocket: Duplex | null = null;
  private connected = false;
  private listeners = new Set<(event: TvTransportEvent) => void>();
  private disposed = false;

  constructor(private readonly config: AndroidTvRemoteV2TransportConfig) {}

  async connect(): Promise<void> {
    const cert = await this.config.getClientCertificate();
    if (!cert) throw new TvPairingRequiredError(`android_tv_remote_v2: ${this.config.deviceId} has not completed pairing`);

    const port = this.config.controlPort ?? DEFAULT_CONTROL_PORT;
    const raw = this.openSocket(port, cert);
    this.rawSocket = raw;
    const framed = new FramedSocket(raw);
    this.controlSocket = framed;

    await new Promise<void>((resolve, reject) => {
      const onSecure = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(this.classifyConnectError(err));
      };
      const cleanup = () => {
        if (raw instanceof tls.TLSSocket) raw.off("secureConnect", onSecure);
        raw.off("error", onError);
      };
      if (raw instanceof tls.TLSSocket) raw.once("secureConnect", onSecure);
      // A plain `Duplex` (every test double) never emits "connect" — that's a
      // net.Socket-specific event — so waiting for one here hung forever. It's already
      // usable the instant it's constructed, so resolve on the next microtask instead;
      // `onError` is still registered first, so a same-tick socket error is not missed.
      else queueMicrotask(onSecure);
      raw.once("error", onError);
    });

    framed.onMessage((msg) => this.onControlMessage(msg));
    framed.onError((err) => this.emit({ type: "error", error: err }));
    raw.once("close", () => {
      this.connected = false;
      if (!this.disposed) this.emit({ type: "connection-lost", reason: "android_tv_remote_v2: control socket closed" });
    });

    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    this.controlSocket?.destroy();
    this.controlSocket = null;
    this.rawSocket = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendKey(key: TvRemoteKey): Promise<void> {
    const code = REMOTE_KEY_CODES[key];
    if (code === undefined) throw new TvUnsupportedCommandError(key, this.config.deviceId);
    if (!this.controlSocket || !this.connected) throw new TvConnectionError(`android_tv_remote_v2: ${this.config.deviceId} not connected`);
    this.controlSocket.send(encodeRemoteKeyInject(code));
  }

  onEvent(listener: (event: TvTransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.connected = false;
    this.controlSocket?.destroy();
    this.controlSocket = null;
    this.listeners.clear();
  }

  // ── Pairing (§4) — a separate, explicit flow the installer drives; NOT part of the
  // TvTransport contract itself, since pairing happens once, out-of-band, before this
  // transport is ever handed to a TvDeviceSession. ────────────────────────────────────

  /** Opens the pairing-port TLS session and runs the request/options/configuration
   * exchange, stopping right before the secret step — the installer must read the code
   * the TV displays and call `submitPairingCode()` next. Every step here uses field
   * numbers verified against the upstream `.proto` source; only the secret DERIVATION
   * (inside `submitPairingCode`) carries the "unverified" flag — see pairing-secret.ts. */
  async beginPairing(clientCert: AndroidTvClientCertificate): Promise<PairingSession> {
    const port = this.config.pairingPort ?? DEFAULT_PAIRING_PORT;
    const raw = this.openSocket(port, clientCert);
    const framed = new FramedSocket(raw);

    await new Promise<void>((resolve, reject) => {
      const onSecure = () => {
        raw.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => reject(this.classifyConnectError(err));
      if (raw instanceof tls.TLSSocket) raw.once("secureConnect", onSecure);
      else queueMicrotask(onSecure); // see connect()'s identical fallback for why
      raw.once("error", onError);
    });

    return new PairingSession(raw, framed, this.config.deviceId);
  }

  // ── internal ─────────────────────────────────────────────────────────────────

  private openSocket(port: number, cert: AndroidTvClientCertificate): Duplex {
    if (this.config.createSocket) {
      return this.config.createSocket({ host: this.config.host, port, cert: cert.certPem, key: cert.keyPem, rejectUnauthorized: false });
    }
    // Real device pairing/control both use a self-signed cert on the TV's side too —
    // there is no CA to validate against, so rejectUnauthorized is correctly false here
    // (mirrors the reference client's own documented behavior), not a security shortcut.
    return tls.connect({ host: this.config.host, port, cert: cert.certPem, key: cert.keyPem, rejectUnauthorized: false });
  }

  private classifyConnectError(err: Error): Error {
    if (/certificate|SSL|TLS/i.test(err.message)) return new TvAuthenticationError(`android_tv_remote_v2: ${err.message}`);
    return new TvConnectionError(`android_tv_remote_v2: ${err.message}`, err);
  }

  private onControlMessage(msg: Buffer): void {
    let decoded: ReturnType<typeof decodeRemoteMessage>;
    try {
      decoded = decodeRemoteMessage(msg);
    } catch (err) {
      this.emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }
    switch (decoded.type) {
      case "remote-configure": {
        // The TV configures first (§7 connection lifecycle) — echo its code1 back
        // unmodified (see encodeRemoteConfigure's doc comment) with our own device info.
        this.controlSocket?.send(
          encodeRemoteConfigure(decoded.code1 ?? 0, {
            model: "SupremeOS",
            vendor: "Supreme Domotics",
            packageName: "com.supremedomotics.supremeos",
            appVersion: "1.0.0",
          }),
        );
        this.controlSocket?.send(encodeRemotePingResponse(0)); // harmless if unsolicited; TVs also send explicit pings below
        return;
      }
      case "remote-ping-request": {
        this.controlSocket?.send(encodeRemotePingResponse(decoded.val1 ?? 0));
        return;
      }
      default:
        return; // fields this transport doesn't act on yet (set-active acks, etc.) — never fatal
    }
  }

  private emit(event: TvTransportEvent): void {
    for (const l of this.listeners) l(event);
  }
}

/** One in-progress pairing attempt. Deliberately not merged into
 * `AndroidTvRemoteV2Transport` itself: pairing is a one-time, installer-driven flow with
 * its own short-lived socket, distinct from the long-lived control connection a
 * `TvDeviceSession` manages — keeping them separate means a pairing failure can never be
 * confused with (or leak state into) the control-channel reconnect loop. */
export class PairingSession {
  private secretPromiseResolve: ((ok: boolean) => void) | null = null;

  constructor(private readonly raw: Duplex, private readonly framed: FramedSocket, private readonly deviceId: string) {}

  /** Runs PairingRequest -> Ack -> Options -> Configuration -> ConfigurationAck. Throws
   * `TvAuthenticationError` if the TV responds with a non-OK status at any step.
   * `service_name` is NOT a display value — it's a fixed protocol-level identifier.
   * Source: tronikos/androidtvremote2 pairing.py `async_start_pairing()`, which always
   * sends the literal `"atvremote"` regardless of the caller's own client name. Verified
   * 2026-09-12. */
  async negotiate(clientName = "SupremeOS"): Promise<void> {
    await this.roundTrip(encodePairingRequest(PAIRING_SERVICE_NAME, clientName), "pairing-request-ack");
    await this.roundTrip(encodeOptions(6), "options");
    await this.roundTrip(encodeConfiguration(6), "configuration-ack");
  }

  /** @param code The 6-hex-digit code the installer read off the TV screen.
   * ⚠ See pairing-secret.ts — the derivation this calls is unverified against primary
   * source. Returns false (never throws) for "code doesn't even hash-check locally" so
   * the installer can be told to re-enter it without a scary stack trace. */
  async submitPairingCode(clientKey: RsaPublicKeyParts, serverKey: RsaPublicKeyParts, code: string): Promise<boolean> {
    const { digest, codeMatchesDigest } = derivePairingSecret(clientKey, serverKey, code);
    if (!codeMatchesDigest) return false;
    const ack = await this.roundTrip(encodeSecret(digest), "secret-ack");
    return ack.status === STATUS_OK;
  }

  close(): void {
    this.framed.destroy();
  }

  private roundTrip(message: Buffer, expect: string): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const unsubMsg = this.framed.onMessage((raw) => {
        const decoded = decodePoloMessage(raw);
        if (decoded.status !== STATUS_OK) {
          unsubMsg();
          unsubErr();
          reject(new TvAuthenticationError(`android_tv_remote_v2: ${this.deviceId} pairing rejected (status ${decoded.status})`));
          return;
        }
        if (decoded.type !== expect && decoded.type !== "status-only") return; // wait for the expected reply
        unsubMsg();
        unsubErr();
        resolve({ status: decoded.status });
      });
      const unsubErr = this.framed.onError((err) => {
        unsubMsg();
        unsubErr();
        reject(new TvConnectionError(`android_tv_remote_v2: ${this.deviceId} pairing socket error`, err));
      });
      this.framed.send(message);
    });
  }
}
