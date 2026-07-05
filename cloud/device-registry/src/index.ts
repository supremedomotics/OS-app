import { uuidv7 } from "@supreme/hub-identity";

/**
 * @supreme/device-registry — the cloud Device Registry (blueprint §13).
 *
 * Every client (phone/tablet/panel/watch/web) that logs in is registered here: a stable
 * device UUID, a human name, platform/OS metadata, push token, and a trust state. This powers
 * the device-management surface (list, rename, delete, remote logout, approve new devices) and
 * the phone-replacement flow (register the new device, sync down, optionally revoke the old).
 *
 * Remote logout is delegated to AuthN via a session-revoker callback, so deleting/revoking a
 * device kills its tokens immediately (the registry holds device metadata, AuthN holds tokens).
 */

export type Platform = "ios" | "android" | "web" | "wearos" | "watchos" | "panel" | "macos";
export type Trust = "approved" | "pending" | "revoked";

export interface ClientDevice {
  id: string;
  accountId: string;
  name: string;
  platform: Platform;
  osVersion: string | null;
  model: string | null;
  pushToken: string | null;
  pushProvider: "apns" | "fcm" | "webpush" | null;
  trust: Trust;
  lastSeenAt: number | null;
  lastIp: string | null;
  lastGeo: string | null;
  createdAt: number;
  /** The active auth session id for this device (for remote logout). */
  sessionId: string | null;
}

export interface IDeviceStore {
  get(id: string): Promise<ClientDevice | undefined>;
  put(device: ClientDevice): Promise<void>;
  delete(id: string): Promise<void>;
  listForAccount(accountId: string): Promise<ClientDevice[]>;
}

export class InMemoryDeviceStore implements IDeviceStore {
  private devices = new Map<string, ClientDevice>();
  async get(id: string) {
    return this.devices.get(id);
  }
  async put(device: ClientDevice) {
    this.devices.set(device.id, device);
  }
  async delete(id: string) {
    this.devices.delete(id);
  }
  async listForAccount(accountId: string) {
    return [...this.devices.values()]
      .filter((d) => d.accountId === accountId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

export class DeviceError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden",
    message: string,
  ) {
    super(message);
  }
}

export interface DeviceRegistryOptions {
  store?: IDeviceStore;
  /** Revoke the device's auth session on delete/remote-logout (wires to AuthnService). */
  revokeSession?: (sessionId: string) => void | Promise<void>;
  /** Require explicit approval for a brand-new device on an account (default false). */
  approveNewDevices?: boolean;
  now?: () => number;
}

export interface RegisterInput {
  accountId: string;
  name: string;
  platform: Platform;
  osVersion?: string;
  model?: string;
  pushToken?: string;
  pushProvider?: "apns" | "fcm" | "webpush";
  ip?: string;
  geo?: string;
  sessionId?: string;
}

export class DeviceRegistry {
  private readonly store: IDeviceStore;
  private readonly revokeSession?: (sessionId: string) => void | Promise<void>;
  private readonly approveNewDevices: boolean;
  private readonly now: () => number;

  constructor(opts: DeviceRegistryOptions = {}) {
    this.store = opts.store ?? new InMemoryDeviceStore();
    this.revokeSession = opts.revokeSession;
    this.approveNewDevices = opts.approveNewDevices ?? false;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Register a device on first login. Trust is `pending` if approval is required. */
  async register(input: RegisterInput): Promise<ClientDevice> {
    const now = this.now();
    const isFirst = (await this.store.listForAccount(input.accountId)).length === 0;
    const device: ClientDevice = {
      id: uuidv7(now),
      accountId: input.accountId,
      name: input.name,
      platform: input.platform,
      osVersion: input.osVersion ?? null,
      model: input.model ?? null,
      pushToken: input.pushToken ?? null,
      pushProvider: input.pushProvider ?? null,
      // The first device on a new account is implicitly trusted (the account creator);
      // later devices require approval when the policy is on.
      trust: this.approveNewDevices && !isFirst ? "pending" : "approved",
      lastSeenAt: now,
      lastIp: input.ip ?? null,
      lastGeo: input.geo ?? null,
      createdAt: now,
      sessionId: input.sessionId ?? null,
    };
    await this.store.put(device);
    return device;
  }

  list(accountId: string): Promise<ClientDevice[]> {
    return this.store.listForAccount(accountId);
  }

  async rename(accountId: string, deviceId: string, name: string): Promise<ClientDevice> {
    const d = await this.require(accountId, deviceId);
    const updated = { ...d, name };
    await this.store.put(updated);
    return updated;
  }

  /** Bind the auth session created at login to the device (enables remote logout). */
  async attachSession(accountId: string, deviceId: string, sessionId: string): Promise<ClientDevice> {
    const d = await this.require(accountId, deviceId);
    const updated = { ...d, sessionId };
    await this.store.put(updated);
    return updated;
  }

  /** Approve a pending device (e.g. confirmed from an already-trusted device). */
  async approve(accountId: string, deviceId: string): Promise<ClientDevice> {
    const d = await this.require(accountId, deviceId);
    const updated = { ...d, trust: "approved" as const };
    await this.store.put(updated);
    return updated;
  }

  /** Record liveness + last-seen metadata (called on each authenticated request). */
  async touch(deviceId: string, meta: { ip?: string; geo?: string } = {}): Promise<void> {
    const d = await this.store.get(deviceId);
    if (!d) return;
    await this.store.put({ ...d, lastSeenAt: this.now(), lastIp: meta.ip ?? d.lastIp, lastGeo: meta.geo ?? d.lastGeo });
  }

  /** Remote logout: revoke the device's session without deleting its record. */
  async remoteLogout(accountId: string, deviceId: string): Promise<ClientDevice> {
    const d = await this.require(accountId, deviceId);
    const updated = { ...d, trust: "revoked" as const, sessionId: null };
    if (d.sessionId) await this.revokeSession?.(d.sessionId);
    await this.store.put(updated);
    return updated;
  }

  /** Delete a device entirely (also revokes its session). */
  async remove(accountId: string, deviceId: string): Promise<void> {
    const d = await this.require(accountId, deviceId);
    if (d.sessionId) await this.revokeSession?.(d.sessionId);
    await this.store.delete(deviceId);
  }

  private async require(accountId: string, deviceId: string): Promise<ClientDevice> {
    const d = await this.store.get(deviceId);
    if (!d) throw new DeviceError("not_found", "device not found");
    // An account may only manage its own devices.
    if (d.accountId !== accountId) throw new DeviceError("forbidden", "device belongs to another account");
    return d;
  }
}
