import { newId, type Device, type DeviceId, type HomeId, type RoomId } from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import type { CameraStream, ICameraStreamGateway } from "@supreme/cameras";
import type { HomeService } from "@supreme/home";

export interface CameraView {
  id: string;
  name: string;
  roomId: string | null;
  snapshotUrl: string | null;
  streamUrl: string | null;
}

/** § RTSP Camera Extension — resolves a commissioned camera's real, decrypted RTSP credentials
 * from its owning driver instance, by instance id, ONLY at the moment a stream is opened. Never
 * called for a camera with no `driverInstanceId` (e.g. one registered directly with a
 * credential-embedded URL through the pre-existing manual API). Returning `null` (instance gone,
 * uninstalled, or has no credentials) simply falls back to the camera's stored, credential-free
 * source — never a thrown error that would break an otherwise-working camera. */
export type CredentialResolver = (driverInstanceId: string) => Promise<{ username: string; password: string } | null>;

/**
 * Camera registry + streaming (§11.1). Cameras are view-only Supreme devices
 * (`supremeType: "camera"`, zero controllable capabilities) whose source URLs live in
 * `metadata` (`streamUrl` = RTSP source, `snapshotUrl` = JPEG). RTSP isn't browser-
 * playable, so {@link stream} resolves the source into client-playable HLS/WebRTC URLs
 * through the hub's {@link ICameraStreamGateway}. The gateway is the only component that
 * knows the stream engine exists.
 *
 * § RTSP Camera Extension — a camera commissioned through the RTSP Camera driver's
 * discovery/commissioning flow never has a password in `metadata` (§ STEP 11): its
 * `metadata.streamUrl` is credential-free and `metadata.driverInstanceId` points at the
 * encrypted, per-camera credential record the driver owns (`@supreme/drivers`' existing secret
 * store — see `services/protocols/src/rtsp/`). {@link stream} resolves the real, authenticated
 * source through the injected {@link CredentialResolver} ONLY at stream-open time, never
 * persisting the combined URL anywhere. A camera registered the pre-existing, direct way (a
 * credential-embedded `streamUrl`, no `driverInstanceId`) is entirely unaffected.
 */
export class CameraService {
  constructor(
    private readonly home: HomeService,
    private readonly streamGateway: ICameraStreamGateway,
    private readonly homeId: HomeId,
    private readonly opts: { resolveCredentials?: CredentialResolver } = {},
  ) {}

  /** Register a view-only camera device with its source URLs. `driverInstanceId`/`onvifEndpoint`
   * (§ RTSP Camera Extension) associate the camera with the driver instance owning its encrypted
   * credentials, when it was commissioned through the RTSP Camera driver rather than added
   * directly. */
  async register(input: {
    name: string;
    roomId?: string | null;
    streamUrl?: string;
    snapshotUrl?: string;
    driverInstanceId?: string | null;
    manufacturer?: string | null;
    model?: string | null;
  }): Promise<CameraView> {
    const device: Device = {
      id: newId("device") as DeviceId,
      homeId: this.homeId,
      roomId: (input.roomId ?? null) as RoomId | null,
      name: input.name,
      supremeType: "camera",
      manufacturer: input.manufacturer ?? null,
      model: input.model ?? null,
      driverId: (input.driverInstanceId ?? null) as unknown as Device["driverId"],
      status: "online",
      capabilities: [],
      state: {},
      metadata: {
        registeredAt: new Date().toISOString(),
        streamUrl: input.streamUrl ?? null,
        snapshotUrl: input.snapshotUrl ?? null,
        ...(input.driverInstanceId ? { driverInstanceId: input.driverInstanceId } : {}),
      },
    };
    await this.home.addDevice(device, {});
    return toView(device);
  }

  async list(): Promise<CameraView[]> {
    return (await this.home.listDevices()).filter((d) => d.supremeType === "camera").map(toView);
  }

  async get(id: DeviceId): Promise<CameraView | null> {
    const device = await this.home.getDevice(id);
    return device && device.supremeType === "camera" ? toView(device) : null;
  }

  /** Update a camera's source URLs. */
  async setSource(id: DeviceId, patch: { streamUrl?: string | null; snapshotUrl?: string | null }): Promise<CameraView> {
    await this.requireCamera(id);
    const meta: Record<string, unknown> = {};
    if (patch.streamUrl !== undefined) meta.streamUrl = patch.streamUrl;
    if (patch.snapshotUrl !== undefined) meta.snapshotUrl = patch.snapshotUrl;
    const device = await this.home.setDeviceMetadata(id, meta);
    return toView(device!);
  }

  /**
   * Resolve a camera's RTSP source into client-playable streams (HLS/WebRTC) through
   * the hub's stream engine. Returns the raw RTSP entry too (for installer/NVR tools).
   */
  async stream(id: DeviceId): Promise<CameraStream[]> {
    const camera = await this.requireCamera(id);
    let source = camera.metadata.streamUrl as string | null | undefined;
    if (!source) throw new SupremeError("validation_failed", "camera has no stream source configured");
    if (!this.streamGateway.enabled) {
      // No transcoder on this hub — hand back the raw, credential-free source. A driver-
      // commissioned camera's real credentials are NEVER placed on an API response (§ STEP 11) —
      // they exist only server-side, injected below just before `streamGateway.publish()`.
      return [{ kind: "rtsp", url: source }];
    }
    const driverInstanceId = camera.metadata.driverInstanceId as string | null | undefined;
    let authenticatedSource = source;
    if (driverInstanceId && this.opts.resolveCredentials) {
      const creds = await this.opts.resolveCredentials(driverInstanceId);
      if (creds) {
        try {
          const url = new URL(source);
          url.username = encodeURIComponent(creds.username);
          url.password = encodeURIComponent(creds.password);
          authenticatedSource = url.toString();
        } catch {
          // Malformed stored URL — fall through with the credential-free source rather than throw
          // (§ STEP 12 — one bad record never breaks the whole stream request).
        }
      }
    }
    return this.streamGateway.publish(id, authenticatedSource);
  }

  private async requireCamera(id: DeviceId): Promise<Device> {
    const device = await this.home.getDevice(id);
    if (!device || device.supremeType !== "camera") throw new SupremeError("not_found", "camera not found");
    return device;
  }
}

function toView(d: Device): CameraView {
  return {
    id: d.id,
    name: d.name,
    roomId: d.roomId,
    snapshotUrl: (d.metadata.snapshotUrl as string | null | undefined) ?? null,
    streamUrl: (d.metadata.streamUrl as string | null | undefined) ?? null,
  };
}
