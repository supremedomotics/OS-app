/**
 * Real MRP Apple TV client (§ Apple TV Phase 2B) — the concrete adapter the spec asks
 * for: `AppleTvProtocolDriver -> [this file] -> AppleTvMrpTransport -> Apple TV`. Wires
 * together, without duplicating any of them: the HAP pairing state machine
 * (`apple-tv-hap-pairing.ts`), the MRP protobuf wire codec (`apple-tv-mrp-protobuf.ts`),
 * the TCP transport (`apple-tv-mrp-transport.ts`), and per-device credential persistence
 * (`apple-tv-credential-store.ts`). This module owns socket/session/pairing-identity/
 * connection state for exactly ONE Apple TV — `AppleTvProtocolDriver` (Phase 1) already
 * guarantees one instance of this per binding, never shared.
 */
import type { DeviceId } from "@supreme/domain-model";
import { generateControllerIdentity, hapPairSetup, hapPairVerify, type HapExchange } from "./apple-tv-hap-pairing.js";
import {
  buildCryptoPairingMessage,
  buildDeviceInfoMessage,
  buildClientUpdatesConfigMessage,
  buildSendCommandMessage,
  buildSendHidEventMessage,
  extractCryptoPairingData,
  messageType,
  parseSetStateMessage,
  MrpType,
  MrpTransportCommand,
  MrpPlaybackState,
  MRP_HID_KEYS,
  type MrpHidKey,
  type MrpSetState,
} from "./apple-tv-mrp-protobuf.js";
import { createMrpTcpTransport, type AppleTvMrpTransport } from "./apple-tv-mrp-transport.js";
import type { AppleTvCredentialStore } from "./apple-tv-credential-store.js";
import { AppleTvPairingRequiredError, type AppleTvClient, type AppleTvConnect, type AppleTvNowPlaying } from "./apple-tv-driver.js";

/** MRP-specific post-pair-verify session key derivation strings — verified against
 * `pyatv/protocols/mrp/protocol.py`'s `SRP_SALT`/`SRP_OUTPUT_INFO`/`SRP_INPUT_INFO`. */
const MRP_SALT = "MediaRemote-Salt";
const MRP_WRITE_INFO = "MediaRemote-Write-Encryption-Key";
const MRP_READ_INFO = "MediaRemote-Read-Encryption-Key";

/** `messages.py`'s `device_information()` — protocol-constant fields verified verbatim;
 * `name`/`uniqueIdentifier` are this hub's own identity, not a per-Apple-TV value. */
function hubDeviceInfo(hubIdentifier: string, hubName: string) {
  return {
    uniqueIdentifier: hubIdentifier,
    name: hubName,
    systemBuildVersion: "1.0",
    applicationBundleIdentifier: "local.supreme.hub",
    protocolVersion: 1,
  };
}

/** Wraps a transport's send/receive into the `HapExchange` shape `apple-tv-hap-pairing.ts`
 * expects, by embedding each TLV8 blob inside a `CRYPTO_PAIRING_MESSAGE` (verified:
 * `messages.crypto_pairing()` — `state=2` ONLY on pair-setup's very first message,
 * `state=0` for every other pairing/verify message). Correlates request/response via a
 * single pending-reply resolver — valid because pairing/verify is strictly
 * request-then-response, never interleaved with other traffic. */
function makeMrpHapExchange(transport: AppleTvMrpTransport, firstMessageIsPairSetupStart: boolean): HapExchange {
  let first = firstMessageIsPairSetupStart;
  return async (outgoing: Buffer): Promise<Buffer> => {
    const state = first ? 2 : 0;
    first = false;
    const reply = waitForNextCryptoPairingReply(transport);
    transport.send(buildCryptoPairingMessage(outgoing, state));
    return decodeAndReturnTlv(await reply);
  };
}

function decodeAndReturnTlv(protocolMessage: Buffer): Buffer {
  return extractCryptoPairingData(protocolMessage);
}

function waitForNextCryptoPairingReply(transport: AppleTvMrpTransport): Promise<Buffer> {
  return new Promise((resolve) => {
    // `AppleTvMrpTransport.onMessage` only adds handlers (no removal) — that's fine here
    // because request/response pairing traffic never interleaves with other message
    // types on the same connection, so a one-shot filter is sufficient and leaves no
    // dangling behavior once the real client's own permanent dispatcher takes over.
    const handler = (payload: Buffer) => {
      if (messageType(payload) === MrpType.CRYPTO_PAIRING_MESSAGE) resolve(payload);
    };
    transport.onMessage(handler);
  });
}

export interface AppleTvMrpClientOptions {
  credentialStore: AppleTvCredentialStore;
  hubIdentifier: string;
  hubName: string;
  /** Injectable transport factory (tests use a deterministic fake MRP peer). */
  transportFactory?: (host: string, port: number) => AppleTvMrpTransport;
}

/**
 * Performs HAP pair-setup against a freshly-connected (plaintext) MRP transport and
 * persists the resulting credentials — the explicit, user-initiated pairing action
 * (§5 "User initiates pairing"), separate from ordinary `connect()`. `address` is
 * `"host:port"` (MRP's port is per-device/ephemeral, unlike AirPlay's fixed port — see
 * discovery's `raw.port`).
 */
export async function pairAppleTvMrp(
  address: string,
  deviceId: DeviceId,
  pin: string,
  opts: AppleTvMrpClientOptions,
): Promise<void> {
  const [host, portStr] = address.split(":");
  const port = Number(portStr);
  const transport = (opts.transportFactory ?? createMrpTcpTransport)(host!, port);
  await transport.connect();
  try {
    transport.send(buildDeviceInfoMessage(hubDeviceInfo(opts.hubIdentifier, opts.hubName)));
    const identity = generateControllerIdentity(Buffer.from(`supremeos-${deviceId}`));
    const exchange = makeMrpHapExchange(transport, true);
    const result = await hapPairSetup(pin, identity, exchange);
    await opts.credentialStore.save(deviceId, result);
  } finally {
    transport.disconnect();
  }
}

/** The real `AppleTvConnect` implementation — the production replacement for Phase 1's
 * stub `connect()` seam. Per binding: if no credentials are stored, throws
 * {@link AppleTvPairingRequiredError} immediately (never attempts a connection that can't
 * succeed). If credentials exist, opens a fresh transport, runs pair-verify, enables the
 * derived MRP session, exchanges DEVICE_INFO, and returns a live {@link AppleTvClient}. */
export function createMrpAppleTvConnect(opts: AppleTvMrpClientOptions): AppleTvConnect {
  return async ({ address, deviceId }) => {
    const saved = await opts.credentialStore.load(deviceId);
    if (!saved) throw new AppleTvPairingRequiredError();

    const [host, portStr] = address.split(":");
    const port = Number(portStr);
    const transport = (opts.transportFactory ?? createMrpTcpTransport)(host!, port);
    await transport.connect();

    let channel;
    try {
      transport.send(buildDeviceInfoMessage(hubDeviceInfo(opts.hubIdentifier, opts.hubName)));
      const exchange = makeMrpHapExchange(transport, false);
      channel = await hapPairVerify(saved, exchange);
    } catch (err) {
      transport.disconnect();
      // A rejected pair-verify against previously-saved credentials means they're no
      // longer valid (revoked on the Apple TV, e.g. "Forget This Accessory") — clear
      // them so the driver surfaces PAIRING_REQUIRED instead of retrying forever with
      // credentials that can never succeed. A bare connection failure (host unreachable)
      // throws before this catch (see transport.connect() above) and is NOT treated as
      // invalid credentials — only a rejected verify is.
      await opts.credentialStore.clear(deviceId);
      throw new AppleTvPairingRequiredError(
        `Apple TV rejected stored credentials, re-pairing required: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const session = channel.deriveSession(MRP_SALT, MRP_WRITE_INFO, MRP_READ_INFO);
    transport.enableEncryption(session);
    transport.send(buildClientUpdatesConfigMessage({}));

    let latestState: MrpSetState = { playbackState: null, nowPlaying: null, displayName: null };
    transport.onMessage((payload) => {
      if (messageType(payload) === MrpType.SET_STATE_MESSAGE) {
        latestState = parseSetStateMessage(payload);
      }
    });

    let closed = false;
    transport.onClose(() => {
      closed = true;
    });

    async function sendHidKey(key: MrpHidKey): Promise<void> {
      const [usagePage, usage] = MRP_HID_KEYS[key];
      transport.send(buildSendHidEventMessage(usagePage, usage, true));
      transport.send(buildSendHidEventMessage(usagePage, usage, false));
    }

    const client: AppleTvClient = {
      async play() {
        assertConnected();
        transport.send(buildSendCommandMessage(MrpTransportCommand.Play));
      },
      async pause() {
        assertConnected();
        transport.send(buildSendCommandMessage(MrpTransportCommand.Pause));
      },
      async stop() {
        assertConnected();
        transport.send(buildSendCommandMessage(MrpTransportCommand.Stop));
      },
      async next() {
        assertConnected();
        transport.send(buildSendCommandMessage(MrpTransportCommand.NextTrack));
      },
      async previous() {
        assertConnected();
        transport.send(buildSendCommandMessage(MrpTransportCommand.PreviousTrack));
      },
      async setVolume() {
        // § Volume honesty — MRP's SetStateMessage/CommandInfo surface here never
        // exposed a verified volume-set path this phase (GET_VOLUME/SET_VOLUME_MESSAGE
        // exist in the Type enum but were not wire-verified) — never silently no-op a
        // claimed capability; fail loudly instead of pretending it worked.
        throw new Error("appletv(mrp): setVolume is not implemented (not wire-verified this phase)");
      },
      async setMuted() {
        throw new Error("appletv(mrp): setMuted is not implemented (not wire-verified this phase)");
      },
      async nowPlaying(): Promise<AppleTvNowPlaying> {
        const state = latestState;
        return {
          state: mapPlaybackState(state.playbackState),
          app: state.displayName,
          title: state.nowPlaying?.title ?? null,
          artist: state.nowPlaying?.artist ?? null,
          artworkUrl: null,
          // Never claimed: MRP's volume ownership was not wire-verified this phase.
          volume: null,
          muted: null,
          hasArtwork: false,
        };
      },
      async close() {
        transport.disconnect();
      },
    };

    function assertConnected() {
      if (closed) throw new Error("appletv(mrp): connection closed");
    }

    return client;
  };
}

function mapPlaybackState(state: MrpPlaybackState | null): AppleTvNowPlaying["state"] {
  switch (state) {
    case MrpPlaybackState.Playing:
      return "playing";
    case MrpPlaybackState.Paused:
      return "paused";
    case MrpPlaybackState.Stopped:
    case MrpPlaybackState.Interrupted:
      return "stopped";
    default:
      return "idle";
  }
}
