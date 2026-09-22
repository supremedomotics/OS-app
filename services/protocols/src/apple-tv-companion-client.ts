/**
 * Real Companion client (§ Apple TV Phase 3). Companion is used for EXACTLY two
 * capabilities MRP cannot provide — verified by inspecting pyatv's real source this
 * phase: `Apps` (`app_list`/`launch_app`) is implemented ONLY by `CompanionApps`
 * (`pyatv/protocols/companion/__init__.py`); MRP has no application-list or app-launch
 * message at all. Everything else this driver already does (pairing, playback,
 * navigation, now-playing, artwork, current-app) stays on MRP — this module is
 * additive, never a replacement, and is used only for `getApplications`/
 * `launchApplication`/`launchDeepLink`.
 *
 * Reuses, without duplicating: the HAP pairing state machine (`apple-tv-hap-pairing.ts`
 * — same pair-setup/pair-verify math, wrapped in Companion's own OPACK+frame envelope
 * instead of MRP's protobuf one) and the OPACK codec (`apple-tv-opack.ts`). Owns its
 * own TCP transport (`apple-tv-companion-transport.ts`) and its own credentials — a
 * SEPARATE HAP pairing from MRP's (Companion is a different service on a different
 * port with its own pairing), stored under a different config key so the two never
 * collide.
 */
import { generateControllerIdentity, hapPairSetup, hapPairVerify, chacha20poly1305Seal, chacha20poly1305Open, type HapExchange } from "./apple-tv-hap-pairing.js";
import { decodeTlv8, encodeTlv8, HapTlvTag } from "./apple-tv-hap-tlv8.js";
import { opackPack, opackUnpack, type OpackValue } from "./apple-tv-opack.js";
import { createCompanionTcpTransport, CompanionFrameType, type AppleTvCompanionTransport, type CompanionSession } from "./apple-tv-companion-transport.js";
import type { AppleTvCredentialStore } from "./apple-tv-credential-store.js";
import type { TvAppRegistryEntry } from "./tv-sdk/tv-types.js";
import { AppleTvPairingRequiredError } from "./apple-tv-driver.js";
import type { DeviceId } from "@supreme/domain-model";

/** Verified: `pyatv/protocols/companion/protocol.py` — `SRP_SALT`/`SRP_OUTPUT_INFO`/
 * `SRP_INPUT_INFO` for Companion's post-verify session (DIFFERENT from MRP's). */
const COMPANION_SALT = "";
const COMPANION_WRITE_INFO = "ClientEncrypt-main";
const COMPANION_READ_INFO = "ServerEncrypt-main";

const PAIRING_DATA_KEY = "_pd";

export interface AppleTvCompanionClientOptions {
  credentialStore: AppleTvCredentialStore;
  transportFactory?: (host: string, port: number) => AppleTvCompanionTransport;
}

function makeCompanionHapExchange(
  transport: AppleTvCompanionTransport,
  startFrame: typeof CompanionFrameType.PS_Start | typeof CompanionFrameType.PV_Start,
  nextFrame: typeof CompanionFrameType.PS_Next | typeof CompanionFrameType.PV_Next,
  extra: Record<string, OpackValue>,
): HapExchange {
  let first = true;
  return async (outgoing: Buffer): Promise<Buffer> => {
    const frameType = first ? startFrame : nextFrame;
    const responseFrame = nextFrame; // verified: exchange_auth always correlates on *_Next, even for the *_Start response
    first = false;
    const payload = opackPack({ [PAIRING_DATA_KEY]: outgoing, ...(frameType === startFrame ? extra : {}) });
    const reply = waitForFrame(transport, responseFrame);
    transport.send(frameType, payload);
    const [decoded] = opackUnpack(await reply);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("appletv(companion): pairing response was not an OPACK dict");
    }
    const pairingData = (decoded as Record<string, OpackValue>)[PAIRING_DATA_KEY];
    if (!Buffer.isBuffer(pairingData)) throw new Error("appletv(companion): pairing response missing _pd");
    return pairingData;
  };
}

function waitForFrame(transport: AppleTvCompanionTransport, frameType: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const handler = (type: number, payload: Buffer) => {
      if (type === frameType) resolve(payload);
    };
    transport.onFrame(handler);
  });
}

/** Companion's own post-verify session: verified nonce scheme (plain 12-byte
 * little-endian counter, no zero-padding — pyatv's `Chacha20Cipher` with
 * `nonce_length=12`) AND verified AAD binding (the 4-byte frame header is authenticated
 * data on every encrypted frame — `apple-tv-companion-transport.ts` supplies it). */
function companionSession(writeKey: Buffer, readKey: Buffer): CompanionSession {
  let writeSeq = 0;
  let readSeq = 0;
  const nonce = (seq: number) => {
    const n = Buffer.alloc(12);
    n.writeUIntLE(seq, 0, 6); // safe for realistic per-connection message counts
    return n;
  };
  return {
    encrypt(plaintext, aad) {
      return chacha20poly1305Seal(writeKey, nonce(writeSeq++), aad, plaintext);
    },
    decrypt(sealed, aad) {
      return chacha20poly1305Open(readKey, nonce(readSeq++), aad, sealed);
    },
  };
}

/** Performs Companion pairing (separate from MRP pairing) and persists the resulting
 * credentials under their own config key. */
export async function pairAppleTvCompanion(
  address: string,
  deviceId: DeviceId,
  pin: string,
  opts: AppleTvCompanionClientOptions,
): Promise<void> {
  const [host, portStr] = address.split(":");
  const transport = (opts.transportFactory ?? createCompanionTcpTransport)(host!, Number(portStr));
  await transport.connect();
  try {
    const identity = generateControllerIdentity(Buffer.from(`supremeos-companion-${deviceId}`));
    const exchange = makeCompanionHapExchange(transport, CompanionFrameType.PS_Start, CompanionFrameType.PS_Next, { _pwTy: 1 });
    const result = await hapPairSetup(pin, identity, exchange);
    await opts.credentialStore.save(deviceId, result);
  } finally {
    transport.disconnect();
  }
}

export interface AppleTvCompanionAppClient {
  getApplications(): Promise<TvAppRegistryEntry[]>;
  launchApplication(bundleIdentifier: string): Promise<void>;
  launchDeepLink(urlOrScheme: string): Promise<void>;
  close(): Promise<void>;
}

/** Connects (pair-verify + session) using previously-paired Companion credentials.
 * Throws {@link AppleTvPairingRequiredError} if none are stored, mirroring the MRP
 * client's own connect() semantics exactly. */
export async function connectAppleTvCompanion(
  address: string,
  deviceId: DeviceId,
  opts: AppleTvCompanionClientOptions,
): Promise<AppleTvCompanionAppClient> {
  const saved = await opts.credentialStore.load(deviceId);
  if (!saved) throw new AppleTvPairingRequiredError("Apple TV Companion session requires pairing");

  const [host, portStr] = address.split(":");
  const transport = (opts.transportFactory ?? createCompanionTcpTransport)(host!, Number(portStr));
  await transport.connect();

  let channel;
  try {
    const exchange = makeCompanionHapExchange(transport, CompanionFrameType.PV_Start, CompanionFrameType.PV_Next, { _auTy: 4 });
    channel = await hapPairVerify(saved, exchange);
  } catch (err) {
    transport.disconnect();
    await opts.credentialStore.clear(deviceId);
    throw new AppleTvPairingRequiredError(
      `Apple TV Companion rejected stored credentials, re-pairing required: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { writeKey, readKey } = channel.deriveKeys(COMPANION_SALT, COMPANION_WRITE_INFO, COMPANION_READ_INFO);
  transport.enableEncryption(companionSession(writeKey, readKey));

  let xid = Math.floor(Math.random() * 0x10000);
  const pending = new Map<number, (value: Record<string, OpackValue>) => void>();
  transport.onFrame((frameType, payload) => {
    if (frameType !== CompanionFrameType.E_OPACK) return;
    let decoded: OpackValue;
    try {
      [decoded] = opackUnpack(payload);
    } catch {
      return; // malformed frame — never crash the client, just drop it
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return;
    const dict = decoded as Record<string, OpackValue>;
    const xidValue = dict._x;
    if (typeof xidValue !== "number") return;
    const resolver = pending.get(xidValue);
    if (resolver) {
      pending.delete(xidValue);
      resolver(dict);
    }
  });

  async function sendCommand(identifier: string, content: Record<string, OpackValue>): Promise<Record<string, OpackValue>> {
    const thisXid = xid++;
    const payload = { _i: identifier, _t: 2, _c: content, _x: thisXid };
    const reply = new Promise<Record<string, OpackValue>>((resolve) => pending.set(thisXid, resolve));
    transport.send(CompanionFrameType.E_OPACK, opackPack(payload));
    const result = await reply;
    if (typeof result._em === "string") throw new Error(`appletv(companion): command "${identifier}" failed: ${result._em}`);
    return result;
  }

  return {
    async getApplications(): Promise<TvAppRegistryEntry[]> {
      const resp = await sendCommand("FetchLaunchableApplicationsEvent", {});
      const content = resp._c;
      if (typeof content !== "object" || content === null || Array.isArray(content)) {
        throw new Error("appletv(companion): app list response missing _c content");
      }
      const now = new Date().toISOString();
      return Object.entries(content as Record<string, OpackValue>).map(([bundleId, name]) => ({
        packageName: bundleId,
        applicationName: typeof name === "string" ? name : null,
        versionName: null,
        versionCode: null,
        launchable: true, // FetchLaunchableApplicationsEvent's own name is the honesty signal here
        installed: true,
        lastSeen: now,
      }));
    },
    async launchApplication(bundleIdentifier: string): Promise<void> {
      await sendCommand("_launchApp", { _bundleID: bundleIdentifier });
    },
    async launchDeepLink(urlOrScheme: string): Promise<void> {
      await sendCommand("_launchApp", { _urlS: urlOrScheme });
    },
    async close(): Promise<void> {
      transport.disconnect();
    },
  };
}
