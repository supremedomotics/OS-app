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
import {
  generateControllerIdentity,
  hapPairSetup,
  hapPairSetupBegin,
  hapPairVerify,
  type HapExchange,
} from "./apple-tv-hap-pairing.js";
import {
  buildCryptoPairingMessage,
  buildDeviceInfoMessage,
  buildClientUpdatesConfigMessage,
  buildSendCommandMessage,
  buildSendHidEventMessage,
  extractCryptoPairingData,
  messageType,
  parseSetStateMessage,
  buildPlaybackQueueRequestMessage,
  parsePlaybackQueueArtwork,
  isPlaybackQueueResponse,
  MrpType,
  MrpTransportCommand,
  MrpPlaybackState,
  MRP_HID_KEYS,
  type MrpHidKey,
  type MrpSetState,
} from "./apple-tv-mrp-protobuf.js";
import { createMrpTcpTransport, type AppleTvMrpTransport } from "./apple-tv-mrp-transport.js";
import type { AppleTvCredentialStore } from "./apple-tv-credential-store.js";
import type { MediaArtwork } from "@supreme/integration-layer";

/** § Bug fix (live-reported) — `address.split(":")` with no port (e.g. a bare IP typed into
 * the manual-add form) silently produced `Number(undefined)` = `NaN`, which `net.Socket
 * .connect()` doesn't validate itself — it throws a raw, unhandled `RangeError
 * [ERR_SOCKET_BAD_PORT]` deep inside Node's own socket internals, surfacing to the installer
 * as an opaque "internal error" with no indication of what's actually wrong. One shared,
 * validating parse used everywhere an MRP address string is split, so every caller fails the
 * same clear, actionable way instead of crashing differently depending on where the bad
 * address entered the system. */
function parseMrpAddress(address: string): { host: string; port: number } {
  const [host, portStr] = address.split(":");
  const port = Number(portStr);
  if (!host || !portStr || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `apple-tv: "${address}" is not a valid "host:port" MRP address — the port is required and ` +
        `must be a real port number (1-65535), not a bare IP. This device's real MRP port isn't ` +
        `known unless it was found via broadcast discovery.`,
    );
  }
  return { host, port };
}
import { AppleTvPairingRequiredError, type AppleTvClient, type AppleTvConnect, type AppleTvNowPlaying } from "./apple-tv-driver.js";
import type { TvForegroundApp } from "./tv-sdk/tv-types.js";
import { connectAppleTvCompanion, type AppleTvCompanionAppClient } from "./apple-tv-companion-client.js";
import { discoverCompanionAddress } from "./apple-tv-companion-discovery.js";

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
  /** § Phase 3/3.1 — OPTIONAL Companion session, additive to the MRP connection. When
   * present, the returned client also gets `getApplications`/`launchApplication`/
   * `launchDeepLink` (real, Companion-backed — see `apple-tv-companion-client.ts`).
   * Absent, discovery finding nothing, or Companion pairing simply not existing yet:
   * those three methods are left OFF the client (never present-but-throwing) — MRP's
   * own connection is never blocked or torn down by a Companion failure. A Companion-
   * only disconnect (MRP stays healthy) is retried independently with its own bounded
   * exponential backoff — see `scheduleCompanionReconnect` below — never a reconnect
   * storm, never touching the MRP connection. */
  companion?: {
    credentialStore: AppleTvCredentialStore;
    /** Explicit/out-of-band Companion address — a testability fallback. When omitted,
     * the production path applies: real mDNS discovery (`_companion-link._tcp`,
     * verified against pyatv's `scan()`) against the same host as this MRP connection. */
    addressFor?: (deviceId: DeviceId) => string | null;
    /** Injectable mDNS browser for `discoverCompanionAddress` (tests). */
    mdns?: (serviceType: string) => Promise<import("./mdns.js").MdnsService[]>;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
  };
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
  const { host, port } = parseMrpAddress(address);
  const transport = (opts.transportFactory ?? createMrpTcpTransport)(host, port);
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

/** A pairing attempt whose transport connection is held open between "M1 sent, PIN now
 * showing on the TV" and "user typed the PIN" — see {@link beginAppleTvMrpPairing}. */
export interface AppleTvMrpPairingSession {
  /** Completes M3-M6 with the submitted PIN, persists the resulting credentials via this
   * session's `AppleTvCredentialStore`, and closes the transport either way (success or
   * failure) — a session is single-use; a wrong PIN means starting a new one. */
  submitPin(pin: string): Promise<void>;
  /** Releases the open transport without pairing — for an abandoned attempt (the user
   * navigates away, or a server-side timeout fires). Idempotent. */
  cancel(): void;
}

/**
 * Opens a real MRP transport and sends HAP pair-setup's M1 — which is what makes a real
 * Apple TV display its on-screen PIN — WITHOUT yet knowing the PIN, and returns a
 * session that can complete the handshake once the user has read and submitted it. This
 * is the split `pairAppleTvMrp` doesn't need (its PIN is supplied upfront, e.g. by a
 * test) but a real installer-driven HTTP flow does: the gateway route that starts
 * pairing can't block an HTTP response on a person reading their TV screen, so it holds
 * this session server-side (keyed by deviceId, with its own timeout) between the
 * "start" and "submit PIN" requests.
 */
export async function beginAppleTvMrpPairing(
  address: string,
  deviceId: DeviceId,
  opts: AppleTvMrpClientOptions,
): Promise<AppleTvMrpPairingSession> {
  const { host, port } = parseMrpAddress(address);
  const transport = (opts.transportFactory ?? createMrpTcpTransport)(host, port);
  await transport.connect();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    transport.disconnect();
  };
  try {
    transport.send(buildDeviceInfoMessage(hubDeviceInfo(opts.hubIdentifier, opts.hubName)));
    const identity = generateControllerIdentity(Buffer.from(`supremeos-${deviceId}`));
    const exchange = makeMrpHapExchange(transport, true);
    const pairSetup = await hapPairSetupBegin(identity, exchange);
    return {
      async submitPin(pin: string): Promise<void> {
        if (closed) throw new Error("appletv pairing session already closed");
        try {
          const result = await pairSetup.submitPin(pin);
          await opts.credentialStore.save(deviceId, result);
        } finally {
          close();
        }
      },
      cancel: close,
    };
  } catch (err) {
    close();
    throw err;
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

    const { host, port } = parseMrpAddress(address);
    const transport = (opts.transportFactory ?? createMrpTcpTransport)(host, port);
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
      // is handled above and is NOT treated as invalid credentials — only a rejected
      // verify is.
      await opts.credentialStore.clear(deviceId);
      throw new AppleTvPairingRequiredError(
        `Apple TV rejected stored credentials, re-pairing required: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const session = channel.deriveSession(MRP_SALT, MRP_WRITE_INFO, MRP_READ_INFO);
    transport.enableEncryption(session);
    transport.send(buildClientUpdatesConfigMessage({}));

    let latestState: MrpSetState = { playbackState: null, nowPlaying: null, displayName: null, currentApplication: null };
    const pendingArtworkWaiters = new Set<(payload: Buffer) => void>();
    transport.onMessage((payload) => {
      if (messageType(payload) === MrpType.SET_STATE_MESSAGE) {
        latestState = parseSetStateMessage(payload);
        for (const waiter of pendingArtworkWaiters) waiter(payload);
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
      async pressButton(button) {
        assertConnected();
        // Verified against pyatv's MRP `RemoteControl._KEY_LOOKUP`: up/down/left/right/
        // select/menu/home have real (usagePage, usage) HID codes. "back" has no entry
        // in that verified table — Apple TV's MRP HID surface doesn't expose a distinct
        // back code the way the D-pad/menu/home buttons have one, so this throws a
        // structured, descriptive error rather than silently mapping it to "menu" (a
        // guess) or pretending it worked.
        if (!(button in MRP_HID_KEYS)) {
          throw new Error(`appletv(mrp): "${button}" has no verified MRP HID mapping (not implemented)`);
        }
        await sendHidKey(button as MrpHidKey);
      },
      async nowPlaying(): Promise<AppleTvNowPlaying> {
        const state = latestState;
        return {
          state: mapPlaybackState(state.playbackState),
          app: state.displayName,
          title: state.nowPlaying?.title ?? null,
          artist: state.nowPlaying?.artist ?? null,
          artworkUrl: null,
          durationSec: state.nowPlaying?.duration ?? null,
          positionSec: state.nowPlaying?.elapsedTime ?? null,
          // Never claimed: MRP's volume ownership was not wire-verified this phase.
          volume: null,
          muted: null,
          // § Artwork honesty limitation: ordinary now-playing push messages
          // (NowPlayingInfo) carry no artwork-availability flag we've wire-verified —
          // only an explicit PLAYBACK_QUEUE_REQUEST_MESSAGE round trip reveals that.
          // Rather than always requesting it (extra traffic every poll) or guessing,
          // `hasArtwork` reflects the outcome of the most recent real `getArtwork()`
          // call (starts `false`, converges to truth after the first fetch) — never
          // fabricated, just not instantly known on frame one.
          hasArtwork: lastArtworkAvailable,
        };
      },
      async getArtwork(): Promise<MediaArtwork | null> {
        assertConnected();
        transport.send(buildPlaybackQueueRequestMessage());
        const artwork = await waitForArtworkResponse(4_000);
        lastArtworkAvailable = artwork !== null;
        if (!artwork) return null;
        return {
          contentType: artwork.mimeType ?? "application/octet-stream",
          data: artwork.data,
          ...(artwork.width !== null ? { width: artwork.width } : {}),
          ...(artwork.height !== null ? { height: artwork.height } : {}),
        };
      },
      async getCurrentApplication(): Promise<TvForegroundApp | null> {
        const app = latestState.currentApplication;
        if (!app || (app.bundleIdentifier === null && app.displayName === null)) return null;
        return {
          packageName: app.bundleIdentifier,
          applicationName: app.displayName,
          source: "mrp-playerpath",
          // "exact": this is real, event-driven feedback straight from the Apple TV's
          // own playerPath.client, never inferred from a prior command.
          confidence: "exact",
          timestamp: new Date().toISOString(),
        };
      },
      async close() {
        companionClosed = true;
        if (companionReconnectTimer) clearTimeout(companionReconnectTimer);
        transport.disconnect();
        await companionClient?.close();
      },
    };

    // § Phase 3/3.1 — best-effort, additive Companion session for app discovery/
    // launch. A Companion failure (not configured, not paired, connect error) never
    // blocks or tears down the already-working MRP connection — it just means the
    // three Companion-only methods stay off this client, exactly like "no artwork" is
    // honest absence rather than a crash. A Companion-only disconnect is retried on its
    // OWN bounded exponential backoff, entirely independent of MRP's — reconnecting
    // Companion never touches the MRP transport/session, and an MRP reconnect (which
    // reruns this whole connect function fresh) naturally supersedes any pending
    // Companion retry for the old attempt.
    let companionClient: AppleTvCompanionAppClient | null = null;
    let companionReconnectAttempts = 0;
    let companionReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let companionClosed = false; // set by client.close() — stops further Companion retries

    async function connectCompanion(): Promise<void> {
      if (!opts.companion || companionClosed) return;
      const companionAddress =
        opts.companion.addressFor?.(deviceId) ?? (await discoverCompanionAddress(host!, opts.companion.mdns));
      if (!companionAddress) return; // not discoverable right now — no methods added, no crash
      try {
        const newClient = await connectAppleTvCompanion(companionAddress, deviceId, {
          credentialStore: opts.companion.credentialStore,
        });
        if (companionClosed) {
          // client.close() ran while this connect attempt was in flight — never
          // resurrect a Companion session (or leave its socket open) after intentional
          // shutdown; tear this one down immediately instead of wiring it up.
          await newClient.close();
          return;
        }
        companionClient = newClient;
        companionReconnectAttempts = 0;
        client.getApplications = () => newClient.getApplications();
        client.launchApplication = (bundleIdentifier: string) => newClient.launchApplication(bundleIdentifier);
        client.launchDeepLink = (urlOrScheme: string) => newClient.launchDeepLink(urlOrScheme);
        newClient.onClose(() => {
          // A stale close from an already-superseded Companion connection (e.g. this
          // very reconnect raced a newer one) must never schedule a duplicate retry or
          // clobber a client that's already moved on to a different companionClient.
          if (companionClient !== newClient || companionClosed) return;
          companionClient = null;
          delete client.getApplications;
          delete client.launchApplication;
          delete client.launchDeepLink;
          scheduleCompanionReconnect();
        });
      } catch {
        // Not paired yet, rejected, or unreachable — leave the three methods off the
        // client (they may already be off, or belonged to a prior attempt that never
        // got this far) and fall through to the bounded retry below.
        scheduleCompanionReconnect();
      }
    }

    function scheduleCompanionReconnect(): void {
      if (companionClosed || companionReconnectTimer) return;
      const base = opts.companion?.reconnectBaseMs ?? 1000;
      const max = opts.companion?.reconnectMaxMs ?? 60_000;
      const delay = Math.min(max, base * 2 ** companionReconnectAttempts);
      companionReconnectAttempts += 1;
      companionReconnectTimer = setTimeout(() => {
        companionReconnectTimer = null;
        void connectCompanion();
      }, delay);
      (companionReconnectTimer as { unref?: () => void }).unref?.();
    }

    await connectCompanion();

    let lastArtworkAvailable = false;

    /** Waits for the next SET_STATE_MESSAGE that actually decodes to artwork bytes,
     * bounded by `timeoutMs` — an unsolicited nowPlaying push with no playbackQueue data
     * is simply ignored, not mistaken for "no artwork" (MRP has no request/response
     * correlation id we've verified, so this is a best-effort filter, not a guarantee —
     * documented limitation, not a fabricated one). */
    function waitForArtworkResponse(timeoutMs: number): Promise<ReturnType<typeof parsePlaybackQueueArtwork>> {
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          pendingArtworkWaiters.delete(waiter);
          resolve(null);
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        const waiter = (payload: Buffer) => {
          // Only settle on a genuine playback-queue REPLY (even an empty/no-artwork
          // one) — an ordinary unsolicited now-playing push (nowPlayingInfo only, no
          // playbackQueue field) must not be mistaken for "no artwork", which would
          // otherwise report false negatives before the real reply even arrives.
          if (!isPlaybackQueueResponse(payload)) return;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingArtworkWaiters.delete(waiter);
          resolve(parsePlaybackQueueArtwork(payload));
        };
        pendingArtworkWaiters.add(waiter);
      });
    }

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
