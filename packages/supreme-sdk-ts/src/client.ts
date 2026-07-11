import {
  ApiError,
  CurrentUser,
  DeviceList,
  HomeView,
  LoginResponse,
  SupremeError,
  TokenPair,
  type CatalogList,
  type CommandResponse,
  type CommissionRequest,
  type DiagnosticsReport,
  type DiscoveryList,
  type InstalledDriverList,
  type InstalledDriverResponse,
  type LicenseStatus,
  type MigrateDomainResponse,
  type MigrationStatus,
  type ProjectExport,
  type BindProtocolRequest,
  type ProtocolBindingList,
  type ProtocolBindingView,
  type CameraList,
  type CameraResponse,
  type CameraStreamResponse,
  type RegisterCameraRequest,
  type SetCameraStreamRequest,
  type RegisterPushTokenRequest,
  type PushTokenResponse,
  type SceneList,
  type FavoriteList,
  type NotificationList,
  type SecurityStateResponse,
  type EnergySummaryResponse,
  type SystemHealth,
  type SystemUpdate,
  type SessionList,
  type RevokeOthersResponse,
  type PendingDeviceList,
  type ApiTokenList,
  type CreateApiTokenResponse,
  type RestoreResponse,
  type BackupInspectionResponse,
  type BackupStatus,
  type BackupList,
  type BackupHistoryEntry,
  type BackupScheduleResponse,
} from "@supreme/contracts";
import type {
  CapabilityCommand,
  Device,
  DeviceId,
  DriverId,
  FavoriteRef,
  License,
  ProtocolKind,
  RoomId,
  UserId,
} from "@supreme/domain-model";

/** One HVAC schedule event (§ HVAC Detail Page "Schedule") — mirrors
 * @supreme/automations' ClimateScheduleEvent shape; not imported directly since the SDK
 * doesn't otherwise depend on that package (same minimal-contract pattern the backend
 * route itself uses — see services/gateway/src/routes/climate.ts). */
export interface ClimateScheduleEventInput {
  id?: string;
  deviceId: string;
  enabled?: boolean;
  recurrence: "once" | "daily" | "weekly";
  date?: string;
  weekdays?: number[];
  atMinutes: number;
  targetC: number;
  mode: "heat" | "cool" | "auto" | "fan_only";
  fanSpeed?: string;
  label?: string;
}
export interface ClimateScheduleEvent extends ClimateScheduleEventInput {
  id: string;
  enabled: boolean;
}
export interface ClimateScheduleResponse {
  events: ClimateScheduleEvent[];
  holidayDeviceIds: string[];
}

/**
 * Supreme TypeScript SDK (§6). Clients (web homeowner/installer) bind to this, not
 * to raw endpoints — and certainly never to HA. The SDK validates responses with
 * the shared contracts, so a backend contract drift is caught at the boundary.
 *
 * Token storage is injected so the SDK is environment-agnostic (browser, node).
 */
export interface TokenStore {
  get(): { accessToken: string; refreshToken: string } | null;
  set(tokens: { accessToken: string; refreshToken: string } | null): void;
}

export class MemoryTokenStore implements TokenStore {
  private tokens: { accessToken: string; refreshToken: string } | null = null;
  get() {
    return this.tokens;
  }
  set(tokens: { accessToken: string; refreshToken: string } | null) {
    this.tokens = tokens;
  }
}

export interface SupremeClientOptions {
  baseUrl: string;
  tokenStore?: TokenStore;
  fetchImpl?: typeof fetch;
  /**
   * Called when a request 401s and the refresh token itself is also rejected (expired/revoked, or
   * there was no session at all) — i.e. the session is genuinely over. Apps use this to drop back to
   * the login screen. NOT called for an ordinary access-token expiry, which is refreshed silently.
   */
  onSessionExpired?: () => void;
}

export class SupremeClient {
  private readonly baseUrl: string;
  private readonly tokens: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly onSessionExpired?: () => void;
  /** In-flight refresh, so concurrent 401s (several device cards commanding at once) share one
   * refresh call instead of each racing the refresh endpoint. */
  private refreshing: Promise<TokenPair> | null = null;

  constructor(opts: SupremeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.tokens = opts.tokenStore ?? new MemoryTokenStore();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onSessionExpired = opts.onSessionExpired;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────
  async login(email: string, password: string): Promise<LoginResponse> {
    const res = await this.request("POST", "/v1/auth/login", { email, password }, false);
    const parsed = LoginResponse.parse(res);
    if (parsed.status === "ok") {
      this.tokens.set({ accessToken: parsed.accessToken, refreshToken: parsed.refreshToken });
    }
    return parsed;
  }

  async refresh(): Promise<TokenPair> {
    // Concurrent 401s (e.g. several device commands in flight) share one in-flight refresh instead
    // of each racing the refresh endpoint and invalidating each other's rotated refresh token.
    if (this.refreshing) return this.refreshing;
    const current = this.tokens.get();
    if (!current) throw new SupremeError("unauthorized", "no refresh token");
    this.refreshing = (async () => {
      try {
        const res = await this.request("POST", "/v1/auth/refresh", { refreshToken: current.refreshToken }, false);
        const pair = TokenPair.parse(res);
        this.tokens.set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
        return pair;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  // ── Queries & commands ─────────────────────────────────────────────────────
  async me(): Promise<CurrentUser> {
    return CurrentUser.parse(await this.request("GET", "/v1/me"));
  }

  async home(): Promise<HomeView> {
    return HomeView.parse(await this.request("GET", "/v1/home"));
  }

  /** Create a room (owner/admin/installer). Location: building › floor › room › area. */
  async createRoom(input: { name: string; areaType?: string; building?: string | null; floor?: number; area?: string | null }): Promise<{ room: { id: string; name: string } }> {
    return this.request("POST", "/v1/rooms", input) as Promise<{ room: { id: string; name: string } }>;
  }

  /** Rename / restyle / relocate a room (building / floor / area). */
  async updateRoom(roomId: RoomId, patch: { name?: string; areaType?: string; building?: string | null; floor?: number; area?: string | null }): Promise<{ room: { id: string; name: string } }> {
    return this.request("PATCH", `/v1/rooms/${roomId}`, patch) as Promise<{ room: { id: string; name: string } }>;
  }

  /** Delete a room (owner/admin/installer). Devices left in it are unassigned, never deleted. */
  async deleteRoom(roomId: RoomId): Promise<void> {
    await this.request("DELETE", `/v1/rooms/${roomId}`);
  }

  /** Change the signed-in user's password (requires the current password). */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.request("POST", "/v1/me/password", { currentPassword, newPassword });
  }

  /** Change the signed-in user's email/username (re-auth with the current password). */
  async changeEmail(newEmail: string, currentPassword: string): Promise<{ user: { id: string; email: string } }> {
    return this.request("POST", "/v1/me/email", { newEmail, currentPassword }) as Promise<{ user: { id: string; email: string } }>;
  }

  /** Request (or resend) an email-verification token. Non-production returns the token for LAN use. */
  async requestEmailVerification(): Promise<{ sent: boolean; alreadyVerified: boolean; token?: string }> {
    return this.request("POST", "/v1/me/email/verify/request") as Promise<{ sent: boolean; alreadyVerified: boolean; token?: string }>;
  }
  /** Complete email verification with the token. */
  async verifyEmail(token: string): Promise<{ user: { id: string; email: string; emailVerified: boolean } }> {
    return this.request("POST", "/v1/auth/verify-email", { token }) as Promise<{ user: { id: string; email: string; emailVerified: boolean } }>;
  }

  /** Delete the signed-in user's own account (re-auth with the current password). */
  async deleteAccount(currentPassword: string): Promise<void> {
    await this.request("DELETE", "/v1/me", { currentPassword });
  }

  /** Delete another user by id (admin/owner). The master account is protected server-side. */
  async deleteUser(userId: UserId): Promise<void> {
    await this.request("DELETE", `/v1/users/${userId}`);
  }

  // ── Personal API tokens (§ Security Center) ──────────────────────────────────
  /** List the user's personal API tokens (metadata only). */
  async apiTokens(): Promise<ApiTokenList> {
    return this.request("GET", "/v1/me/api-tokens") as Promise<ApiTokenList>;
  }
  /** Create an API token — the plaintext `token` is returned ONCE. */
  async createApiToken(name: string): Promise<CreateApiTokenResponse> {
    return this.request("POST", "/v1/me/api-tokens", { name }) as Promise<CreateApiTokenResponse>;
  }
  /** Revoke an API token by id. */
  async revokeApiToken(id: string): Promise<void> {
    await this.request("DELETE", `/v1/me/api-tokens/${id}`);
  }

  // ── Passkeys / WebAuthn (§ Security Center) ──────────────────────────────────
  async passkeys(): Promise<{ passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[] }> {
    return this.request("GET", "/v1/me/passkeys") as Promise<{ passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[] }>;
  }
  beginPasskeyRegistration(): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/me/passkeys/register/begin") as Promise<Record<string, unknown>>;
  }
  finishPasskeyRegistration(input: { name?: string; clientDataJSON: string; attestationObject: string }): Promise<{ passkey: { id: string; name: string } }> {
    return this.request("POST", "/v1/me/passkeys/register/finish", input) as Promise<{ passkey: { id: string; name: string } }>;
  }
  async removePasskey(id: string): Promise<void> {
    await this.request("DELETE", `/v1/me/passkeys/${id}`);
  }
  beginPasskeyLogin(): Promise<{ challenge: string; rpId: string; timeout: number }> {
    return this.request("POST", "/v1/auth/passkey/begin") as Promise<{ challenge: string; rpId: string; timeout: number }>;
  }
  async finishPasskeyLogin(input: { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string }): Promise<LoginResponse> {
    const res = (await this.request("POST", "/v1/auth/passkey/finish", input)) as LoginResponse & { accessToken?: string; refreshToken?: string };
    if (res.status === "ok") this.tokens.set({ accessToken: res.accessToken!, refreshToken: res.refreshToken! });
    return res;
  }

  /** MFA recovery-code status: whether MFA is on + how many one-time codes remain. */
  async recoveryCodeStatus(): Promise<{ mfaEnabled: boolean; remaining: number }> {
    return this.request("GET", "/v1/me/mfa/recovery-codes") as Promise<{ mfaEnabled: boolean; remaining: number }>;
  }
  /** Generate a fresh set of MFA recovery codes (returned in plaintext ONCE; replaces any prior set). */
  async generateRecoveryCodes(): Promise<{ codes: string[]; remaining: number }> {
    return this.request("POST", "/v1/me/mfa/recovery-codes") as Promise<{ codes: string[]; remaining: number }>;
  }

  /** The signed-in user's login sessions (active + revoked), newest first — the Security Center. */
  async sessions(): Promise<SessionList> {
    return this.request("GET", "/v1/me/sessions") as Promise<SessionList>;
  }

  /** Remotely sign out one of your sessions (not the current one). */
  async revokeSession(sessionId: string): Promise<void> {
    await this.request("DELETE", `/v1/me/sessions/${sessionId}`);
  }

  /** Sign out everywhere except this device. Returns how many sessions were revoked. */
  async revokeOtherSessions(): Promise<RevokeOthersResponse> {
    return this.request("POST", "/v1/me/sessions/revoke-others") as Promise<RevokeOthersResponse>;
  }

  /** Real host telemetry (CPU / memory / temperature / storage / uptime) for the Installer Dashboard.
   * Optional fields (utilizationPct, storage, temperatureC) are absent when the platform can't measure them. */
  async systemHealth(): Promise<SystemHealth> {
    return this.request("GET", "/v1/system/health") as Promise<SystemHealth>;
  }

  /** Hub software-update status for the Update Center (checks the signed OTA channel if configured). */
  async systemUpdate(): Promise<SystemUpdate> {
    return this.request("GET", "/v1/system/update") as Promise<SystemUpdate>;
  }

  /**
   * Ask the hub to download & store a stock hero photo for a room (by its name) if it doesn't have
   * one yet. Idempotent and best-effort — returns `{ pinned }`. Clients call this fire-and-forget
   * the first time they render a room card with no hero.
   */
  async pinRoomHeroImage(roomId: RoomId, force = false): Promise<{ pinned: boolean; room?: unknown }> {
    return this.request("POST", `/v1/rooms/${roomId}/hero-image/auto${force ? "?force=1" : ""}`) as Promise<{
      pinned: boolean;
      room?: unknown;
    }>;
  }

  /** Replace a room's hero with an owner-provided live photo (base64 or a data: URL). */
  async uploadRoomHeroImage(
    roomId: RoomId,
    image: { dataBase64?: string; dataUrl?: string; contentType?: string },
  ): Promise<{ room: { id: string; heroImageUrl: string | null } }> {
    return this.request("PUT", `/v1/rooms/${roomId}/hero-image`, image) as Promise<{
      room: { id: string; heroImageUrl: string | null };
    }>;
  }

  /**
   * Resolve a room's `heroImageUrl` to a loadable `<img>` src. Absolute URLs pass through; a
   * hub-relative path (the hub stored the photo locally) is resolved against the base URL with the
   * access token as a query param (an `<img>` tag can't send an Authorization header).
   */
  heroImageSrc(heroImageUrl: string | null | undefined): string | null {
    if (!heroImageUrl) return null;
    if (/^https?:\/\//i.test(heroImageUrl)) return heroImageUrl;
    const token = this.tokens.get()?.accessToken;
    const sep = heroImageUrl.includes("?") ? "&" : "?";
    return `${this.baseUrl}${heroImageUrl}${token ? `${sep}access_token=${encodeURIComponent(token)}` : ""}`;
  }

  async devicesInRoom(roomId: RoomId): Promise<DeviceList> {
    return DeviceList.parse(await this.request("GET", `/v1/rooms/${roomId}/devices`));
  }

  /** The core control verb — tap a light, set a level, etc. */
  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<CommandResponse> {
    return this.request("POST", `/v1/devices/${deviceId}/command`, { command }) as Promise<CommandResponse>;
  }

  /** The home's full per-device HVAC schedule (§ HVAC Detail Page "Schedule") + which
   * devices currently have holiday mode active. */
  climateSchedule(): Promise<ClimateScheduleResponse> {
    return this.request("GET", "/v1/climate/schedule") as Promise<ClimateScheduleResponse>;
  }
  /** Replaces the home's full HVAC schedule event list + holiday-mode device set —
   * these events are executed by SupremeOS on the minute tick, never sent to the driver. */
  setClimateSchedule(input: { events: ClimateScheduleEventInput[]; holidayDeviceIds: string[] }): Promise<ClimateScheduleResponse> {
    return this.request("PUT", "/v1/climate/schedule", input) as Promise<ClimateScheduleResponse>;
  }

  /** Move a device to any room, rename it, and/or merge fields into its metadata bag
   * (e.g. an installer-entered HVAC brand/type) — owner/admin/installer only. */
  async updateDevice(deviceId: DeviceId, patch: { name?: string; roomId?: string; metadata?: Record<string, unknown> }): Promise<{ device: Device }> {
    return this.request("PATCH", `/v1/devices/${deviceId}`, patch) as Promise<{ device: Device }>;
  }

  /** Clone a device's configuration into a new device (§ Device Platform). */
  cloneDevice(deviceId: DeviceId): Promise<{ device: Device }> {
    return this.request("POST", `/v1/devices/${deviceId}/clone`) as Promise<{ device: Device }>;
  }
  /** Bulk-move a device selection to a room, or bulk-remove it. Returns how many were affected. */
  bulkDevices(input: { ids: string[]; action: "move" | "remove"; roomId?: string }): Promise<{ affected: number }> {
    return this.request("POST", "/v1/devices/bulk", input) as Promise<{ affected: number }>;
  }

  /** Delete a device (also drops its backend bindings). */
  async deleteDevice(deviceId: DeviceId): Promise<void> {
    await this.request("DELETE", `/v1/devices/${deviceId}`);
  }

  // ── Homeowner surface (§11) ──────────────────────────────────────────────────
  /** Flat, permission-filtered list of every device in the home. */
  async devices(): Promise<DeviceList> {
    return DeviceList.parse(await this.request("GET", "/v1/devices"));
  }
  scenes(): Promise<SceneList> {
    return this.request("GET", "/v1/scenes") as Promise<SceneList>;
  }
  /** Create a scene (e.g. a snapshot of the current device states). */
  createScene(input: { name: string; scope?: "room" | "home"; roomId?: string | null; icon?: string | null; steps: unknown[] }): Promise<{ scene: unknown }> {
    return this.request("POST", "/v1/scenes", input) as Promise<{ scene: unknown }>;
  }
  activateScene(id: string): Promise<void> {
    return this.request("POST", `/v1/scenes/${id}/activate`) as Promise<void>;
  }
  /** Update a scene's editable fields (e.g. rename, change icon). Reaches PATCH /v1/scenes/:id. */
  updateScene(id: string, patch: { name?: string; icon?: string | null }): Promise<{ scene: unknown }> {
    return this.request("PATCH", `/v1/scenes/${id}`, patch) as Promise<{ scene: unknown }>;
  }
  /** Remove a scene. Reaches DELETE /v1/scenes/:id. */
  deleteScene(id: string): Promise<void> {
    return this.request("DELETE", `/v1/scenes/${id}`) as Promise<void>;
  }
  favorites(): Promise<FavoriteList> {
    return this.request("GET", "/v1/favorites") as Promise<FavoriteList>;
  }
  setFavorite(ref: FavoriteRef, favorite: boolean): Promise<void> {
    return this.request("PUT", "/v1/favorites", { ref, favorite }) as Promise<void>;
  }
  notifications(): Promise<NotificationList> {
    return this.request("GET", "/v1/notifications") as Promise<NotificationList>;
  }
  markNotificationsRead(ids: string[]): Promise<void> {
    return this.request("POST", "/v1/notifications/read", { ids }) as Promise<void>;
  }
  securityState(): Promise<SecurityStateResponse> {
    return this.request("GET", "/v1/security") as Promise<SecurityStateResponse>;
  }
  arm(mode: "armed_home" | "armed_away" | "armed_night", pin?: string): Promise<SecurityStateResponse> {
    return this.request("POST", "/v1/security/arm", { mode, pin }) as Promise<SecurityStateResponse>;
  }
  disarm(pin?: string): Promise<SecurityStateResponse> {
    return this.request("POST", "/v1/security/disarm", { pin }) as Promise<SecurityStateResponse>;
  }
  energySummary(): Promise<EnergySummaryResponse> {
    return this.request("GET", "/v1/energy/summary") as Promise<EnergySummaryResponse>;
  }

  // ── Installer surface (§9, §14) ──────────────────────────────────────────────
  driversCatalog(): Promise<CatalogList> {
    return this.request("GET", "/v1/drivers/catalog") as Promise<CatalogList>;
  }
  installedDrivers(): Promise<InstalledDriverList> {
    return this.request("GET", "/v1/drivers") as Promise<InstalledDriverList>;
  }
  installDriver(key: string, version?: string): Promise<InstalledDriverResponse> {
    return this.request("POST", "/v1/drivers/install", { key, version }) as Promise<InstalledDriverResponse>;
  }
  setDriverEnabled(id: DriverId, enabled: boolean): Promise<InstalledDriverResponse> {
    return this.request("POST", `/v1/drivers/${id}/enabled`, { enabled }) as Promise<InstalledDriverResponse>;
  }
  uninstallDriver(id: DriverId): Promise<void> {
    return this.request("DELETE", `/v1/drivers/${id}`) as Promise<void>;
  }

  discover(protocol?: ProtocolKind): Promise<DiscoveryList> {
    return this.request("POST", "/v1/commissioning/discover", { protocol }) as Promise<DiscoveryList>;
  }

  // ── Device Approval (§ Device Approval) ──────────────────────────────────────
  /** Scan every technology and stage results into the pending-approval queue; returns the queue. */
  scanForApproval(protocol?: string): Promise<PendingDeviceList> {
    return this.request("POST", "/v1/commissioning/scan", protocol ? { protocol } : {}) as Promise<PendingDeviceList>;
  }
  pendingDevices(): Promise<PendingDeviceList> {
    return this.request("GET", "/v1/devices/pending") as Promise<PendingDeviceList>;
  }
  approvePendingDevice(id: string, input: { name?: string; roomId: string; capabilities?: string[] }): Promise<{ device: { id: string; name: string } }> {
    return this.request("POST", `/v1/devices/pending/${id}/approve`, input) as Promise<{ device: { id: string; name: string } }>;
  }
  async rejectPendingDevice(id: string): Promise<void> {
    await this.request("POST", `/v1/devices/pending/${id}/reject`);
  }
  async removePendingDevice(id: string): Promise<void> {
    await this.request("DELETE", `/v1/devices/pending/${id}`);
  }
  commission(input: CommissionRequest): Promise<{ device: { id: string; name: string } }> {
    return this.request("POST", "/v1/commissioning/commission", input) as Promise<{
      device: { id: string; name: string };
    }>;
  }
  /** Bind a commissioned device's capability to a real bus address (KNX/Modbus/MQTT). */
  bindProtocol(input: BindProtocolRequest): Promise<{ binding: ProtocolBindingView }> {
    return this.request("POST", "/v1/commissioning/bind", input) as Promise<{
      binding: ProtocolBindingView;
    }>;
  }
  protocolBindings(): Promise<ProtocolBindingList> {
    return this.request("GET", "/v1/commissioning/bindings") as Promise<ProtocolBindingList>;
  }

  // ── Cameras (§11.1) ──────────────────────────────────────────────────────────
  cameras(): Promise<CameraList> {
    return this.request("GET", "/v1/cameras") as Promise<CameraList>;
  }
  registerCamera(input: RegisterCameraRequest): Promise<CameraResponse> {
    return this.request("POST", "/v1/cameras", input) as Promise<CameraResponse>;
  }
  setCameraSource(id: string, input: SetCameraStreamRequest): Promise<CameraResponse> {
    return this.request("PUT", `/v1/cameras/${id}/source`, input) as Promise<CameraResponse>;
  }
  /** Resolve a camera's RTSP source into client-playable HLS/WebRTC streams. */
  cameraStream(id: string): Promise<CameraStreamResponse> {
    return this.request("GET", `/v1/cameras/${id}/stream`) as Promise<CameraStreamResponse>;
  }

  // ── Push notifications (§13) ─────────────────────────────────────────────────
  /** Register this device's push token so notifications reach it while backgrounded. */
  registerPushToken(input: RegisterPushTokenRequest): Promise<PushTokenResponse> {
    return this.request("POST", "/v1/push/tokens", input) as Promise<PushTokenResponse>;
  }
  unregisterPushToken(token: string): Promise<void> {
    return this.request("DELETE", `/v1/push/tokens/${encodeURIComponent(token)}`) as Promise<void>;
  }

  diagnostics(): Promise<DiagnosticsReport> {
    return this.request("GET", "/v1/diagnostics") as Promise<DiagnosticsReport>;
  }
  projectExport(): Promise<ProjectExport> {
    return this.request("GET", "/v1/project/export") as Promise<ProjectExport>;
  }

  backup(): Promise<{ meta: { id: string; rowCount: number }; document: string }> {
    return this.request("POST", "/v1/backup") as Promise<{ meta: { id: string; rowCount: number }; document: string }>;
  }
  restore(document: string): Promise<RestoreResponse> {
    return this.request("POST", "/v1/backup/restore", { document }) as Promise<RestoreResponse>;
  }
  /** Dry-run: verify + preview what a restore would write, without touching data (§ dry-run). */
  inspectRestore(document: string): Promise<BackupInspectionResponse> {
    return this.request("POST", "/v1/backup/restore", { document, dryRun: true }) as Promise<BackupInspectionResponse>;
  }
  /** Backup health indicator: last backup, next due, retention, last restore. */
  backupStatus(): Promise<BackupStatus> {
    return this.request("GET", "/v1/backup/status") as Promise<BackupStatus>;
  }
  /** Backup history (metadata only). */
  backupList(): Promise<BackupList> {
    return this.request("GET", "/v1/backup/list") as Promise<BackupList>;
  }
  /** Re-download a stored backup's document by id. */
  getBackup(id: string): Promise<{ meta: BackupHistoryEntry; document: string }> {
    return this.request("GET", `/v1/backup/${id}`) as Promise<{ meta: BackupHistoryEntry; document: string }>;
  }
  backupSchedule(): Promise<BackupScheduleResponse> {
    return this.request("GET", "/v1/backup/schedule") as Promise<BackupScheduleResponse>;
  }
  setBackupSchedule(input: { enabled?: boolean; everyHours?: number; retain?: number }): Promise<BackupScheduleResponse> {
    return this.request("PUT", "/v1/backup/schedule", input) as Promise<BackupScheduleResponse>;
  }

  licenseStatus(): Promise<LicenseStatus> {
    return this.request("GET", "/v1/license") as Promise<LicenseStatus>;
  }
  activateLicense(token: License): Promise<LicenseStatus> {
    return this.request("POST", "/v1/license/activate", { token }) as Promise<LicenseStatus>;
  }

  // ── Native migration (§16 Phase 4) ───────────────────────────────────────────
  migrationStatus(): Promise<MigrationStatus> {
    return this.request("GET", "/v1/migration") as Promise<MigrationStatus>;
  }
  migrateDomain(domain: string, engine: "ha" | "native"): Promise<MigrateDomainResponse> {
    return this.request("POST", `/v1/migration/${domain}`, { engine }) as Promise<MigrateDomainResponse>;
  }

  get accessToken(): string | null {
    return this.tokens.get()?.accessToken ?? null;
  }

  // ── transport ────────────────────────────────────────────────────────────────
  private async request(
    method: string,
    path: string,
    body?: unknown,
    auth = true,
    isRetry = false,
  ): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) {
      const token = this.tokens.get()?.accessToken;
      if (!token) throw new SupremeError("unauthorized", "not authenticated");
      headers.authorization = `Bearer ${token}`;
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = ApiError.safeParse(json);
      const parsed = err.success
        ? new SupremeError(err.data.code, err.data.message, err.data.details)
        : new SupremeError("internal", `request failed (${res.status})`);
      // The access token (15 min TTL) expired mid-session — refresh once (refresh tokens last 30
      // days) and retry, so a homeowner mid-way through controlling a light never has to notice or
      // re-login. A refresh-token request itself never retries (it's called with auth=false); if IT
      // 401s, the session is genuinely over.
      if (auth && res.status === 401 && !isRetry) {
        try {
          await this.refresh();
        } catch {
          this.tokens.set(null);
          this.onSessionExpired?.();
          throw parsed;
        }
        return this.request(method, path, body, auth, true);
      }
      throw parsed;
    }
    return json;
  }
}
