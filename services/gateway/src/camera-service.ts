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

/**
 * Camera registry + streaming (§11.1). Cameras are view-only Supreme devices
 * (`supremeType: "camera"`, zero controllable capabilities) whose source URLs live in
 * `metadata` (`streamUrl` = RTSP source, `snapshotUrl` = JPEG). RTSP isn't browser-
 * playable, so {@link stream} resolves the source into client-playable HLS/WebRTC URLs
 * through the hub's {@link ICameraStreamGateway}. The gateway is the only component that
 * knows the stream engine exists.
 */
export class CameraService {
  constructor(
    private readonly home: HomeService,
    private readonly streamGateway: ICameraStreamGateway,
    private readonly homeId: HomeId,
  ) {}

  /** Register a view-only camera device with its source URLs. */
  async register(input: {
    name: string;
    roomId?: string | null;
    streamUrl?: string;
    snapshotUrl?: string;
  }): Promise<CameraView> {
    const device: Device = {
      id: newId("device") as DeviceId,
      homeId: this.homeId,
      roomId: (input.roomId ?? null) as RoomId | null,
      name: input.name,
      supremeType: "camera",
      manufacturer: null,
      model: null,
      driverId: null,
      status: "online",
      capabilities: [],
      state: {},
      metadata: {
        registeredAt: new Date().toISOString(),
        streamUrl: input.streamUrl ?? null,
        snapshotUrl: input.snapshotUrl ?? null,
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
    const source = camera.metadata.streamUrl as string | null | undefined;
    if (!source) throw new SupremeError("validation_failed", "camera has no stream source configured");
    if (!this.streamGateway.enabled) {
      // No transcoder on this hub — hand back the raw source so native players can use it.
      return [{ kind: "rtsp", url: source }];
    }
    return this.streamGateway.publish(id, source);
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
