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
} from "@supreme/domain-model";

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
}

export class SupremeClient {
  private readonly baseUrl: string;
  private readonly tokens: TokenStore;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SupremeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.tokens = opts.tokenStore ?? new MemoryTokenStore();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
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
    const current = this.tokens.get();
    if (!current) throw new SupremeError("unauthorized", "no refresh token");
    const res = await this.request("POST", "/v1/auth/refresh", { refreshToken: current.refreshToken }, false);
    const pair = TokenPair.parse(res);
    this.tokens.set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
    return pair;
  }

  // ── Queries & commands ─────────────────────────────────────────────────────
  async me(): Promise<CurrentUser> {
    return CurrentUser.parse(await this.request("GET", "/v1/me"));
  }

  async home(): Promise<HomeView> {
    return HomeView.parse(await this.request("GET", "/v1/home"));
  }

  async devicesInRoom(roomId: RoomId): Promise<DeviceList> {
    return DeviceList.parse(await this.request("GET", `/v1/rooms/${roomId}/devices`));
  }

  /** The core control verb — tap a light, set a level, etc. */
  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<CommandResponse> {
    return this.request("POST", `/v1/devices/${deviceId}/command`, { command }) as Promise<CommandResponse>;
  }

  /** Move a device to any room and/or rename it (owner/admin/installer). */
  async updateDevice(deviceId: DeviceId, patch: { name?: string; roomId?: string }): Promise<{ device: Device }> {
    return this.request("PATCH", `/v1/devices/${deviceId}`, patch) as Promise<{ device: Device }>;
  }

  /** Delete a device (also drops its backend bindings). */
  async deleteDevice(deviceId: DeviceId): Promise<void> {
    await this.request("DELETE", `/v1/devices/${deviceId}`);
  }

  // ── Homeowner surface (§11) ──────────────────────────────────────────────────
  scenes(): Promise<SceneList> {
    return this.request("GET", "/v1/scenes") as Promise<SceneList>;
  }
  activateScene(id: string): Promise<void> {
    return this.request("POST", `/v1/scenes/${id}/activate`) as Promise<void>;
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
  restore(document: string): Promise<{ tables: number; rows: number }> {
    return this.request("POST", "/v1/backup/restore", { document }) as Promise<{ tables: number; rows: number }>;
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
      if (err.success) throw new SupremeError(err.data.code, err.data.message, err.data.details);
      throw new SupremeError("internal", `request failed (${res.status})`);
    }
    return json;
  }
}
